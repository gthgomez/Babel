import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_ROOT } from '../cli/constants.js';
import type { AgentBenchmarkSurface, AgentBenchmarkTask } from './agentBenchmark.js';
import type { ParityToolResult } from './parityBenchmark.js';
import { isAuthoritativeVerifierCommand } from '../agent/completionGatePolicy.js';
import {
  ensureBabelCliDistReady,
  extractCriticReceiptFromCli,
  resolveBabelCliEntry,
  runBabelCli,
} from './liteTrustDemo.js';
import {
  buildPlaybookPrompt,
  selectPlaybookBySkills,
  type PlaybookDefinition,
} from './playbooks/playbookService.js';
import { buildSweFirstMoveCard } from '../agent/firstMoveCard.js';
import { renderFailureCard, renderSuccessCard } from '../agent/failureCard.js';
import type { FailureCardInput } from '../agent/failureCard.js';

export type { PlaybookDefinition } from './playbooks/playbookService.js';

export interface SwebenchInstanceRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  patch?: string;
  _babel_eval_dataset?: string;
}

export interface HarnessRunOptions {
  evidenceDir: string;
  provider: 'mock' | 'live';
  surface: AgentBenchmarkSurface;
  datasetPath?: string;
  tbRoot?: string;
  model?: 'deepseek-v4-pro' | 'deepseek-v4-flash';
}

export function resolveBenchmarkDeepSeekModel(
  task: AgentBenchmarkTask,
): 'deepseek-v4-pro' | 'deepseek-v4-flash' {
  // External harness tasks (SWE-bench, HUNK4J, Terminal-Bench) always need the
  // full pro model — flash can't handle real-world repo-scale debugging.
  if (task.source !== 'babel_parity' && task.source !== 'babel_governance') {
    return 'deepseek-v4-pro';
  }
  // Local parity/governance tasks: flash is sufficient for simple edits.
  if (task.tier === 'A_daily' && task.difficulty === 'easy') {
    return 'deepseek-v4-flash';
  }
  return 'deepseek-v4-pro';
}

export interface HarnessCellPayload {
  parityResult: ParityToolResult;
  input_tokens: number | null;
  output_tokens: number | null;
  notes: string[];
}

// ─── Task-Class Playbooks (shared service; also uses REPL path) ─────

function selectPlaybook(task: AgentBenchmarkTask): PlaybookDefinition | undefined {
  return selectPlaybookBySkills(task.skills ?? []);
}

/** Outer process kill budget for SWE agent cells (must exceed chat wall). */
const SWE_AGENT_TIMEOUT_MS = 20 * 60 * 1000;
const SWE_EVAL_TIMEOUT_MS = 45 * 60 * 1000;
const TB_AGENT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * SWE harness chat env. P0.3: do **not** default `BABEL_CHAT_MAX_WALL_MS` to 20 min —
 * that overrode `general_swe` (10 min). Only forward the env when the operator sets it.
 */
export function buildSweAgentChatEnv(
  providerEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const wall = env['BABEL_CHAT_MAX_WALL_MS']?.trim();
  return {
    ...providerEnv,
    // P-5: Phase-based tiered routing — Flash explores (3.1x cheaper input),
    // Pro mutates/verifies. Phase auto-switches after first write. Proven
    // 29% cost reduction on SWE-A01 (771K tok / $0.36 vs 1.1M / $0.50).
    BABEL_CHAT_INVESTIGATE_MODEL: 'deepseek-v4-flash',
    BABEL_CHAT_MUTATE_MODEL: 'deepseek-v4-pro',
    // Product class: general_swe wall is 600s unless BABEL_CHAT_MAX_WALL_MS is set.
    BABEL_CHAT_SWE_PROFILE: '1',
    BABEL_CHAT_TASK_CLASS: 'general_swe',
    // Headless for hardGate + auto-approve (accepts 1|true; set 1 for consistency).
    BABEL_HEADLESS: '1',
    BABEL_BENCHMARK_AUTO_APPROVE: '1',
    ...(wall ? { BABEL_CHAT_MAX_WALL_MS: wall } : {}),
    BABEL_CHAT_MAX_TURNS: env['BABEL_CHAT_MAX_TURNS'] ?? '250',
    // Keep stall nudges but prevent escalation within 8-turn window.
    // DeepSeek effective = 25 * 1.25 = 31 turns — unreachable with 8 maxTurns.
    BABEL_CHAT_STALL_TURNS: '25',
    // Idea 14: force asymmetric diff critic on SWE/HUNK external cells.
    BABEL_DIFF_CRITIC: '1',
    BABEL_DIFF_CRITIC_MODEL: env['BABEL_DIFF_CRITIC_MODEL'] ?? 'deepseek-v4-flash',
    BABEL_DIFF_CRITIC_SWE_TIER: '1',
    BABEL_DIFF_CRITIC_PRO_MODEL: env['BABEL_DIFF_CRITIC_PRO_MODEL'] ?? 'deepseek-v4-pro',
  };
}

/**
 * Prefer gold_diff on Windows: docker eval commonly fails with Linux-only
 * imports (`resource`). Skip docker loudly so stderr does not dominate notes.
 */
export function shouldSkipDockerEvalOnPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32';
}

/**
 * Real docker daemon probe. Do not couple this to platform eval-skip policy:
 * Windows still runs SWE agent cells with gold_diff when docker eval is skipped
 * via `shouldSkipDockerEvalOnPlatform`.
 */
export function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  return result.status === 0;
}

export function resolveTerminalBenchRoot(): string {
  const fromEnv = process.env['TERMINAL_BENCH_ROOT'];
  if (fromEnv && existsSync(resolve(fromEnv))) {
    return resolve(fromEnv);
  }
  const workspaceBenchmarks = join(dirname(BABEL_ROOT), 'benchmarks');
  if (existsSync(join(workspaceBenchmarks, 'scripts', 'run_babel_terminal_bench_pilot.mjs'))) {
    return workspaceBenchmarks;
  }
  return join(BABEL_ROOT, 'benchmarks');
}

export function resolveSwebenchForkPath(): string {
  const fromEnv = process.env['SWE_BENCH_FORK_PATH'];
  if (fromEnv && existsSync(resolve(fromEnv))) {
    return resolve(fromEnv);
  }
  return join(resolveTerminalBenchRoot(), 'SWE-bench-fork');
}

export function loadSwebenchInstance(
  datasetPath: string,
  instanceId: string,
): SwebenchInstanceRow | null {
  const text = readFileSync(datasetPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const row = JSON.parse(trimmed) as SwebenchInstanceRow;
    if (row.instance_id === instanceId) {
      return row;
    }
  }
  return null;
}

/** Extract FAIL_TO_PASS / PASS_TO_PASS test names when present on the instance. */
export function extractSweTestNames(instance: SwebenchInstanceRow): string[] {
  const row = instance as SwebenchInstanceRow & {
    FAIL_TO_PASS?: string | string[];
    PASS_TO_PASS?: string | string[];
    fail_to_pass?: string | string[];
  };
  const out: string[] = [];
  for (const key of ['FAIL_TO_PASS', 'fail_to_pass', 'PASS_TO_PASS'] as const) {
    const v = row[key as keyof typeof row];
    if (typeof v === 'string' && v.trim()) {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (Array.isArray(parsed)) {
          for (const t of parsed) if (typeof t === 'string') out.push(t);
        } else {
          out.push(v.trim());
        }
      } catch {
        out.push(v.trim());
      }
    } else if (Array.isArray(v)) {
      for (const t of v) if (typeof t === 'string') out.push(t);
    }
  }
  return [...new Set(out)].slice(0, 30);
}

/**
 * Prefer a targeted pytest command from issue/test names for local reproduce.
 */
export function buildTargetedPytestHint(testNames: string[]): string | null {
  if (testNames.length === 0) return null;
  const first = testNames[0]!;
  // Common forms: path::test_name or path.py
  const target = first.includes('::') ? first : first;
  const lines: string[] = [
    '```',
    `python -m pytest ${target} -q`,
    '```',
    '',
    '**NOTE**: Run the above command ONLY after applying your fix with str_replace.',
    '`python -c` is available for quick inline reproducer scripts.',
    'Mutate first, verify second — do NOT run pytest before patching.',
  ];
  return lines.join('\n');
}

/** Extract unique file paths from test names and build a prominent header block. */
export function buildTestFileHeader(testNames: string[]): string | null {
  if (testNames.length === 0) return null;
  const filePaths = [
    ...new Set(
      testNames
        .map((t) => {
          const idx = t.indexOf('::');
          return idx >= 0 ? t.slice(0, idx) : t;
        })
        .filter((p): p is string => p.length > 0),
    ),
  ].slice(0, 5);
  if (filePaths.length === 0) return null;
  const lines: string[] = [
    '## Test Files (from dataset — verify AFTER patching)',
    '',
  ];
  for (const fp of filePaths) {
    lines.push(`Test file: \`${fp}\``);
    lines.push(`Run with (only after applying fix): \`python -m pytest ${fp} -v -x\``);
    lines.push('');
  }
  lines.push(
    '**Important**: The test file path is known — do NOT search for test files.',
    'Do NOT run pytest before patching. Mutate first, verify second.',
  );
  return lines.join('\n');
}

export function buildSweIssuePrompt(
  instance: SwebenchInstanceRow,
  playbook?: PlaybookDefinition,
): string {
  const hints =
    typeof instance.hints_text === 'string' && instance.hints_text.trim().length > 0
      ? `\n\nHints:\n${instance.hints_text.trim()}`
      : '';

  const testNames = extractSweTestNames(instance);
  const testHint = buildTargetedPytestHint(testNames);
  const testBlock =
    testNames.length > 0
      ? [
          '',
          '## Issue tests (harness)',
          ...testNames.slice(0, 15).map((t) => `- ${t}`),
          testHint ?? '',
        ].join('\n')
      : testHint
        ? `\n\n${testHint}`
        : '';

  const testFileHeader = buildTestFileHeader(testNames);

  // Repo / file hints from instance metadata when present
  const repoHint = instance.repo ? `\nRepo: ${instance.repo}` : '';

  const sections: string[] = [];

  // ── Mutation-first directive (before playbook + card) ──────────────────
  // Ensures the model edits BEFORE searching for tests or running pytest.
  // Injected here (not via intentCompiler) because SWE tasks skip the
  // intent compiler (FAIL_TO_PASS detection).
  sections.push(
    '## CRITICAL: Mutate First, Verify Second',
    '',
    '1. **Read the buggy production code** — use grep/read_range to localize the issue',
    '2. **Apply ONE str_replace** — do NOT run pytest or search for test files before editing',
    '3. **Only THEN verify** — run the targeted test command to confirm your fix',
    '',
    'Do NOT grep for test names. Do NOT run pytest before patching.',
    'If the test environment is broken, apply the fix and report it — do NOT fix the environment.',
    '',
    '---',
    '',
  );

  // P-4: Task-class playbook guidance (replaces hardcoded steps)
  if (playbook) {
    const playbookContent = buildPlaybookPrompt(playbook);
    if (playbookContent) {
      sections.push(playbookContent);
    }
    // C2: Use first-move card for SWE tasks with known test names.
    // Replaces the separate testFileHeader + issue text + testBlock
    // with a single compact card that includes test paths, run commands,
    // symbol guidance, and "do not search for test files".
    if (testNames.length > 0) {
      const hintsClean =
        typeof instance.hints_text === 'string' && instance.hints_text.trim()
          ? instance.hints_text.trim()
          : undefined;
      const firstMove = buildSweFirstMoveCard({
        testNames,
        problemStatement: instance.problem_statement,
        repo: instance.repo,
        ...(hintsClean !== undefined ? { hintsText: hintsClean } : {}),
      });
      sections.push(firstMove.text);
    } else {
      if (testFileHeader) {
        sections.push(testFileHeader);
      }
      sections.push(
        'Fix the issue described below in this repository.',
        repoHint,
        '',
        instance.problem_statement.trim(),
        hints,
        testBlock,
      );
    }
  } else {
    // Backward-compatible: original hardcoded steps — mutate-first order
    sections.push(
      'Fix the issue described below in this repository.',
      repoHint,
      '',
      'Work through these steps in order:',
      '1. LOCALIZE: Use grep to find the relevant production source files from the issue.',
      '   Read those files with read_range to understand the bug.',
      '2. MUTATE: Apply ONE str_replace with the minimal fix. Do NOT run pytest first.',
      '3. VERIFY: Only after patching, run the targeted test with test_run.',
      '',
      'IMPORTANT: Mutate before verifying. Do not search for tests before editing.',
      'Use grep→read_range→str_replace. Do not just describe the fix — apply it.',
      '',
    );
    if (testFileHeader) {
      sections.push(testFileHeader);
    }
    sections.push(
      instance.problem_statement.trim(),
      hints,
      testBlock,
    );
  }

  return sections.join('\n').trim();
}

function deepSeekOnlyLiveEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env['DEEPINFRA_API_KEY'];
  env['BABEL_BENCHMARK_DEEPSEEK_ONLY'] = '1';
  env['BABEL_COMPACTION_MODEL'] = 'deepseek-v4-flash';
  return env;
}

function benchmarkBabelEnv(provider: 'mock' | 'live'): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    BABEL_ROOT,
    BABEL_HEADLESS: '1',
    BABEL_BENCHMARK_AUTO_APPROVE: '1',
    BABEL_ALLOW_INTERPRETER_EVAL: '1',
    ...(provider === 'live' ? { BABEL_LITE_OFFLINE: '0' } : {}),
  };
  return provider === 'live' ? deepSeekOnlyLiveEnv(base) : base;
}

function babelModeArgs(
  surface: AgentBenchmarkSurface,
  provider: 'mock' | 'live',
  model?: string,
): string[] {
  const liveModel =
    provider === 'live'
      ? (['--model', model ?? 'deepseek-v4-pro'] as const)
      : [];
  if (surface === 'chat') {
    // Pre-test lock: headless hardGate + mutation auto-approve for SWE cells.
    return ['run', '--mode', 'chat-headless', ...liveModel];
  }
  if (surface === 'plan') {
    return ['plan'];
  }
  return ['run', '--mode', 'deep', ...liveModel];
}

function extractChatUsage(payload: Record<string, unknown> | null): {
  cost_usd: number | null;
  token_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
} {
  if (!payload) {
    return { cost_usd: null, token_count: null, input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null };
  }
  const usage =
    payload['usage'] !== null && typeof payload['usage'] === 'object'
      ? (payload['usage'] as Record<string, unknown>)
      : null;
  if (!usage) {
    return { cost_usd: null, token_count: null, input_tokens: null, output_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null };
  }
  return {
    cost_usd: typeof usage['totalCostUSD'] === 'number' ? usage['totalCostUSD'] : null,
    token_count: typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : null,
    input_tokens: typeof usage['totalInputTokens'] === 'number' ? usage['totalInputTokens'] : null,
    output_tokens: typeof usage['totalOutputTokens'] === 'number' ? usage['totalOutputTokens'] : null,
    cache_hit_tokens: typeof usage['totalCacheHitTokens'] === 'number' ? usage['totalCacheHitTokens'] : null,
    cache_miss_tokens: typeof usage['totalCacheMissTokens'] === 'number' ? usage['totalCacheMissTokens'] : null,
  };
}

/**
 * True when the chat payload shows an **authoritative** local verifier that exited 0.
 * Used to distinguish false_complete (no honest local verification) from
 * incorrect_patch (local tests passed, external SWE gold/docker still fail).
 *
 * B2: receipts for agent-owned scripts (`_verify*.py`) do not count even at exit 0.
 */
export function hasLocalVerifierPass(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;
  const receipt = payload['verifier_receipt'];
  if (receipt !== null && typeof receipt === 'object') {
    const r = receipt as Record<string, unknown>;
    const exit = r['exit_code'];
    const command = typeof r['command'] === 'string' ? r['command'] : null;
    if (typeof exit === 'number' && exit === 0) {
      // Missing command (legacy payloads): treat as pass only if no negative signal.
      if (command == null || isAuthoritativeVerifierCommand(command)) return true;
    }
  }
  const verification = payload['verification'];
  if (verification !== null && typeof verification === 'object') {
    const v = verification as Record<string, unknown>;
    const command = typeof v['command'] === 'string' ? v['command'] : null;
    if (v['status'] === 'completed' && v['exit_code'] === 0) {
      if (command == null || isAuthoritativeVerifierCommand(command)) return true;
    }
  }
  return false;
}

/**
 * SWE false_complete rule (SWE-A09 class):
 * claimed complete AND external verifier fail AND (empty patch OR no local verifier pass).
 * Non-empty wrong patch + local verifier exit 0 is incorrect_patch, not false_complete.
 */
export function classifySweFalseComplete(input: {
  claimedComplete: boolean;
  verifierOk: boolean;
  patch: string;
  payload: Record<string, unknown> | null | undefined;
}): boolean {
  const hasNonEmptyPatch = input.patch.trim().length > 0;
  const localVerifierPass = hasLocalVerifierPass(input.payload);
  return input.claimedComplete && !input.verifierOk && (!hasNonEmptyPatch || !localVerifierPass);
}

/**
 * Agent-facing failure note shaping:
 * - incorrect_patch: local verifier pass + external gold fail
 * - false_complete: claimed done without local verify / empty patch
 * - budget_exceeded: wall/cost kill
 */
export function classifySweFailureNote(input: {
  claimedComplete: boolean;
  verifierOk: boolean;
  patch: string;
  payload: Record<string, unknown> | null | undefined;
  budgetExceeded?: boolean;
}): 'passed' | 'incorrect_patch' | 'false_complete' | 'budget_exceeded' | 'agent_failed' | 'verifier_failed' {
  if (input.budgetExceeded || payloadIsBudgetExceeded(input.payload)) {
    return 'budget_exceeded';
  }
  if (input.verifierOk) return 'passed';
  const hasNonEmptyPatch = input.patch.trim().length > 0;
  const localPass = hasLocalVerifierPass(input.payload);
  if (input.claimedComplete && hasNonEmptyPatch && localPass && !input.verifierOk) {
    return 'incorrect_patch';
  }
  if (classifySweFalseComplete(input)) return 'false_complete';
  if (hasNonEmptyPatch && !input.verifierOk) return 'verifier_failed';
  return 'agent_failed';
}

export function payloadIsBudgetExceeded(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload) return false;
  if (payload['budget_exceeded'] === true) return true;
  if (payload['status'] === 'BUDGET_EXCEEDED') return true;
  if (payload['failure_class_hint'] === 'budget_exceeded') return true;
  const answer = payload['answer'];
  if (typeof answer === 'string' && /\bBUDGET_EXCEEDED\b|Time budget exceeded/i.test(answer)) {
    return true;
  }
  if (answer !== null && typeof answer === 'object') {
    const a = answer as Record<string, unknown>;
    const text = `${a['answer'] ?? ''} ${a['summary'] ?? ''}`;
    if (/\bBUDGET_EXCEEDED\b|Time budget exceeded/i.test(text)) return true;
  }
  return false;
}

/** Aggregate KPI: empty_patch_rate among scored cells. */
export function computeEmptyPatchRate(
  cells: Array<{ notes?: string[] | string | null; patch_bytes?: number | null }>,
): number | null {
  if (cells.length === 0) return null;
  let empty = 0;
  for (const c of cells) {
    const notes = Array.isArray(c.notes)
      ? c.notes.join(' ')
      : typeof c.notes === 'string'
        ? c.notes
        : '';
    if (
      /\bempty_patch\b/i.test(notes) ||
      c.patch_bytes === 0 ||
      /\bpatch_bytes=0\b/.test(notes)
    ) {
      empty++;
    }
  }
  return empty / cells.length;
}

function checkoutSwebenchRepo(instance: SwebenchInstanceRow, repoRoot: string): void {
  if (existsSync(repoRoot)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  mkdirSync(dirname(repoRoot), { recursive: true });
  const url = `https://github.com/${instance.repo}.git`;
  let result = spawnSync('git', ['clone', '--filter=blob:none', url, repoRoot], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git clone failed for ${instance.repo}: ${result.stderr || result.stdout}`);
  }
  result = spawnSync('git', ['checkout', instance.base_commit], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `git checkout ${instance.base_commit} failed: ${result.stderr || result.stdout}`,
    );
  }
}

// ─── Semantic Gold-Diff Comparison ──────────────────────────────────────────
//
// These functions replace the old normalizePatchForComparison + exact-string
// approach with a semantic comparison that ignores:
//   - Git metadata lines (index, diff --git headers)
//   - Hunk header line numbers (@@ -a,b +c,d @@)
//   - Context lines (unchanged, space-prefixed)
//   - Trailing whitespace on any line
//   - Whitespace-only +/- lines (blank-line inserts/deletes)
//   - Pure whitespace-only hunks (e.g. gold PEP8 blank-line tidy)
//
// Two patches match when they modify the same files with the same substantive
// removed (-) and added (+) content lines. Hunk order within a file is ignored
// (multiset compare) so an extra whitespace-only gold hunk does not fail match.

export interface HunkChange {
  minusLines: string[];
  plusLines: string[];
}

export interface ParsedFileChange {
  filename: string;
  hunks: HunkChange[];
}

/**
 * True when a +/- change line has no non-whitespace body.
 * Covers blank-line inserts/deletes (`-` / `+` alone) that gold patches often
 * include for style while agents omit (SWE-A09 whitespace hunk).
 */
export function isWhitespaceOnlyChangeLine(line: string): boolean {
  if (!(line.startsWith('+') || line.startsWith('-'))) return false;
  // Drop the prefix and any remaining whitespace/empty body.
  return line.slice(1).trim().length === 0;
}

/** Drop whitespace-only +/- lines; return null when the hunk is empty after. */
export function normalizeHunkChange(hunk: HunkChange): HunkChange | null {
  const minusLines = hunk.minusLines.filter((l) => !isWhitespaceOnlyChangeLine(l));
  const plusLines = hunk.plusLines.filter((l) => !isWhitespaceOnlyChangeLine(l));
  if (minusLines.length === 0 && plusLines.length === 0) return null;
  return { minusLines, plusLines };
}

/** Normalize parsed files: strip whitespace-only lines/hunks/files. */
export function normalizeParsedFileChanges(files: ParsedFileChange[]): ParsedFileChange[] {
  const out: ParsedFileChange[] = [];
  for (const file of files) {
    const hunks: HunkChange[] = [];
    for (const hunk of file.hunks) {
      const normalized = normalizeHunkChange(hunk);
      if (normalized) hunks.push(normalized);
    }
    if (hunks.length > 0 && file.filename) {
      out.push({ filename: file.filename, hunks });
    }
  }
  return out;
}

function hunkSignature(hunk: HunkChange): string {
  // Stable signature for multiset compare (order-independent within a file).
  return JSON.stringify({
    m: hunk.minusLines,
    p: hunk.plusLines,
  });
}

function hunkMultisetsEqual(a: HunkChange[], b: HunkChange[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const h of a) {
    const key = hunkSignature(h);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const h of b) {
    const key = hunkSignature(h);
    const n = counts.get(key) ?? 0;
    if (n === 0) return false;
    if (n === 1) counts.delete(key);
    else counts.set(key, n - 1);
  }
  return counts.size === 0;
}

export function parsePatchToFileChanges(patch: string): ParsedFileChange[] {
  if (!patch.trim()) return [];

  const files: ParsedFileChange[] = [];
  const lines = patch.split('\n');

  let currentFile: ParsedFileChange | null = null;
  let currentHunk: HunkChange | null = null;
  let insideHunk = false;

  const flushHunk = (): void => {
    if (!currentHunk || !currentFile) {
      currentHunk = null;
      return;
    }
    // Keep raw parse here; whitespace normalization is applied at match time
    // so callers inspecting parse structure still see original +/- lines.
    if (currentHunk.minusLines.length > 0 || currentHunk.plusLines.length > 0) {
      currentFile.hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  const flushFile = (): void => {
    flushHunk();
    if (currentFile && currentFile.hunks.length > 0) {
      files.push(currentFile);
    }
    currentFile = null;
    insideHunk = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (line.startsWith('diff --git ')) {
      flushFile();
      currentFile = { filename: '', hunks: [] };
      insideHunk = false;
    } else if (line.startsWith('@@')) {
      flushHunk();
      currentHunk = { minusLines: [], plusLines: [] };
      insideHunk = true;
    } else if (line.startsWith('+++ b/')) {
      // Extract filename from the "to" file path (works for normal diffs and new files)
      if (currentFile) currentFile.filename = line.slice(6);
    } else if (!insideHunk && line.startsWith('--- a/')) {
      // For deleted files (+++ /dev/null), extract filename from the "from" path
      if (currentFile && !currentFile.filename) currentFile.filename = line.slice(6);
    } else if (!insideHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      // File path metadata lines outside hunks -- skip
    } else if (insideHunk && line.startsWith('-')) {
      if (currentHunk) currentHunk.minusLines.push(line);
    } else if (insideHunk && line.startsWith('+')) {
      if (currentHunk) currentHunk.plusLines.push(line);
    } else if (insideHunk && line.startsWith(' ')) {
      // Context line inside hunk -- skip
    }
    // Everything else (git metadata, empty lines, \ No newline) -- skip
  }

  flushFile();
  return files;
}

/**
 * Compare two git patches semantically, ignoring hunk header line numbers,
 * context lines, trailing whitespace, and whitespace-only blank-line hunks.
 * Substantive +/- lines per file must match as a multiset of hunks.
 */
export function patchesMatchSemantically(agentPatch: string, goldPatch: string): boolean {
  const agentFiles = normalizeParsedFileChanges(parsePatchToFileChanges(agentPatch));
  const goldFiles = normalizeParsedFileChanges(parsePatchToFileChanges(goldPatch));

  if (agentFiles.length !== goldFiles.length) return false;

  // Build a lookup map from gold files keyed by filename
  const goldByFile = new Map<string, ParsedFileChange>();
  for (const gf of goldFiles) {
    goldByFile.set(gf.filename, gf);
  }

  for (const af of agentFiles) {
    const gf = goldByFile.get(af.filename);
    if (!gf) return false;
    if (!hunkMultisetsEqual(af.hunks, gf.hunks)) return false;
  }

  return true;
}

function captureGitPatch(repoRoot: string): string {
  const unstaged = spawnSync('git', ['diff', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const staged = spawnSync('git', ['diff', '--cached'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return [unstaged.stdout ?? '', staged.stdout ?? ''].filter((part) => part.trim().length > 0).join('\n');
}

function swebenchEvalDatasetName(instance: SwebenchInstanceRow): string {
  if (instance._babel_eval_dataset === 'princeton-nlp/SWE-bench') {
    return 'SWE-bench';
  }
  return 'SWE-bench_Verified';
}

function runSwebenchDockerEval(input: {
  forkRoot: string;
  predictionsPath: string;
  instanceId: string;
  runId: string;
  datasetName: string;
}): { ok: boolean; stdout: string; stderr: string; resolved: boolean | null } {
  if (!existsSync(input.forkRoot)) {
    return {
      ok: false,
      stdout: '',
      stderr: `SWE-bench fork missing at ${input.forkRoot}`,
      resolved: null,
    };
  }
  const result = spawnSync(
    'python',
    [
      '-m',
      'swebench.harness.run_evaluation',
      '--dataset_name',
      input.datasetName,
      '--predictions_path',
      input.predictionsPath,
      '--max_workers',
      '1',
      '--instance_ids',
      input.instanceId,
      '--run_id',
      input.runId,
    ],
    {
      cwd: input.forkRoot,
      encoding: 'utf8',
      timeout: SWE_EVAL_TIMEOUT_MS,
      env: process.env,
      windowsHide: true,
    },
  );
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const resolved =
    /resolved[:\s]+1\b/i.test(combined) ||
    /1\s*\/\s*1\s*resolved/i.test(combined) ||
    (result.status === 0 && /"resolved":\s*1/.test(combined));
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    resolved: result.status === 0 ? resolved : false,
  };
}

function findTerminalBenchTrialResult(jobDir: string, taskSlug: string): string | null {
  if (!existsSync(jobDir)) {
    return null;
  }
  const direct = join(jobDir, `01-${taskSlug}`, 'result.json');
  if (existsSync(direct)) {
    return direct;
  }
  for (const entry of readdirSync(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(`-${taskSlug}`)) {
      continue;
    }
    const candidate = join(jobDir, entry.name, 'result.json');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function runSwebenchAgentCell(
  task: AgentBenchmarkTask,
  options: HarnessRunOptions,
): Promise<HarnessCellPayload> {
  if (task.verifier.kind !== 'swebench') {
    throw new Error(`Task ${task.task_id} is not a SWE-bench verifier task.`);
  }
  const datasetPath = options.datasetPath;
  if (!datasetPath || !existsSync(datasetPath)) {
    throw new Error(`SWE-bench dataset missing for ${task.task_id}.`);
  }

  const instance = loadSwebenchInstance(datasetPath, task.verifier.instance_id);
  if (!instance) {
    throw new Error(`Instance ${task.verifier.instance_id} not found in ${datasetPath}.`);
  }

  const surface = options.surface ?? task.babel_surface;
  const provider = options.provider;
  const model = options.model ?? resolveBenchmarkDeepSeekModel(task);
  const evidenceDir = resolve(options.evidenceDir);
  const workspaceRoot = join(evidenceDir, 'workspaces', task.task_id);
  const evidencePath = join(evidenceDir, `${task.task_id}-harness.json`);
  const started = performance.now();

  checkoutSwebenchRepo(instance, workspaceRoot);
  const playbook = selectPlaybook(task);
  const prompt = buildSweIssuePrompt(instance, playbook);

  // P0.1–P0.2: harness spawns dist/index.js — ensure build is current before the cell.
  ensureBabelCliDistReady();

  const cli = runBabelCli(
    [...babelModeArgs(surface, provider, model), '--json', '--yes', '--project-root', workspaceRoot, prompt],
    {
      projectRoot: workspaceRoot,
      offlineDemo: provider !== 'live',
      cliEntry: resolveBabelCliEntry(),
      cwd: join(BABEL_ROOT, 'babel-cli'),
      env: buildSweAgentChatEnv(benchmarkBabelEnv(provider)),
      timeoutMs: SWE_AGENT_TIMEOUT_MS,
      ensureDist: false, // already enforced above once per cell
    },
  );

  const patch = captureGitPatch(workspaceRoot);
  const predsPath = join(evidenceDir, `${task.task_id}-preds.jsonl`);
  writeFileSync(
    predsPath,
    `${JSON.stringify({
      model_name_or_path: 'babel-agent-chat',
      instance_id: instance.instance_id,
      model_patch: patch,
    })}\n`,
    'utf8',
  );

  let evalResult: ReturnType<typeof runSwebenchDockerEval> | null = null;
  let verifierOk = false;
  let verifierSource: 'docker' | 'gold_diff' | 'none' = 'none';
  let dockerSkipReason: string | null = null;
  const skipDocker = shouldSkipDockerEvalOnPlatform();
  if (skipDocker) {
    dockerSkipReason =
      'docker_eval_skipped_windows: gold_diff is authoritative (Linux-only docker deps e.g. resource)';
  } else if (patch.trim().length > 0 && isDockerAvailable()) {
    evalResult = runSwebenchDockerEval({
      forkRoot: resolveSwebenchForkPath(),
      predictionsPath: predsPath,
      instanceId: instance.instance_id,
      runId: `babel-agent-${task.task_id}-${Date.now()}`,
      datasetName: swebenchEvalDatasetName(instance),
    });
    if (evalResult.ok) {
      verifierOk = evalResult.resolved === true;
      verifierSource = 'docker';
    }
  } else if (patch.trim().length > 0 && !isDockerAvailable()) {
    dockerSkipReason = 'docker_eval_skipped: docker unavailable';
  }
  // Fallback / primary on Windows: compare agent patch against gold semantically.
  // Gold_diff is authoritative when docker is skipped or fails — do not let
  // docker stderr dominate notes. Label source whenever gold is available and
  // compared, including fail (avoid verifier_source=none after a real gold check).
  if (!verifierOk && patch.trim().length > 0) {
    const goldPatch = instance.patch ?? '';
    if (goldPatch.trim().length > 0) {
      verifierSource = 'gold_diff';
      if (patchesMatchSemantically(patch, goldPatch)) {
        verifierOk = true;
      }
    }
  }

  // P1.2: recover payload/critic when thin CLI JSON fails to parse as a whole document.
  const recoveredPayload = cli.payload;
  const criticReceipt = extractCriticReceiptFromCli(recoveredPayload, cli.stdout, cli.stderr);
  const statusText =
    typeof recoveredPayload?.['status'] === 'string' ? recoveredPayload['status'] : null;
  const claimedComplete =
    statusText === 'ANSWER_READY' ||
    statusText === 'FIX_COMPLETE' ||
    statusText === 'COMPLETE';
  const usage = extractChatUsage(recoveredPayload);
  const budgetExceeded = payloadIsBudgetExceeded(recoveredPayload);
  const agentBlocked =
    cli.exitCode !== 0 ||
    statusText === 'NEEDS_MORE_CONTEXT' ||
    statusText === 'BUDGET_EXCEEDED' ||
    /maximum call stack size exceeded|HTTP 402|positive balance/i.test(cli.stdout + cli.stderr);
  // false_complete = claimed done without honest local verification (or empty patch).
  // Wrong patch + local verifier pass is incorrect_patch / verifier_failed, not false_complete
  // (SWE-A09 class: agent ran pytest exit 0, claimed ANSWER_READY, gold_diff missed).
  const falseComplete = classifySweFalseComplete({
    claimedComplete,
    verifierOk,
    patch,
    payload: recoveredPayload,
  });
  const failureNote = classifySweFailureNote({
    claimedComplete,
    verifierOk,
    patch,
    payload: recoveredPayload,
    budgetExceeded,
  });
  // The verifier is the source of truth — if the patch matches gold (docker
  // or diff comparison), it's a success regardless of agent exit status.
  const success = verifierOk;

  // P1.2/P1.3: missing critic after writes is instrumentation failure, not "0 rejects".
  const hadWrites = patch.trim().length > 0;
  const criticInstrumentation =
    hadWrites && !criticReceipt
      ? 'missing_after_writes'
      : criticReceipt
        ? `present:${criticReceipt.verdict}`
        : 'not_applicable';

  // ─── C3: Failure/success card ──────────────────────────────────────────────
  const cardStatus = success
    ? 'PASSED'
    : failureNote === 'budget_exceeded'
      ? 'BUDGET_EXCEEDED'
      : 'FAILED';
  const turns =
    typeof recoveredPayload?.['total_turns'] === 'number' ? recoveredPayload['total_turns'] : 0;

  // Pro cost share from turn routing receipts when available
  const turnRouting: Array<{ model?: string; cost_usd?: number }> =
    Array.isArray(recoveredPayload?.['turn_routing']) ? recoveredPayload['turn_routing'] : [];
  let modelRoutingCost = 0;
  let proRoutingCost = 0;
  const modelsSeen = new Set<string>();
  for (const r of turnRouting) {
    if (typeof r.model === 'string') modelsSeen.add(r.model);
    if (typeof r.cost_usd === 'number') {
      modelRoutingCost += r.cost_usd;
      if (r.model && !r.model.includes('flash')) {
        proRoutingCost += r.cost_usd;
      }
    }
  }
  const proCostShare =
    modelRoutingCost > 0
      ? proRoutingCost / modelRoutingCost
      : 0.5;
  const modelsUsed =
    modelsSeen.size > 0
      ? [...modelsSeen]
      : ['deepseek-v4-pro', 'deepseek-v4-flash'];

  // Last tools from toolCalls payload
  const toolCalls: Array<{ tool?: string; target?: string }> =
    Array.isArray(recoveredPayload?.['toolCalls']) ? recoveredPayload['toolCalls'] : [];
  const lastTools = toolCalls.slice(-5).map((tc) => ({
    tool: tc.tool ?? 'unknown',
    target: tc.target ?? '',
  }));

  // Policy event counts
  const policyEvents: Array<{ kind?: string }> =
    Array.isArray(recoveredPayload?.['policy_events']) ? recoveredPayload['policy_events'] : [];
  const policyEventCounts: Record<string, number> = {};
  for (const pe of policyEvents) {
    const kind = pe.kind ?? 'unknown';
    policyEventCounts[kind] = (policyEventCounts[kind] ?? 0) + 1;
  }

  // Observation tails
  const observationTails =
    Array.isArray(recoveredPayload?.['observation_tails']) ? recoveredPayload['observation_tails'] : [];

  // Top blocked reasons from blocked_attempt_counts
  const blockedCounts = recoveredPayload?.['blocked_attempt_counts'];
  const byReason: Record<string, number> | undefined =
    blockedCounts && typeof blockedCounts === 'object'
      ? (blockedCounts as Record<string, unknown>)['byReason'] as Record<string, number> | undefined
      : undefined;
  const topBlockedReasons = byReason
    ? Object.entries(byReason)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
    : [];

  // Turn summaries
  const turnSummaries =
    Array.isArray(recoveredPayload?.['turn_summaries']) ? recoveredPayload['turn_summaries'] : [];

  // Recommended next action
  let recommendedAction: string | undefined;
  if (failureNote === 'false_complete') {
    recommendedAction = 'Run tests locally before claiming complete. Ensure local verifier passes.';
  } else if (failureNote === 'incorrect_patch') {
    recommendedAction = 'Local verifier passed but gold test failed. Review patch localization and API usage.';
  } else if (failureNote === 'budget_exceeded') {
    recommendedAction = 'Increase budget or reduce scope. Consider splitting into smaller tasks.';
  } else if (patch.trim().length === 0) {
    recommendedAction = 'Model produced no patch. Check tool availability (str_replace, write) and policy events.';
  } else if (!success && failureNote === 'verifier_failed') {
    recommendedAction = 'Patch produced but verifier failed. Review patch manually and fix test failures.';
  }

  const cardInput: FailureCardInput = {
    taskLabel: task.task_id,
    status: cardStatus,
    costUsd: usage.cost_usd ?? 0,
    turns,
    patchBytes: patch.length,
    emptyPatch: patch.trim().length === 0,
    modelsUsed,
    proCostShare,
    lastTools,
    policyEventCounts,
    ...(topBlockedReasons.length > 0 ? { topBlockedReasons } : {}),
    ...(observationTails.length > 0 ? { observationTails } : {}),
    ...(turnSummaries.length > 0 ? { turnSummaries } : {}),
    ...(recommendedAction !== undefined ? { recommendedAction } : {}),
    ...(typeof recoveredPayload?.['run_dir'] === 'string'
      ? { runDir: recoveredPayload['run_dir'] }
      : {}),
    ...(typeof recoveredPayload?.['transcript_path'] === 'string'
      ? { transcriptPath: recoveredPayload['transcript_path'] }
      : {}),
  };

  const cardFileName = success ? 'SUCCESS_CARD.md' : 'FAILURE_CARD.md';
  const cardPath = join(evidenceDir, `${task.task_id}-${cardFileName}`);
  const cardMarkdown = success ? renderSuccessCard(cardInput) : renderFailureCard(cardInput);
  writeFileSync(cardPath, cardMarkdown, 'utf8');

  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        task_id: task.task_id,
        instance_id: instance.instance_id,
        repo_root: workspaceRoot,
        cli_exit_code: cli.exitCode,
        cli_payload: recoveredPayload,
        // A4: Schema version for observability evolution
        observability_schema_version: 1,
        // Top-level critic always persisted even when cli_payload is null (C2).
        critic_receipt: criticReceipt,
        critic_instrumentation: criticInstrumentation,
        ...(recoveredPayload == null
          ? {
              cli_stdout_tail: cli.stdout.slice(-4000),
              cli_stderr_tail: cli.stderr.slice(-2000),
            }
          : {}),
        patch_bytes: patch.length,
        predictions_path: predsPath,
        docker_eval: evalResult,
        verifier_ok: verifierOk,
        verifier_source: verifierSource,
        // C3: Failure/success card path
        failure_card_path: success ? null : cardPath,
        success_card_path: success ? cardPath : null,
        usage,
        latency_ms: Math.round(performance.now() - started),
        // A4: Patch reality derived from git diff
        patch_reality: {
          patch_bytes: patch.length,
          changed_files: [...new Set(
            (patch.match(/^\+\+\+ b\/(.+)$/gm) ?? []).map((l: string) => l.replace(/^\+\+\+ b\//, ''))
          )],
          empty_patch: patch.trim().length === 0,
          capture_method: 'git_diff' as const,
          tool_write_count: typeof recoveredPayload?.['write_count'] === 'number' ? recoveredPayload['write_count'] : 0,
          git_write_signal: patch.trim().length > 0,
        },
        // A4: Tool call aggregates recovered from payload
        tool_call_count: typeof recoveredPayload?.['tool_call_count'] === 'number' ? recoveredPayload['tool_call_count'] : 0,
        write_count: typeof recoveredPayload?.['write_count'] === 'number' ? recoveredPayload['write_count'] : 0,
        verifier_attempt_count: typeof recoveredPayload?.['verifier_attempt_count'] === 'number' ? recoveredPayload['verifier_attempt_count'] : 0,
        // C2: Tools before first successful mutation (metric for first-move efficiency)
        tools_before_first_write: typeof recoveredPayload?.['tools_before_first_write'] === 'number' ? recoveredPayload['tools_before_first_write'] : 0,
        // B4: Prompt stack fingerprint from payload
        fingerprint: recoveredPayload?.['fingerprint'] ?? null,
        // B3: Blocked attempt ledger from payload
        blocked_attempts: Array.isArray(recoveredPayload?.['blocked_attempts']) ? recoveredPayload['blocked_attempts'] : [],
        blocked_attempt_counts: recoveredPayload?.['blocked_attempt_counts'] && typeof recoveredPayload['blocked_attempt_counts'] === 'object'
          ? recoveredPayload['blocked_attempt_counts']
          : { total: 0, byReason: {} },
        // A4: Run metadata from payload
        transcript_path: typeof recoveredPayload?.['transcript_path'] === 'string' ? recoveredPayload['transcript_path'] : null,
        run_dir: typeof recoveredPayload?.['run_dir'] === 'string' ? recoveredPayload['run_dir'] : null,
        // B2: Turn decision summaries
        turn_summaries: Array.isArray(recoveredPayload?.['turn_summaries']) ? recoveredPayload['turn_summaries'] : [],
      },
      null,
      2,
    ),
    'utf8',
  );

  const notes = [
    `swebench harness instance=${instance.instance_id} surface=${surface}`,
    patch.trim().length === 0 ? 'empty_patch' : `patch_bytes=${patch.length}`,
    // Prefer gold_diff authority messaging; only mention docker when it actually ran.
    verifierSource === 'gold_diff'
      ? 'verifier_source=gold_diff (authoritative)'
      : `verifier_source=${verifierSource}`,
    dockerSkipReason
      ? dockerSkipReason
      : evalResult
        ? `docker_eval_status=${evalResult.ok ? 'ok' : 'fail'}`
        : 'docker_eval_skipped',
    `failure_note=${failureNote}`,
    failureNote === 'incorrect_patch'
      ? 'incorrect_patch: local_verifier_pass + gold_fail — patch wrong localization/API'
      : failureNote === 'false_complete'
        ? 'false_complete: claimed complete without honest local verification'
        : failureNote === 'budget_exceeded'
          ? 'budget_exceeded: wall/cost/token kill (not NEEDS_MORE_CONTEXT)'
          : null,
    budgetExceeded ? 'status_class=BUDGET_EXCEEDED' : null,
    criticReceipt
      ? `critic_verdict=${criticReceipt.verdict}`
      : hadWrites
        ? 'critic_instrumentation=missing_after_writes'
        : null,
  ].filter((n): n is string => typeof n === 'string' && n.length > 0);

  return {
    parityResult: {
      task_id: task.external_ref,
      tool: 'babel',
      status: success ? 'success' : 'failure',
      verifier: patch.trim().length === 0 ? 'not_run' : verifierOk ? 'pass' : 'fail',
      false_complete: falseComplete,
      latency_ms: Math.round(performance.now() - started),
      cost_usd: usage.cost_usd,
      token_count: usage.token_count,
      changed_files: [],
      user_interventions: 0,
      evidence_path: evidencePath,
      notes,
    },
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    notes,
  };
}

export async function runTerminalBenchAgentCell(
  task: AgentBenchmarkTask,
  options: HarnessRunOptions,
): Promise<HarnessCellPayload> {
  if (task.verifier.kind !== 'harbor') {
    throw new Error(`Task ${task.task_id} is not a Terminal-Bench harbor task.`);
  }

  const tbRoot = options.tbRoot ?? resolveTerminalBenchRoot();
  const pilotScript = join(tbRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
  if (!existsSync(pilotScript)) {
    throw new Error(`Terminal-Bench pilot missing at ${pilotScript}`);
  }

  const surface = options.surface ?? task.babel_surface;
  const provider = options.provider;
  const model = options.model ?? resolveBenchmarkDeepSeekModel(task);
  const evidenceDir = resolve(options.evidenceDir);
  const jobDir = join(evidenceDir, 'terminal-bench', task.task_id);
  if (existsSync(jobDir)) {
    rmSync(jobDir, { recursive: true, force: true });
  }
  mkdirSync(jobDir, { recursive: true });

  const started = performance.now();
  const taskSlug = task.verifier.task_slug;
  const pilotArgs = [
    pilotScript,
    '--tasks',
    taskSlug,
    '--max-tasks',
    '1',
    '--output-dir',
    jobDir,
    '--job',
    `agent-benchmark-${task.task_id}`,
    '--babel-mode',
    surface === 'chat' ? 'chat' : 'deep',
    '--agent-timeout-ms',
    String(TB_AGENT_TIMEOUT_MS),
    '--continue-on-fail',
    'true',
  ];
  if (provider === 'live') {
    pilotArgs.push('--model', model);
  }

  const pilot = spawnSync(process.execPath, pilotArgs, {
    cwd: tbRoot,
    encoding: 'utf8',
    timeout: TB_AGENT_TIMEOUT_MS + 20 * 60 * 1000,
    maxBuffer: 30 * 1024 * 1024,
    env: deepSeekOnlyLiveEnv({
      ...process.env,
      BABEL_HEADLESS: '1',
      BABEL_BENCHMARK_AUTO_APPROVE: '1',
      ...(provider === 'live' ? { BABEL_LITE_OFFLINE: '0' } : {}),
    }),
    windowsHide: true,
  });

  const trialResultPath = findTerminalBenchTrialResult(jobDir, taskSlug);
  const evidencePath = join(evidenceDir, `${task.task_id}-harness.json`);
  let trialResult: Record<string, unknown> | null = null;
  if (trialResultPath) {
    trialResult = JSON.parse(readFileSync(trialResultPath, 'utf8')) as Record<string, unknown>;
  }

  const babel = (trialResult?.['babel'] ?? null) as Record<string, unknown> | null;
  const verifier = (trialResult?.['verifier'] ?? null) as Record<string, unknown> | null;
  const verifierPassed = verifier?.['passed'] === true;
  const babelDuration =
    typeof babel?.['duration_ms'] === 'number' ? Math.round(babel['duration_ms']) : null;
  const latencyMs = babelDuration ?? Math.round(performance.now() - started);

  let babelPayload: Record<string, unknown> | null = null;
  if (trialResultPath) {
    const trialDir = dirname(trialResultPath);
    const babelResultPath = join(trialDir, 'babel-result.json');
    if (existsSync(babelResultPath)) {
      babelPayload = JSON.parse(readFileSync(babelResultPath, 'utf8')) as Record<string, unknown>;
    }
  }
  const usage = extractChatUsage(babelPayload);
  const resultStatus = typeof babel?.['result_status'] === 'string' ? babel['result_status'] : null;
  const claimedComplete =
    resultStatus === 'ANSWER_READY' ||
    resultStatus === 'FIX_COMPLETE' ||
    resultStatus === 'COMPLETE';
  const pilotFailed = pilot.status !== 0;
  const success = verifierPassed && !pilotFailed;
  const falseComplete = claimedComplete && !verifierPassed;

  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        task_id: task.task_id,
        task_slug: taskSlug,
        job_dir: jobDir,
        trial_result_path: trialResultPath,
        pilot_exit_code: pilot.status,
        pilot_stdout: pilot.stdout?.slice(0, 20_000) ?? '',
        pilot_stderr: pilot.stderr?.slice(0, 8000) ?? '',
        trial_result: trialResult,
        usage,
        latency_ms: latencyMs,
      },
      null,
      2,
    ),
    'utf8',
  );

  const notes = [
    `terminal-bench harness slug=${taskSlug} surface=${surface}`,
    `pilot_exit=${pilot.status ?? 'null'}`,
    `verifier_passed=${verifierPassed}`,
  ];

  return {
    parityResult: {
      task_id: task.external_ref,
      tool: 'babel',
      status: success ? 'success' : 'failure',
      verifier: verifierPassed ? 'pass' : trialResult ? 'fail' : 'not_run',
      false_complete: falseComplete,
      latency_ms: latencyMs,
      cost_usd: usage.cost_usd,
      token_count: usage.token_count,
      changed_files: [],
      user_interventions: 0,
      evidence_path: evidencePath,
      notes,
    },
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    notes,
  };
}
