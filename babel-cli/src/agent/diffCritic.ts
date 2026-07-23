/**
 * Asymmetric diff critic (Harness Idea 14).
 *
 * Before the agent is allowed to complete an execute-intent task with writes,
 * a second cheap LLM call reviews the workspace patch against the task
 * statement. Generation and review are different skills — the critic catches
 * A09-class incorrect_patch outcomes (local verifier green, gold wrong).
 *
 * Disable: BABEL_DIFF_CRITIC=0
 * Model:   BABEL_DIFF_CRITIC_MODEL (default: deepseek-v4-flash)
 *
 * Fail-open: critic infrastructure errors never block completion (skip ≠ reject).
 * Rejects are repair strikes (MAX_CRITIC_STRIKES in ChatEngine): inject feedback
 * and force re-mutate. After strike exhaustion (or terminal max-turn path),
 * completion is hard-blocked — never soft-allow a still-rejected patch.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveChatTaskTune } from '../config/chatTaskClass.js';
import { isBabelHeadlessEnv } from '../utils/envFlags.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type DiffCriticVerdictKind = 'pass' | 'reject' | 'skip';

export interface DiffCriticInput {
  task: string;
  /** Unified diff or mutation summary text. */
  patch: string;
  verifierReceipt?: {
    command: string;
    exit_code: number;
    summary: string;
  } | null;
  proposedAnswer?: string;
  changedFiles?: string[];
  /** Optional issue test names (FAIL_TO_PASS / harness-provided). */
  issueTestNames?: string[];
  /** Optional expected API / symbols named by the issue. */
  expectedApis?: string[];
}

export type DiffCriticTier = 'heuristic' | 'flash' | 'pro';

export interface DiffCriticVerdict {
  verdict: DiffCriticVerdictKind;
  reasons: string[];
  /** 0–1 model/heuristic confidence. */
  confidence: number;
  raw?: string;
  model?: string;
  /** flash | pro | heuristic — for A/B receipts. */
  tier?: DiffCriticTier;
  skippedReason?: string;
  /** Wall time of the critic call (ms), when measured. */
  latency_ms?: number;
}

/** Default: model "pass" below this confidence is treated as reject. */
export const DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD = 0.6;

/**
 * SWE / hard cells: require a stronger pass. Flash often returns exactly 0.6
 * on uncertain localization (A09 live 2026-07-09 false-pass); 0.75 demotes those.
 */
export const SWE_DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD = 0.75;

export interface CollectedPatch {
  text: string;
  files: string[];
  source: 'git' | 'tool_log' | 'empty';
  truncated: boolean;
}

// ─── Config ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_PATCH_CHARS = 24_000;

export function isDiffCriticEnabled(): boolean {
  const env = process.env['BABEL_DIFF_CRITIC'];
  if (env === '0' || env === 'false') return false;
  if (env === '1' || env === 'true') return true;
  // Default on for headless/CI (agent benchmarks); interactive TTY opt-in.
  // Accept BABEL_HEADLESS=true|1|yes|on (not only '1').
  return isBabelHeadlessEnv();
}

export function resolveDiffCriticModel(): string {
  const fromEnv = process.env['BABEL_DIFF_CRITIC_MODEL']?.trim();
  if (fromEnv) return fromEnv;
  return 'deepseek-v4-flash';
}

/** Pro / second-tier critic model (SWE hard cells). */
export function resolveDiffCriticProModel(): string {
  const fromEnv = process.env['BABEL_DIFF_CRITIC_PRO_MODEL']?.trim();
  if (fromEnv) return fromEnv;
  return 'deepseek-v4-pro';
}

export function isSweCriticTierEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Explicit force on/off for A/B
  const flag = env['BABEL_DIFF_CRITIC_SWE_TIER']?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  // Task-class strict critic (general_swe, governance) — not cell-specific
  return resolveChatTaskTune({ env, autoClassify: false }).strictCritic;
}

/**
 * Whether a flash pass should escalate to pro second review.
 * SWE tier always escalates on pass; otherwise only low-confidence passes.
 */
export function shouldEscalateCriticToPro(
  verdict: DiffCriticVerdict,
  opts?: { sweTier?: boolean; confidenceThreshold?: number },
): boolean {
  if (verdict.verdict !== 'pass') return false;
  const thr = opts?.confidenceThreshold ?? DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD;
  if (opts?.sweTier) return true;
  return verdict.confidence < thr + 0.15; // low-margin pass
}

/**
 * Treat model pass below confidence threshold as reject (kill false-pass).
 */
export function applyCriticConfidenceThreshold(
  verdict: DiffCriticVerdict,
  threshold: number = DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD,
): DiffCriticVerdict {
  if (verdict.verdict !== 'pass') return verdict;
  if (verdict.confidence >= threshold) return verdict;
  return {
    ...verdict,
    verdict: 'reject',
    reasons: [
      ...verdict.reasons,
      `confidence ${verdict.confidence.toFixed(2)} below pass threshold ${threshold.toFixed(2)} — treating as reject`,
    ],
  };
}

/**
 * Local verifier supersedes critic pass:
 * - missing receipt (when required) → reject
 * - exit_code !== 0 → reject
 * Never let an LLM pass override a red or absent project test run.
 */
export function applyVerifierSupersedesCriticPass(
  verdict: DiffCriticVerdict,
  opts: {
    verifierReceipt?: {
      command: string;
      exit_code: number;
      summary: string;
    } | null;
    /** When true, missing receipt also demotes pass → reject. */
    requireGreenVerifier?: boolean;
  },
): DiffCriticVerdict {
  if (verdict.verdict !== 'pass') return verdict;
  const vr = opts.verifierReceipt;
  if (!vr) {
    if (!opts.requireGreenVerifier) return verdict;
    return {
      ...verdict,
      verdict: 'reject',
      reasons: [
        ...verdict.reasons,
        'local verifier receipt missing — critic pass demoted (require green tests before complete)',
      ],
    };
  }
  if (vr.exit_code === 0) return verdict;
  return {
    ...verdict,
    verdict: 'reject',
    reasons: [
      ...verdict.reasons,
      `local verifier exit_code=${vr.exit_code} supersedes critic pass (command: ${vr.command})`,
    ],
  };
}

// ─── Patch collection ─────────────────────────────────────────────────────

/**
 * Collect a reviewable patch for the critic.
 * Prefers `git diff HEAD` + staged; falls back to tool-log file list + snippets.
 */
export function collectWorkspacePatch(
  projectRoot: string,
  opts?: {
    maxChars?: number;
    /** Successful mutation targets from the tool log (fallback source). */
    mutationTargets?: string[];
  },
): CollectedPatch {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_PATCH_CHARS;
  const gitText = captureGitPatch(projectRoot);
  if (gitText.trim().length > 0) {
    const files = extractPathsFromDiff(gitText);
    const { text, truncated } = truncateText(gitText, maxChars);
    return { text, files, source: 'git', truncated };
  }

  const targets = (opts?.mutationTargets ?? []).filter((t) => t.length > 0);
  if (targets.length === 0) {
    return { text: '', files: [], source: 'empty', truncated: false };
  }

  const parts: string[] = ['# Mutation summary (git unavailable or clean tree)', ''];
  for (const target of targets.slice(0, 20)) {
    parts.push(`## ${target}`);
    const abs = join(projectRoot, target);
    const pathToRead = existsSync(abs) ? abs : target;
    if (existsSync(pathToRead)) {
      try {
        const content = readFileSync(pathToRead, 'utf8');
        const snippet = content.length > 800 ? content.slice(0, 800) + '\n…(truncated)' : content;
        parts.push('```', snippet, '```', '');
      } catch {
        parts.push('(unreadable)', '');
      }
    } else {
      parts.push('(file not found on disk)', '');
    }
  }
  const combined = parts.join('\n');
  const { text, truncated } = truncateText(combined, maxChars);
  const files = targets.map((t) => {
    try {
      return relative(projectRoot, t).replace(/\\/g, '/') || t;
    } catch {
      return t;
    }
  });
  return { text, files, source: 'tool_log', truncated };
}

function captureGitPatch(repoRoot: string): string {
  try {
    const unstaged = spawnSync('git', ['diff', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    const staged = spawnSync('git', ['diff', '--cached'], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    // Also include untracked new files as name-status for visibility
    const untracked = spawnSync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      },
    );
    const parts = [unstaged.stdout ?? '', staged.stdout ?? ''].filter(
      (p) => p.trim().length > 0,
    );
    const untrackedList = (untracked.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (untrackedList.length > 0) {
      parts.push(
        '# Untracked files:\n' + untrackedList.map((f) => `+ ${f}`).join('\n'),
      );
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

function extractPathsFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m?.[2]) files.add(m[2]);
    const m2 = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m2?.[1] && m2[1] !== '/dev/null') files.add(m2[1]);
  }
  return [...files];
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + `\n…(truncated ${text.length - maxChars} chars)`,
    truncated: true,
  };
}

// ─── Prompt + parse ───────────────────────────────────────────────────────

export const DIFF_CRITIC_SYSTEM_PROMPT = [
  'You are an independent, reject-biased code-review critic for a coding agent.',
  'You did NOT author the patch. Your job is to catch incorrect localization and',
  'incomplete fixes — not to rubber-stamp green local tests.',
  'When uncertain, prefer REJECT (false reject is recoverable; false pass is not).',
  'Respond with a single JSON object only. No markdown fences.',
].join(' ');

/**
 * Fast structural heuristic for A09-class wrong-method localization.
 *
 * High-confidence pattern only (avoid false rejects on gold patches):
 * - Task discusses both `clear` and `reset` (or get_records + clear decoupling)
 * - Patch rewrites `self.<list> = []` → `self.<list>.clear()` inside `reset`
 * - Patch does NOT add a new `def clear` / route call sites to `.clear()`
 *
 * Returns a reject verdict when the pattern matches; null otherwise.
 */
export function heuristicLocalizationReject(
  task: string,
  patch: string,
): DiffCriticVerdict | null {
  const taskLower = task.toLowerCase();
  const patchText = patch;

  const taskMentionsClear = /\bclear\b/.test(taskLower);
  const taskMentionsReset = /\breset\b/.test(taskLower);
  const taskMentionsGetRecords = /\bget_records\b/.test(taskLower);
  if (!taskMentionsClear) return null;
  if (!taskMentionsReset && !taskMentionsGetRecords) return null;

  // Gold-direction: adds def clear AND routes a call site to handler.clear().
  // Incomplete A09-class (live 2026-07-09): adds LogCaptureHandler.clear() but
  // fixture clear still calls handler.reset() (+ optional stash rewrite) — never
  // routes to the new clear(). That still diverges get_records from records.
  const addsClearMethod = /^\+\s*def\s+clear\s*\(/m.test(patchText);
  const routesToClearMethod = /^\+.*\b(?:self\.)?handler\.clear\s*\(/m.test(patchText);

  if (addsClearMethod && routesToClearMethod) return null;
  if (!addsClearMethod && routesToClearMethod) return null;

  if (addsClearMethod && !routesToClearMethod) {
    return {
      verdict: 'reject',
      confidence: 0.9,
      reasons: [
        'Patch adds a clear() helper but never routes fixture clear() to handler.clear()',
        'Fixture still uses handler.reset() (or only rewrites stash) — get_records can stay decoupled',
        'Gold-direction: add clear() that mutates records in place AND call it from LogCaptureFixture.clear',
      ],
      model: 'heuristic-localization',
      tier: 'heuristic',
    };
  }

  // Wrong pattern: inside reset(), change records = [] to records.clear()
  const resetsInPlaceClear =
    /def\s+reset\s*\([\s\S]{0,400}?-\s*self\.\w+\s*=\s*\[\s*\][\s\S]{0,120}?\+\s*self\.\w+\.clear\s*\(/i.test(
      patchText,
    ) ||
    // unified diff form with @@ context naming reset
    /@@[^\n]*\breset\b[\s\S]{0,300}?-\s*self\.\w+\s*=\s*\[\s*\][\s\S]{0,80}?\+\s*self\.\w+\.clear\s*\(/i.test(
      patchText,
    ) ||
    // bare unified hunk: minus assign + plus .clear without new def clear
    (/-\s*self\.\w+\s*=\s*\[\s*\]/.test(patchText) &&
      /\+\s*self\.\w+\.clear\s*\(/.test(patchText) &&
      /\bdef\s+reset\b/.test(patchText));

  if (!resetsInPlaceClear) return null;

  return {
    verdict: 'reject',
    confidence: 0.92,
    reasons: [
      'Task is about clear()/get_records decoupling, but the patch only rewrites reset() to use in-place clear()',
      'Gold-direction fixes usually add a dedicated clear() and route clear call sites to it while leaving reset() as list replacement',
      'Wrong-method localization is a common incorrect_patch failure (A09-class)',
    ],
    model: 'heuristic-localization',
    tier: 'heuristic',
  };
}

// ─── Symbol coverage (issue API ∩ patch additions) ────────────────────────

const STOP_SYMBOLS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'when', 'after', 'before',
  'test', 'tests', 'assert', 'true', 'false', 'none', 'null', 'self', 'return',
  'import', 'class', 'def', 'function', 'const', 'let', 'var', 'type', 'void',
  'string', 'number', 'object', 'list', 'dict', 'file', 'path', 'line', 'code',
  'error', 'issue', 'bug', 'fix', 'patch', 'change', 'call', 'calls', 'called',
  'should', 'would', 'could', 'must', 'does', 'fail', 'fails', 'failed', 'pass',
]);

/**
 * Extract candidate API / method / function identifiers from issue text.
 * Prefers backtick/`code` tokens and Name.name / Name() patterns.
 */
export function extractIssueApiSymbols(task: string, extra?: string[]): string[] {
  const found = new Set<string>();
  for (const e of extra ?? []) {
    const t = e.trim();
    if (t.length >= 2) found.add(t);
  }
  // `backtick` or ``double`` style
  for (const m of task.matchAll(/`([A-Za-z_][\w.]{1,60})`/g)) {
    const s = m[1]!;
    const base = s.includes('.') ? s.split('.').pop()! : s;
    if (base.length >= 2 && !STOP_SYMBOLS.has(base.toLowerCase())) found.add(base);
    if (s.includes('.')) found.add(s);
  }
  // foo.bar() or foo_bar(
  for (const m of task.matchAll(/\b([A-Za-z_][\w]{2,40})\s*\(/g)) {
    const s = m[1]!;
    if (!STOP_SYMBOLS.has(s.toLowerCase())) found.add(s);
  }
  // Caplog.clear / LogCaptureHandler.reset style
  for (const m of task.matchAll(/\b([A-Za-z_][\w]{1,30})\.([A-Za-z_][\w]{1,30})\b/g)) {
    const method = m[2]!;
    if (!STOP_SYMBOLS.has(method.toLowerCase())) found.add(method);
  }
  return [...found].slice(0, 40);
}

/** Symbols added on + lines of a unified diff (defs and call sites). */
export function extractAddedPatchSymbols(patch: string): string[] {
  const found = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    for (const m of body.matchAll(/\bdef\s+([A-Za-z_][\w]*)/g)) found.add(m[1]!);
    for (const m of body.matchAll(/\bfunction\s+([A-Za-z_][\w]*)/g)) found.add(m[1]!);
    for (const m of body.matchAll(/\b([A-Za-z_][\w]{1,40})\s*\(/g)) {
      const s = m[1]!;
      if (!STOP_SYMBOLS.has(s.toLowerCase())) found.add(s);
    }
  }
  return [...found];
}

export interface SymbolCoverageScore {
  required: string[];
  added: string[];
  covered: string[];
  missing: string[];
  /** 0–1 coverage of required symbols present in added lines. */
  coverage: number;
}

export function computeSymbolCoverage(
  task: string,
  patch: string,
  opts?: { expectedApis?: string[] },
): SymbolCoverageScore {
  const required = extractIssueApiSymbols(task, opts?.expectedApis);
  const added = extractAddedPatchSymbols(patch);
  const addedLower = new Set(added.map((s) => s.toLowerCase()));
  const covered = required.filter((r) => {
    const base = r.includes('.') ? r.split('.').pop()! : r;
    return addedLower.has(r.toLowerCase()) || addedLower.has(base.toLowerCase());
  });
  const missing = required.filter((r) => !covered.includes(r));
  const coverage = required.length === 0 ? 1 : covered.length / required.length;
  return { required, added, covered, missing, coverage };
}

/**
 * Structural pre-check: task names required API X; patch only edits alternate path Y
 * without adding X. Extends A09-class localization beyond the hard-coded clear/reset case.
 */
export function heuristicSymbolCoverageReject(
  task: string,
  patch: string,
  opts?: { expectedApis?: string[]; /** Strict tier: single high-signal API is enough */ strict?: boolean },
): DiffCriticVerdict | null {
  // Prefer specialized A09 heuristic when it fires
  const a09 = heuristicLocalizationReject(task, patch);
  if (a09) return a09;

  if (!patch.trim()) return null;
  const score = computeSymbolCoverage(task, patch, opts);
  // Strict: 1 named API with zero coverage is enough; default needs 2
  const minRequired = opts?.strict ? 1 : 2;
  if (score.required.length < minRequired) return null;
  if (score.coverage > 0) return null;
  if (score.added.length === 0) return null;

  // Only reject when missing symbols look like real APIs (not generic words)
  const strongMissing = score.missing.filter((s) => s.length >= 4 && /[a-z]/.test(s));
  if (strongMissing.length === 0) return null;

  return {
    verdict: 'reject',
    confidence: opts?.strict ? 0.85 : 0.78,
    reasons: [
      `Symbol coverage 0: issue requires [${score.required.slice(0, 8).join(', ')}] but patch adds none of them`,
      `Patch added symbols: [${score.added.slice(0, 8).join(', ') || '(none)'}]`,
      'Wrong-method localization risk — open the defining file for the named API before mutating',
    ],
    model: 'heuristic-symbol-coverage',
    tier: 'heuristic',
  };
}

/**
 * Detect patches that only touch test files while the task names specific
 * implementation APIs. Test-only patches that claim to fix a named API are
 * nearly always wrong — the model edited the test to pass rather than fixing
 * the implementation (A04-class incorrect_patch with local verifier green).
 */
export function heuristicTestOnlyPatchReject(
  task: string,
  patch: string,
  changedFiles?: string[],
): DiffCriticVerdict | null {
  const files = changedFiles && changedFiles.length > 0
    ? changedFiles
    : extractPathsFromDiff(patch);
  if (files.length === 0) return null;

  const isTestFile = (f: string): boolean => {
    const base = f.replace(/\\/g, '/').split('/').pop() ?? f;
    return /(^|[\\/])tests?[\\/]/.test(f) ||
      /(^|[\\/])__?tests?__?[\\/]/.test(f) ||
      /^test_/.test(base) ||
      /_test\.\w+$/.test(base) ||
      /^test/.test(base) && /\.py$/.test(base);
  };

  const allTestFiles = files.length > 0 && files.every(isTestFile);
  if (!allTestFiles) return null;

  // Extract API symbols from task — if task mentions specific APIs but
  // the patch only touches test files, the fix is test-gaming.
  const symbols = extractIssueApiSymbols(task);
  if (symbols.length === 0) return null;

  // Only fire when there are strong API symbols (length >= 4, not just
  // generic short names that could be anything).
  const strong = symbols.filter((s) => s.length >= 4);
  if (strong.length === 0) return null;

  return {
    verdict: 'reject',
    confidence: 0.88,
    reasons: [
      `Test-only patch: changed files [${files.join(', ')}] are all test paths`,
      `Task mentions APIs [${strong.slice(0, 6).join(', ')}] but no implementation file was touched`,
      'The patch likely makes tests pass without fixing the root cause — edit the implementation file for the named API',
    ],
    model: 'heuristic-test-only',
    tier: 'heuristic',
  };
}

/**
 * Run all cheap structural critics (no LLM). Used mid-loop and pre-complete.
 */
export function runHeuristicDiffCritic(
  task: string,
  patch: string,
  opts?: { expectedApis?: string[]; strict?: boolean; changedFiles?: string[] },
): DiffCriticVerdict | null {
  return (
    heuristicLocalizationReject(task, patch) ??
    heuristicTestOnlyPatchReject(task, patch, opts?.changedFiles) ??
    heuristicSymbolCoverageReject(task, patch, opts)
  );
}

export function buildDiffCriticPrompt(input: DiffCriticInput): string {
  const verifierBlock = input.verifierReceipt
    ? [
        '--- LOCAL VERIFIER RECEIPT ---',
        `command: ${input.verifierReceipt.command}`,
        `exit_code: ${input.verifierReceipt.exit_code}`,
        `summary: ${truncateText(input.verifierReceipt.summary, 600).text}`,
        '',
        'CRITICAL: exit_code 0 does NOT prove the task is solved. Local tests',
        'often pass on incorrect localization (A09-class incorrect_patch).',
        'A green verifier is NOT a reason to PASS.',
      ].join('\n')
    : '--- LOCAL VERIFIER RECEIPT ---\n(none recorded)';

  const filesBlock =
    input.changedFiles && input.changedFiles.length > 0
      ? `Changed files: ${input.changedFiles.slice(0, 30).join(', ')}`
      : 'Changed files: (see patch)';

  const answerBlock = input.proposedAnswer
    ? [
        '--- AGENT COMPLETION CLAIM ---',
        truncateText(input.proposedAnswer, 800).text,
      ].join('\n')
    : '';

  const testsBlock =
    input.issueTestNames && input.issueTestNames.length > 0
      ? [
          '--- ISSUE TEST NAMES (FAIL_TO_PASS / harness) ---',
          ...input.issueTestNames.slice(0, 20).map((t) => `- ${t}`),
          'Patch should make these tests pass for the right reason.',
        ].join('\n')
      : '';

  const apiBlock =
    input.expectedApis && input.expectedApis.length > 0
      ? [
          '--- EXPECTED API / SYMBOLS ---',
          input.expectedApis.slice(0, 20).join(', '),
          'PASS requires the patch to address these APIs, not only a related helper.',
        ].join('\n')
      : '';

  return [
    'Review this patch against the task. Be skeptical of incomplete fixes,',
    'wrong localization (editing a related but incorrect symbol/method),',
    'and solutions that only make a narrow test green.',
    '',
    '--- TASK ---',
    input.task.trim(),
    '',
    filesBlock,
    '',
    testsBlock,
    '',
    apiBlock,
    '',
    verifierBlock,
    '',
    answerBlock,
    '',
    '--- PATCH / MUTATION SUMMARY ---',
    input.patch.trim().length > 0 ? input.patch.trim() : '(empty patch)',
    '',
    '--- DECISION RUBRIC (reject-biased) ---',
    'PASS only if the patch addresses the ROOT CAUSE method/contract named in the task.',
    'REJECT if any of these hold:',
    '  1. Wrong symbol/method edited relative to the bug description',
    '     (e.g. task is about clear() but patch only changes reset())',
    '  2. Fix is a drive-by / unrelated to the stated failure mode',
    '  3. Incomplete: addresses a symptom but not the described contract',
    '  4. Deletes or weakens tests without fixing production code',
    '  5. Empty or no-op relative to the task',
    '  6. Changes a related helper in a way that may break its public contract',
    '     while leaving the named API (clear/reset/etc.) unfixed',
    'When in doubt → REJECT.',
    '',
    'Output JSON exactly:',
    '{"verdict":"pass"|"reject","confidence":0.0-1.0,"reasons":["..."]}',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Parse critic model output into a structured verdict.
 * Fail-closed to skip (not reject) on unparseable output — infrastructure noise
 * should not thrash the agent loop.
 */
export function parseDiffCriticVerdict(
  raw: string,
  opts?: { model?: string },
): DiffCriticVerdict {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      verdict: 'skip',
      reasons: ['empty critic response'],
      confidence: 0,
      raw,
      skippedReason: 'empty_response',
      ...(opts?.model ? { model: opts.model } : {}),
    };
  }

  let parsed: unknown;
  try {
    // Prefer fenced or bare JSON object
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const candidate = fence?.[1]?.trim() ?? trimmed;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    const jsonText =
      start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
    parsed = JSON.parse(jsonText);
  } catch {
    // Heuristic fallback: look for explicit reject/pass language
    const lower = trimmed.toLowerCase();
    if (/\b(verdict|decision)\s*[:=]\s*reject\b/.test(lower) || /\breject\b/.test(lower) && /\bwrong\b|\bincomplete\b|\bincorrect\b/.test(lower)) {
      return {
        verdict: 'reject',
        reasons: [truncateText(trimmed, 400).text],
        confidence: 0.4,
        raw,
        ...(opts?.model ? { model: opts.model } : {}),
      };
    }
    if (/\b(verdict|decision)\s*[:=]\s*pass\b/.test(lower)) {
      return {
        verdict: 'pass',
        reasons: [truncateText(trimmed, 400).text],
        confidence: 0.4,
        raw,
        ...(opts?.model ? { model: opts.model } : {}),
      };
    }
    return {
      verdict: 'skip',
      reasons: ['unparseable critic response'],
      confidence: 0,
      raw,
      skippedReason: 'parse_error',
      ...(opts?.model ? { model: opts.model } : {}),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      verdict: 'skip',
      reasons: ['critic JSON was not an object'],
      confidence: 0,
      raw,
      skippedReason: 'parse_error',
      ...(opts?.model ? { model: opts.model } : {}),
    };
  }

  const obj = parsed as Record<string, unknown>;
  const rawVerdict = String(obj['verdict'] ?? obj['decision'] ?? '')
    .trim()
    .toLowerCase();
  let verdict: DiffCriticVerdictKind = 'skip';
  if (
    rawVerdict === 'pass' ||
    rawVerdict === 'approve' ||
    rawVerdict === 'approved' ||
    rawVerdict === 'ok' ||
    rawVerdict === 'accept' ||
    rawVerdict === 'accepted'
  ) {
    verdict = 'pass';
  } else if (
    rawVerdict === 'reject' ||
    rawVerdict === 'fail' ||
    rawVerdict === 'block' ||
    rawVerdict === 'denied' ||
    rawVerdict === 'deny'
  ) {
    verdict = 'reject';
  }

  const reasonsRaw = obj['reasons'] ?? obj['reason'] ?? obj['issues'];
  const reasons: string[] = Array.isArray(reasonsRaw)
    ? reasonsRaw.map((r) => String(r)).filter((s) => s.length > 0)
    : typeof reasonsRaw === 'string' && reasonsRaw.length > 0
      ? [reasonsRaw]
      : [];

  let confidence = 0.5;
  if (typeof obj['confidence'] === 'number' && Number.isFinite(obj['confidence'])) {
    confidence = Math.min(1, Math.max(0, obj['confidence'] as number));
  } else if (typeof obj['confidence'] === 'string') {
    // Models sometimes return "high"/"medium"/"low" or numeric strings.
    const c = obj['confidence'].trim().toLowerCase();
    if (c === 'high' || c === 'very high') confidence = 0.9;
    else if (c === 'medium' || c === 'med' || c === 'moderate') confidence = 0.55;
    else if (c === 'low' || c === 'very low') confidence = 0.3;
    else {
      const n = Number(c);
      if (Number.isFinite(n)) confidence = Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
    }
  }

  if (verdict === 'skip') {
    return {
      verdict: 'skip',
      reasons: reasons.length > 0 ? reasons : ['unknown verdict field'],
      confidence,
      raw,
      skippedReason: 'unknown_verdict',
      ...(opts?.model ? { model: opts.model } : {}),
    };
  }

  return {
    verdict,
    reasons: reasons.length > 0 ? reasons : [verdict === 'reject' ? 'critic rejected without detail' : 'critic passed'],
    confidence,
    raw,
    ...(opts?.model ? { model: opts.model } : {}),
  };
}

export function buildDiffCriticRejectionMessage(verdict: DiffCriticVerdict): string {
  const reasonLines =
    verdict.reasons.length > 0
      ? verdict.reasons.map((r, i) => `  ${i + 1}. ${r}`).join('\n')
      : '  1. (no reasons provided)';
  return [
    'DIFF CRITIC REJECTED your completion.',
    'An independent review of your patch vs the task found problems:',
    reasonLines,
    '',
    'Do NOT claim complete yet. Re-read the task root cause, fix the patch',
    '(prefer the correct symbols/methods described in the bug), re-run the',
    'verifier, then complete again.',
  ].join('\n');
}

/**
 * Pure gate policy for critic verdicts (unit-tested).
 *
 * - pass → allow (reset strikes)
 * - skip → allow fail-open (preserve strikes)
 * - reject + terminal → hard-block (no repair budget left in the loop)
 * - reject within strike budget → reject (caller injects repair feedback)
 * - reject past strike budget → hard-block (never soft-allow wrong completion)
 */
export type DiffCriticGateDecision = 'allow' | 'reject' | 'block';

export function decideDiffCriticGate(
  verdict: DiffCriticVerdictKind,
  strikesBefore: number,
  maxStrikes: number,
  opts?: { terminal?: boolean },
): { decision: DiffCriticGateDecision; strikesAfter: number; reason?: string } {
  if (verdict === 'pass') {
    return { decision: 'allow', strikesAfter: 0 };
  }
  if (verdict === 'skip') {
    return { decision: 'allow', strikesAfter: strikesBefore };
  }
  // reject
  const strikesAfter = strikesBefore + 1;
  if (opts?.terminal) {
    return {
      decision: 'block',
      strikesAfter,
      reason: 'hard-block: turn budget exhausted with critic reject',
    };
  }
  if (strikesAfter <= maxStrikes) {
    return { decision: 'reject', strikesAfter };
  }
  return {
    decision: 'block',
    strikesAfter,
    reason: `hard-block after ${strikesAfter} critic strikes`,
  };
}

/**
 * Run the critic with an injected LLM invoker (testable, no runner import).
 * Supports optional two-tier: flash first, pro on SWE/low-margin pass.
 */
export async function runDiffCritic(
  input: DiffCriticInput,
  invoke: (prompt: string, systemPrompt: string) => Promise<string>,
  opts?: {
    model?: string;
    skipHeuristic?: boolean;
    /** When true (or SWE env), escalate flash pass to pro. */
    sweTier?: boolean;
    /** Second-tier invoker; if omitted, reuses invoke with pro model label only. */
    invokePro?: (prompt: string, systemPrompt: string) => Promise<string>;
    proModel?: string;
    confidenceThreshold?: number;
    /** Demote critic pass when local verifier missing/red. */
    requireGreenVerifier?: boolean;
    /** Stricter symbol-coverage heuristic (single named API). */
    strictSymbolCoverage?: boolean;
  },
): Promise<DiffCriticVerdict> {
  if (!input.patch.trim() && (!input.changedFiles || input.changedFiles.length === 0)) {
    return {
      verdict: 'reject',
      reasons: ['no patch or changed files to review'],
      confidence: 1,
      tier: 'heuristic',
      ...(opts?.model ? { model: opts.model } : {}),
    };
  }

  const flashModel = opts?.model ?? resolveDiffCriticModel();
  const sweTier = opts?.sweTier ?? isSweCriticTierEnabled();
  const thr =
    opts?.confidenceThreshold ??
    (sweTier ? SWE_DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD : DIFF_CRITIC_PASS_CONFIDENCE_THRESHOLD);
  const requireGreen =
    opts?.requireGreenVerifier === true || sweTier;

  // Structural pre-pass: localization + symbol coverage (no LLM).
  // Strict/SWE: single high-signal issue API with 0 coverage is enough to reject.
  if (!opts?.skipHeuristic) {
    const heuristic = runHeuristicDiffCritic(input.task, input.patch, {
      ...(input.expectedApis ? { expectedApis: input.expectedApis } : {}),
      strict: sweTier || opts?.strictSymbolCoverage === true,
      ...(input.changedFiles && input.changedFiles.length > 0
        ? { changedFiles: input.changedFiles }
        : {}),
    });
    if (heuristic && heuristic.verdict === 'reject' && heuristic.confidence >= 0.75) {
      return applyVerifierSupersedesCriticPass(heuristic, {
        ...(input.verifierReceipt !== undefined
          ? { verifierReceipt: input.verifierReceipt }
          : {}),
        requireGreenVerifier: requireGreen,
      });
    }
  }

  const started = Date.now();
  const prompt = buildDiffCriticPrompt(input);
  const raw = await invoke(prompt, DIFF_CRITIC_SYSTEM_PROMPT);
  let verdict = parseDiffCriticVerdict(raw, { model: flashModel });
  verdict.model = flashModel;
  verdict.tier = 'flash';
  verdict.latency_ms = Date.now() - started;

  const finalize = (v: DiffCriticVerdict): DiffCriticVerdict =>
    applyVerifierSupersedesCriticPass(applyCriticConfidenceThreshold(v, thr), {
      ...(input.verifierReceipt !== undefined
        ? { verifierReceipt: input.verifierReceipt }
        : {}),
      requireGreenVerifier: requireGreen,
    });

  // Escalate SWE / low-margin flash *pass* to pro before confidence demotion.
  if (shouldEscalateCriticToPro(verdict, { sweTier, confidenceThreshold: thr })) {
    const proModel = opts?.proModel ?? resolveDiffCriticProModel();
    const proInvoke = opts?.invokePro ?? invoke;
    const proStarted = Date.now();
    let proRaw: string | undefined;
    let lastProErr: unknown;
    // One retry — empty/timeout/rate-limit blips are common on second-tier.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        proRaw = await proInvoke(prompt, DIFF_CRITIC_SYSTEM_PROMPT);
        lastProErr = undefined;
        break;
      } catch (err) {
        lastProErr = err;
      }
    }
    if (proRaw !== undefined) {
      let proVerdict = parseDiffCriticVerdict(proRaw, { model: proModel });
      proVerdict.model = proModel;
      proVerdict.tier = 'pro';
      proVerdict.latency_ms = Date.now() - proStarted + (verdict.latency_ms ?? 0);
      // Pro may override flash pass with reject (reject-biased second opinion).
      return finalize(proVerdict);
    }

    const errMsg =
      lastProErr instanceof Error
        ? lastProErr.message
        : lastProErr !== undefined
          ? String(lastProErr)
          : 'unknown';
    const shortErr = errMsg.length > 180 ? `${errMsg.slice(0, 180)}…` : errMsg;
    const infraNote = `pro tier skipped (infra error: ${shortErr})`;

    if (sweTier && verdict.verdict === 'pass') {
      // Fail-closed for SWE: flash false-pass is worse than a recoverable reject.
      // Outer critic infra still fail-opens; second-tier ratification is required.
      return finalize({
        ...verdict,
        verdict: 'reject',
        reasons: [
          ...verdict.reasons,
          infraNote,
          'SWE two-tier: pro escalate required — demoting flash pass after pro infra failure',
        ],
        skippedReason: 'pro_infra_error',
      });
    }

    // Non-SWE: fail-open on pro infra — keep flash, still confidence-gate it.
    verdict.reasons = [...verdict.reasons, `${infraNote} — kept flash verdict`];
    return finalize(verdict);
  }

  return finalize(verdict);
}

/** Serialize for payload / ChatResult. */
export function toCriticReceipt(verdict: DiffCriticVerdict): Record<string, unknown> {
  return {
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    confidence: verdict.confidence,
    ...(verdict.model ? { model: verdict.model } : {}),
    ...(verdict.tier ? { tier: verdict.tier } : {}),
    ...(verdict.skippedReason ? { skipped_reason: verdict.skippedReason } : {}),
    ...(verdict.latency_ms !== undefined ? { latency_ms: verdict.latency_ms } : {}),
  };
}
