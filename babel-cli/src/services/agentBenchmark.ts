import { spawnSync } from 'node:child_process';
import { config as dotenvConfig } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';
import { loadBenchmarkManifest, type BenchmarkTask } from './governanceBenchmark.js';
import type { ParityToolResult } from './parityBenchmark.js';
import {
  parityCorpusMutationComplete,
  parityCorpusSeedExpectsFailingVerifier,
  readParityCorpusTask,
  resolveParityCorpusRunMode,
  runParityBabelCell,
  runParityCorpusVerifier,
  writeParityCorpusRepo,
} from './parityCorpus.js';
import { resolveBabelCliEntry, runBabelCli } from './liteTrustDemo.js';
import {
  isDockerAvailable,
  resolveBenchmarkDeepSeekModel,
  resolveTerminalBenchRoot,
  runSwebenchAgentCell,
  runTerminalBenchAgentCell,
} from './agentBenchmarkHarness.js';

import { BlockedReportSchema, type BlockedReport } from '../schemas/agentContracts.js';
import {
  isSuccessfulDirectMutation,
  isDirectMutationTool,
  isVerifierAttemptTool,
} from '../agent/mutationTools.js';
import {
  computeVerifierDependencyHashes,
  hasVerifierDependencyTamper,
} from '../agent/verifierIntegrity.js';

export { resolveBenchmarkDeepSeekModel } from './agentBenchmarkHarness.js';
export {
  computeVerifierDependencyHashes,
  hasVerifierDependencyTamper,
  hashVerifierTrackedContent,
} from '../agent/verifierIntegrity.js';

dotenvConfig({
  path: join(BABEL_ROOT, 'babel-cli', '.env'),
  override: true,
  quiet: true,
});

export const AGENT_BENCHMARK_SCHEMA_VERSION = 1;
export const DEFAULT_AGENT_BENCHMARK_ID = 'babel-agent-benchmark-v1';

const AgentBenchmarkTierSchema = z.enum(['A_daily', 'B_weekly', 'C_monthly', 'D_governance']);
const AgentBenchmarkSourceSchema = z.enum([
  'swe_bench_verified',
  'terminal_bench_2_1',
  'hunk4j',
  'babel_parity',
  'babel_governance',
]);
const AgentBenchmarkReadinessSchema = z.enum([
  'runnable_local',
  'requires_dataset',
  'requires_docker',
]);
const AgentBenchmarkSurfaceSchema = z.enum(['chat', 'plan', 'deep']);
export type AgentBenchmarkSurface = z.infer<typeof AgentBenchmarkSurfaceSchema>;
export type AgentBenchmarkReadiness = z.infer<typeof AgentBenchmarkReadinessSchema>;

const WorkspaceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('parity_corpus'),
    task_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('governance_fixture'),
    task_id: z.string().min(1),
  }),
]);

const VerifierSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('swebench'),
    instance_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('harbor'),
    task_slug: z.string().min(1),
  }),
  z.object({
    kind: z.literal('parity_corpus'),
    command: z.string().min(1),
  }),
  z.object({
    kind: z.literal('governance'),
    task_id: z.string().min(1),
  }),
]);

const AgentBenchmarkTaskSchema = z.object({
  task_id: z.string().min(1),
  source: AgentBenchmarkSourceSchema,
  tier: AgentBenchmarkTierSchema,
  title: z.string().min(1),
  external_ref: z.string().min(1),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  skills: z.array(z.string().min(1)).min(1),
  hunk_count: z.number().int().positive().optional(),
  file_count: z.number().int().positive().optional(),
  babel_surface: AgentBenchmarkSurfaceSchema,
  readiness: AgentBenchmarkReadinessSchema,
  prompt_template: z.string().min(1).optional(),
  workspace: WorkspaceSchema.optional(),
  verifier: VerifierSchema,
});

const AgentBenchmarkManifestSchema = z.object({
  schema_version: z.literal(1),
  benchmark_id: z.string().min(1),
  description: z.string().min(1),
  primary_surface: AgentBenchmarkSurfaceSchema,
  tiers: z.record(
    z.string(),
    z.object({
      label: z.string().min(1),
      cadence: z.string().min(1),
      target_pass_rate: z.number().min(0).max(1),
      notes: z.string().min(1),
    }),
  ),
  dataset_env: z.record(z.string(), z.string()).optional(),
  tasks: z.array(AgentBenchmarkTaskSchema).min(1),
});

export type AgentBenchmarkTier = z.infer<typeof AgentBenchmarkTierSchema>;
export type AgentBenchmarkSource = z.infer<typeof AgentBenchmarkSourceSchema>;
export type AgentBenchmarkTask = z.infer<typeof AgentBenchmarkTaskSchema>;
export type AgentBenchmarkManifest = z.infer<typeof AgentBenchmarkManifestSchema>;

export interface AgentBenchmarkCellResult extends ParityToolResult {
  benchmark_task_id: string;
  source: AgentBenchmarkSource;
  tier: AgentBenchmarkTier;
  external_ref: string;
  readiness: AgentBenchmarkReadiness;
  babel_surface: AgentBenchmarkSurface;
  execution_path: 'chat_engine' | 'deep_pipeline' | 'external_harness' | 'parity_offline_demo';
  input_tokens: number | null;
  output_tokens: number | null;
  failure_class:
    | 'passed'
    | 'agent_failed'
    | 'false_complete'
    | 'verifier_failed'
    | 'manual_required'
    | 'dataset_missing'
    | 'blocked'
    | 'docker_missing'
    | 'verifier_tampered'
    | 'budget_exceeded'
    | 'incorrect_patch';
  harness_command: string | null;
  blocked_report?: BlockedReport | null;
  verifier_tampered?: boolean;
  /**
   * T1.2: true when failure_class is blocked and token_count ≤ BLOCKED_TOKEN_BUDGET.
   * null when not a blocked outcome or tokens unknown.
   */
  blocked_within_budget?: boolean | null;
}

/** T1.2 target: honest BLOCKED exits should complete under this token budget. */
export const BLOCKED_TOKEN_BUDGET = 100_000;

export interface AgentBenchmarkReadinessReport {
  manifest_path: string;
  runnable_local: number;
  requires_dataset: number;
  requires_docker: number;
  dataset_paths: Record<string, { env_var: string; resolved: string | null; present: boolean }>;
  terminal_bench_runner: { path: string; present: boolean };
  docker_available: boolean;
  missing_for_full_suite: string[];
}

export interface AgentBenchmarkReport {
  schema_version: 1;
  benchmark_type: 'babel_agent_benchmark';
  benchmark_id: string;
  generated_at: string;
  artifact_path: string;
  options: {
    tier: AgentBenchmarkTier | 'all';
    provider: 'mock' | 'live';
    surface_override: AgentBenchmarkSurface | null;
    task_filter: string | null;
  };
  readiness: AgentBenchmarkReadinessReport;
  summary: {
    tasks_selected: number;
    runnable: number;
    manual_required: number;
    success: number;
    failure: number;
    false_complete: number;
    /** Fraction of scored cells with empty_patch (KPI alongside correct_rate). */
    empty_patch_rate: number | null;
    empty_patches: number;
    correct_rate: number | null;
    mean_latency_ms: number | null;
    total_cost_usd: number | null;
    total_tokens: number | null;
    mean_cost_usd: number | null;
    p95_tokens: number | null;
    p95_cost_usd: number | null;
    tier_pass_rates: Record<string, { passed: number; total: number; rate: number | null }>;
  };
  results: AgentBenchmarkCellResult[];
  improvement_actions: string[];
}

export interface RunAgentBenchmarkOptions {
  manifestPath?: string;
  tier?: AgentBenchmarkTier | 'all';
  taskId?: string;
  provider?: 'mock' | 'live';
  surface?: AgentBenchmarkSurface;
  evidenceDir?: string;
  outputPath?: string;
  now?: Date;
  runnableOnly?: boolean;
  executeExternal?: boolean;
}

interface ChatUsageMetrics {
  cost_usd: number | null;
  token_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
}

function extractChatUsage(payload: Record<string, unknown> | null): ChatUsageMetrics {
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
  const totalCostUSD = typeof usage['totalCostUSD'] === 'number' ? usage['totalCostUSD'] : null;
  const totalTokens = typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : null;
  const totalInputTokens =
    typeof usage['totalInputTokens'] === 'number' ? usage['totalInputTokens'] : null;
  const totalOutputTokens =
    typeof usage['totalOutputTokens'] === 'number' ? usage['totalOutputTokens'] : null;
  return {
    cost_usd: totalCostUSD,
    token_count: totalTokens,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_hit_tokens: typeof usage['totalCacheHitTokens'] === 'number' ? usage['totalCacheHitTokens'] : null,
    cache_miss_tokens: typeof usage['totalCacheMissTokens'] === 'number' ? usage['totalCacheMissTokens'] : null,
  };
}

/** P4: Extract changed_files, run_dir, tool-call summary, and verifier_receipt from CLI payload. */
function extractEvidenceFromPayload(payload: Record<string, unknown> | null): {
  changedFiles: string[];
  runDir: string | null;
  toolCallSummary: { total: number; writes: number; reads: number; verifier_attempts: number; sub_agents: number };
  verifierReceipt: { command?: string; exit_code?: number; summary?: string } | null;
} {
  if (!payload) {
    return { changedFiles: [], runDir: null, toolCallSummary: { total: 0, writes: 0, reads: 0, verifier_attempts: 0, sub_agents: 0 }, verifierReceipt: null };
  }
  const toolCalls = Array.isArray(payload['toolCalls']) ? (payload['toolCalls'] as Array<Record<string, unknown>>) : [];
  const changedFiles = Array.isArray(payload['changed_files']) && payload['changed_files'].length > 0
    ? (payload['changed_files'] as string[])
    : [...new Set(
        toolCalls
          .filter((tc) =>
            isSuccessfulDirectMutation(String(tc['tool'] ?? ''), tc['error'] as string | undefined),
          )
          .map((tc) => tc['target'])
          .filter((t): t is string => typeof t === 'string' && t.length > 0),
      )];
  const runDir =
    typeof payload['run_dir'] === 'string'
      ? payload['run_dir']
      : typeof payload['runDir'] === 'string'
        ? payload['runDir']
        : null;
  const toolCallSummary = {
    total: toolCalls.length,
    // T0.1: str_replace counts as a write
    writes: toolCalls.filter((tc) => isDirectMutationTool(String(tc['tool'] ?? ''))).length,
    reads: toolCalls.filter((tc) => tc['tool'] === 'read_file' || tc['tool'] === 'grep' || tc['tool'] === 'glob' || tc['tool'] === 'list_dir' || tc['tool'] === 'read_range').length,
    verifier_attempts: toolCalls.filter((tc) => isVerifierAttemptTool(String(tc['tool'] ?? ''))).length,
    sub_agents: toolCalls.filter((tc) => tc['tool'] === 'sub_agent').length,
  };
  const verifierReceipt = (payload['verifier_receipt'] as { command?: string; exit_code?: number; summary?: string } | null) ?? null;
  if (toolCalls.length === 0 && payload && Object.keys(payload).length > 5) {
    console.error(`[benchmark] extractEvidenceFromPayload: toolCalls empty but payload has ${Object.keys(payload).length} keys: ${Object.keys(payload).join(', ')}`);
  }
  return { changedFiles, runDir, toolCallSummary, verifierReceipt };
}

function babelCliCwd(): string {
  return join(BABEL_ROOT, 'babel-cli');
}

function invokeAgentBabelCli(
  args: string[],
  projectRoot: string,
  provider: 'mock' | 'live',
): ReturnType<typeof runBabelCli> {
  return runBabelCli(args, {
    projectRoot,
    offlineDemo: provider !== 'live',
    cliEntry: resolveBabelCliEntry(),
    cwd: babelCliCwd(),
    env: liveChatEnv(provider),
  });
}

function deepSeekOnlyLiveEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env['DEEPINFRA_API_KEY'];
  env['BABEL_BENCHMARK_DEEPSEEK_ONLY'] = '1';
  env['BABEL_COMPACTION_MODEL'] = 'deepseek-v4-flash';
  return env;
}

function liveChatEnv(provider: 'mock' | 'live'): NodeJS.ProcessEnv {
  // P1.4: parity with SWE harness env (task class, critic, interpreter eval).
  // Do not default BABEL_CHAT_MAX_WALL_MS — leave task-class walls intact unless set.
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    BABEL_ROOT,
    BABEL_HEADLESS: '1',
    BABEL_BENCHMARK_AUTO_APPROVE: '1',
    BABEL_ALLOW_INTERPRETER_EVAL: '1',
    BABEL_CHAT_TASK_CLASS: process.env['BABEL_CHAT_TASK_CLASS'] ?? 'general_swe',
    BABEL_CHAT_SWE_PROFILE: process.env['BABEL_CHAT_SWE_PROFILE'] ?? '1',
    BABEL_DIFF_CRITIC: process.env['BABEL_DIFF_CRITIC'] ?? '1',
    BABEL_DIFF_CRITIC_MODEL:
      process.env['BABEL_DIFF_CRITIC_MODEL'] ?? 'deepseek-v4-flash',
    BABEL_DIFF_CRITIC_SWE_TIER: process.env['BABEL_DIFF_CRITIC_SWE_TIER'] ?? '1',
    ...(provider === 'live' ? { BABEL_LITE_OFFLINE: '0' } : {}),
  };
  return provider === 'live' ? deepSeekOnlyLiveEnv(base) : base;
}

function paritySeedIntact(
  corpusTask: ReturnType<typeof readParityCorpusTask>,
  projectRoot: string,
): boolean {
  const paths = [corpusTask.target_file, ...Object.keys(corpusTask.files ?? {})];
  for (const relativePath of paths) {
    const broken =
      relativePath === corpusTask.target_file
        ? corpusTask.broken_implementation
        : (corpusTask.files?.[relativePath]?.broken ?? null);
    if (broken === null) {
      continue;
    }
    const actual = existsSync(join(projectRoot, relativePath))
      ? readFileSync(join(projectRoot, relativePath), 'utf8')
      : '';
    if (actual !== broken) {
      return false;
    }
  }
  return true;
}

function scoreChatParityCell(input: {
  corpusTask: ReturnType<typeof readParityCorpusTask>;
  projectRoot: string;
  cliExitCode: number;
  statusText: string | null;
  verifierOk: boolean;
  runMode: 'fix' | 'ask';
  blockedReport?: BlockedReport | null;
}): { success: boolean; falseComplete: boolean; mutationOk: boolean; claimedComplete: boolean; blocked: boolean; blockedReport: BlockedReport | null } {
  // R1: BLOCKED exit — agent correctly diagnosed impossible task
  if (input.blockedReport) {
    return { success: false, falseComplete: false, mutationOk: false, claimedComplete: false, blocked: true, blockedReport: input.blockedReport };
  }

  const claimedComplete =
    input.statusText === 'ANSWER_READY' ||
    input.statusText === 'FIX_COMPLETE' ||
    input.statusText === 'COMPLETE';

  if (input.runMode === 'ask') {
    const success =
      input.cliExitCode === 0 && input.statusText === 'ANSWER_READY' && paritySeedIntact(input.corpusTask, input.projectRoot);
    return { success, falseComplete: false, mutationOk: true, claimedComplete, blocked: false, blockedReport: null };
  }

  // Fix mode: triple-gate — agent must claim completion, verifier must pass, and files must be modified
  const mutationComplete = parityCorpusMutationComplete(input.corpusTask, input.projectRoot, input.verifierOk);
  const success = claimedComplete && input.verifierOk && mutationComplete.ok;
  const falseComplete = claimedComplete && mutationComplete.ok && !input.verifierOk;
  return { success, falseComplete, mutationOk: mutationComplete.ok, claimedComplete, blocked: false, blockedReport: null };
}

export function defaultAgentBenchmarkManifestPath(): string {
  return join(BABEL_ROOT, 'benchmarks', 'babel-agent-benchmark', 'manifest.json');
}

export function defaultSwebenchDatasetPath(): string {
  return join(BABEL_ROOT, 'benchmarks', 'datasets', 'swe-bench-verified', 'benchmark-subset.jsonl');
}

export function resolveSwebenchDatasetPath(): string | null {
  const fromEnv = process.env['SWEBENCH_DATASET_PATH'];
  if (fromEnv) {
    const resolved = resolve(fromEnv);
    return existsSync(resolved) ? resolved : null;
  }
  const fallback = defaultSwebenchDatasetPath();
  return existsSync(fallback) ? fallback : null;
}

function resolveHunk4jDatasetPath(): string | null {
  const fromEnv = process.env['HUNK4J_MANIFEST_PATH'];
  if (fromEnv && existsSync(resolve(fromEnv))) {
    return resolve(fromEnv);
  }
  return resolveSwebenchDatasetPath();
}

export function loadAgentBenchmarkManifest(
  path = defaultAgentBenchmarkManifestPath(),
): AgentBenchmarkManifest {
  return AgentBenchmarkManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function listAgentBenchmarkTasks(
  manifest = loadAgentBenchmarkManifest(),
  tier: AgentBenchmarkTier | 'all' = 'all',
): AgentBenchmarkTask[] {
  const tasks =
    tier === 'all' ? manifest.tasks : manifest.tasks.filter((task) => task.tier === tier);
  return [...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id));
}

export function assessAgentBenchmarkReadiness(
  manifest = loadAgentBenchmarkManifest(),
  manifestPath = defaultAgentBenchmarkManifestPath(),
): AgentBenchmarkReadinessReport {
  const datasetPaths: AgentBenchmarkReadinessReport['dataset_paths'] = {};
  for (const [source, envVar] of Object.entries(manifest.dataset_env ?? {})) {
    let resolved = process.env[envVar] ?? null;
    if (source === 'swe_bench_verified' && !resolved) {
      resolved = resolveSwebenchDatasetPath();
    }
    if (source === 'hunk4j' && !resolved) {
      resolved = resolveHunk4jDatasetPath();
    }
    datasetPaths[source] = {
      env_var: envVar,
      resolved,
      present: resolved !== null && existsSync(resolve(resolved)),
    };
  }

  const tbRoot = resolveTerminalBenchRoot();
  const runnerPath = join(tbRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
  const dockerAvailable = isDockerAvailable();
  datasetPaths['terminal_bench'] = {
    env_var: manifest.dataset_env?.['terminal_bench'] ?? 'TERMINAL_BENCH_ROOT',
    resolved: tbRoot,
    present: existsSync(runnerPath),
  };

  const counts = { runnable_local: 0, requires_dataset: 0, requires_docker: 0 };
  for (const task of manifest.tasks) {
    counts[task.readiness] += 1;
  }

  const missing: string[] = [];
  if (!datasetPaths['swe_bench_verified']?.present) {
    missing.push('SWE-bench Verified dataset (set SWEBENCH_DATASET_PATH)');
  }
  if (!datasetPaths['hunk4j']?.present) {
    missing.push('HUNK4J manifest overlay (set HUNK4J_MANIFEST_PATH or provision SWE JSONL with HUNK instance IDs)');
  }
  if (!existsSync(runnerPath)) {
    missing.push('Terminal-Bench pilot runner (benchmarks/scripts/run_babel_terminal_bench_pilot.mjs)');
  }
  if (!dockerAvailable) {
    missing.push(
      'Docker daemon (optional for SWE agent+gold_diff; required for docker SWE eval and Terminal-Bench verifier)',
    );
  }

  return {
    manifest_path: manifestPath,
    ...counts,
    dataset_paths: datasetPaths,
    terminal_bench_runner: { path: runnerPath, present: existsSync(runnerPath) },
    docker_available: dockerAvailable,
    missing_for_full_suite: missing,
  };
}

function harnessCommandForTask(task: AgentBenchmarkTask): string | null {
  if (task.verifier.kind === 'swebench') {
    const dataset = process.env['SWEBENCH_DATASET_PATH'] ?? '$SWEBENCH_DATASET_PATH';
    return [
      '# SWE-bench Verified harness (install swebench, Docker required)',
      `export SWEBENCH_DATASET_PATH=${dataset}`,
      `babel run --mode ${task.babel_surface} --project-root <checkout> "<issue prompt for ${task.verifier.instance_id}>"`,
      `python -m swebench.harness.run_evaluation --predictions_path <preds.jsonl> --instance_ids ${task.verifier.instance_id}`,
    ].join('\n');
  }
  if (task.verifier.kind === 'harbor') {
    const tbRoot = resolveTerminalBenchRoot();
    return [
      `node ${join(tbRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs')}`,
      `  --tasks ${task.verifier.task_slug}`,
      '  --suite agent-benchmark',
      '  --max-tasks 1',
    ].join(' ');
  }
  return null;
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
    return ['run', '--mode', 'chat', ...liveModel];
  }
  if (surface === 'plan') {
    return ['plan'];
  }
  return ['run', '--mode', 'deep', ...liveModel];
}

function classifyFailure(
  result: Pick<AgentBenchmarkCellResult, 'status' | 'verifier' | 'false_complete' | 'notes'>,
  blockedReport?: BlockedReport | null,
): AgentBenchmarkCellResult['failure_class'] {
  // R1: BLOCKED exit takes precedence — agent correctly diagnosed impossibility
  if (blockedReport) {
    return 'blocked';
  }
  const notesText = Array.isArray(result.notes)
    ? result.notes.join(' ')
    : typeof result.notes === 'string'
      ? result.notes
      : '';
  if (/\bbudget_exceeded\b|status_class=BUDGET_EXCEEDED/i.test(notesText)) {
    return 'budget_exceeded';
  }
  if (/\bincorrect_patch\b/i.test(notesText)) {
    return 'incorrect_patch';
  }
  if (result.status === 'manual_required') {
    return 'manual_required';
  }
  if (result.false_complete) {
    return 'false_complete';
  }
  if (result.status === 'success' && result.verifier === 'pass') {
    return 'passed';
  }
  if (result.verifier === 'fail') {
    return 'verifier_failed';
  }
  return 'agent_failed';
}

/**
 * R1 / T1.2: Validate a BlockedReport against the tool-call log.
 *
 * Accepts:
 * - Engine-synthesized blocks (text-only loop / per-round ceiling) with synthetic checked entries
 * - Strict tool+target matches (including target substring for long command lines)
 *
 * Soft accept when top-level status is BLOCKED is handled by
 * {@link extractBlockedReportFromPayload}, not here.
 */
export function validateBlockedReport(
  blockedReport: BlockedReport,
  toolCallLog: Array<{ tool: string; target: string }>,
): boolean {
  if (!blockedReport.checked || blockedReport.checked.length === 0) {
    return toolCallLog.length > 0;
  }

  const allSynthetic = blockedReport.checked.every(
    (e) =>
      e.action === 'chat_turn' ||
      e.target === 'text_only_loop' ||
      e.target === 'per_round_limit' ||
      e.target.includes('tamper'),
  );
  if (allSynthetic) return true;

  if (toolCallLog.length === 0) return false;

  const targetMatches = (tcTarget: string, entryTarget: string): boolean => {
    if (entryTarget.length < 3) return false;
    return tcTarget === entryTarget ||
      tcTarget.includes(entryTarget) ||
      entryTarget.includes(tcTarget);
  };

  return blockedReport.checked.every((entry) =>
    toolCallLog.some(
      (tc) => tc.tool === entry.action && targetMatches(tc.target, entry.target),
    ),
  );
}

/** Extract + validate blocked_report from a CLI payload (shared parity/governance). */
export function extractBlockedReportFromPayload(
  payload: Record<string, unknown> | null | undefined,
): BlockedReport | null {
  if (!payload) return null;
  const field = payload['blocked_report'];
  if (!field) return null;
  const parsed = BlockedReportSchema.safeParse(field);
  if (!parsed.success) return null;
  const toolCalls = Array.isArray(payload['toolCalls'])
    ? (payload['toolCalls'] as Array<Record<string, unknown>>).map((tc) => ({
        tool: String(tc['tool'] ?? ''),
        target: String(tc['target'] ?? ''),
      }))
    : [];
  if (validateBlockedReport(parsed.data, toolCalls)) {
    return parsed.data;
  }
  // T1.2 soft accept: top-level status BLOCKED + schema-valid report + any tool activity
  if (payload['status'] === 'BLOCKED' && toolCalls.length > 0) {
    return parsed.data;
  }
  return null;
}

/** T1.2: whether a blocked cell stayed under the token budget. */
export function isBlockedWithinBudget(
  tokenCount: number | null | undefined,
  blockedReport: BlockedReport | null | undefined,
): boolean | null {
  if (!blockedReport) return null;
  if (tokenCount == null) return null;
  return tokenCount <= BLOCKED_TOKEN_BUDGET;
}

function governanceTaskById(taskId: string): BenchmarkTask {
  const manifest = loadBenchmarkManifest();
  const task = manifest.tasks.find((entry) => entry.task_id === taskId);
  if (!task) {
    throw new Error(`Unknown governance benchmark task "${taskId}".`);
  }
  return task;
}

function setupGovernanceFixture(task: BenchmarkTask): string {
  const fixtureRoot = resolve(BABEL_ROOT, task.fixture_repo_path);
  const setup = spawnSync(task.initial_setup_command, {
    cwd: BABEL_ROOT,
    shell: true,
    encoding: 'utf8',
  });
  if (setup.status !== 0) {
    throw new Error(
      `Governance fixture setup failed for ${task.task_id}: ${setup.stderr || setup.stdout}`,
    );
  }
  return fixtureRoot;
}

function runVerifierCommands(projectRoot: string, commands: string[]): boolean {
  for (const command of commands) {
    const result = spawnSync(command, {
      cwd: projectRoot,
      shell: true,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      return false;
    }
  }
  return true;
}

/** Maximum auto-continuation rounds for cells that return NEEDS_MORE_CONTEXT (governance). */
const MAX_CONTINUE_ROUNDS = 2;
/** Maximum auto-continuation rounds for parity cells (C3: extra round for parity). */
const PARITY_MAX_CONTINUE_ROUNDS = 3;
/** Hard cost cap across all continuation rounds. */
const MAX_CONTINUE_COST_USD = 3.00;

/** Context for building a smarter continuation prompt (C3). */
interface ContinuationContext {
  previousStatus: string | null;
  previousAnswer: string;
  verifierOk: boolean;
  continueRounds: number;
  writesWereMade: boolean;
  cellType: 'parity' | 'governance';
  changedFiles: string[];
  /** R12: Consecutive auto-continue rounds with zero writes. Used to escalate
   *  the continuation prompt from "apply changes" to "is this BLOCKED?". */
  zeroWriteRounds: number;
}

function buildContinuationPrompt(
  task: AgentBenchmarkTask,
  ctx: ContinuationContext,
): string | null {
  const { previousStatus, verifierOk, continueRounds, writesWereMade } = ctx;

  // Only continue if the agent was blocked (NEEDS_MORE_CONTEXT) or failed
  if (previousStatus === 'ANSWER_READY' || previousStatus === 'COMPLETE' || previousStatus === 'FIX_COMPLETE') {
    return null; // Agent claims completion — don't second-guess, let verifier decide
  }

  // R12: Cross-round zero-write detection. If the agent has spent multiple
  // rounds investigating without making any file changes, it may be stuck on
  // a genuinely impossible task (missing binary, blocked dependency, etc.).
  // Instead of repeating "apply changes", escalate to a BLOCKED-oriented prompt.
  if (ctx.zeroWriteRounds >= 1 && !writesWereMade) {
    // Second or later consecutive zero-write round — the agent is not making
    // progress. Force a BLOCKED-or-act decision.
    return [
      'You have spent multiple attempts investigating but have not made any file changes.',
      'This may mean the task is genuinely blocked (missing dependency, impossible precondition, external constraint).',
      'You must now decide:',
      '- If the task CAN be completed: apply the fix with str_replace or write_file RIGHT NOW, then run the verifier.',
      '- If the task CANNOT be completed: declare BLOCKED with a structured report (reason, what is missing, evidence of what you checked).',
      'Do not describe what you would do — either make the change or declare BLOCKED.',
    ].join('\n');
  }

  const verifierCmd =
    task.verifier.kind === 'parity_corpus'
      ? task.verifier.command
      : task.verifier.kind === 'governance'
        ? 'the allowed verifier commands'
        : 'the test suite';

  // Round 3 (final attempt, parity only) — short, direct
  if (continueRounds >= 2) {
    return `Final attempt. Apply the fix with str_replace or write_file, then run: ${verifierCmd}`;
  }

  // Round 2 — aggressive, short. Skip for zero-write rounds (handled above).
  if (continueRounds >= 1) {
    return `Apply file changes now with str_replace or write_file. Then run: ${verifierCmd}`;
  }

  // Round 1 — brief, context-aware
  if (verifierOk === false) {
    if (writesWereMade) {
      return `Tests still fail after your changes. Fix remaining issues and run: ${verifierCmd}`;
    }
    return `Apply the fix with write_file or str_replace, then run: ${verifierCmd}`;
  }

  return `Continue. Apply changes and run: ${verifierCmd}`;
}

async function runParityAgentCell(
  task: AgentBenchmarkTask,
  options: RunAgentBenchmarkOptions,
): Promise<AgentBenchmarkCellResult> {
  const parityTaskId = task.workspace?.kind === 'parity_corpus' ? task.workspace.task_id : task.external_ref;
  const surface = options.surface ?? task.babel_surface;
  const provider = options.provider ?? 'mock';
  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'agent-benchmark'));

  if (surface !== 'chat' && provider === 'mock') {
    const parityResult = await runParityBabelCell(parityTaskId, {
      provider: 'mock',
      evidenceDir,
      command: 'daily',
    });
    const cell = toAgentCellResult(task, parityResult, null);
    return { ...cell, execution_path: 'parity_offline_demo', input_tokens: null, output_tokens: null };
  }

  const corpusTask = readParityCorpusTask(parityTaskId);
  const projectRoot = join(evidenceDir, 'workspaces', task.task_id);
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
  mkdirSync(projectRoot, { recursive: true });
  writeParityCorpusRepo(projectRoot, corpusTask);

  // P6: Pre-install npm dependencies so the agent can verify changes without
  // running `npm install` (which sandbox policy may block via run_command).
  // Fixes PAR-A03 flakiness where the agent declared BLOCKED after updating
  // package.json because chalk was not in node_modules.
  const workspacePkgPath = join(projectRoot, 'package.json');
  if (existsSync(workspacePkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(workspacePkgPath, 'utf8'));
      if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
        const installResult = spawnSync('npm', ['install'], {
          cwd: projectRoot,
          shell: true,
          timeout: 60_000,
          encoding: 'utf8',
        });
        if (installResult.status !== 0) {
          console.error(
            `[benchmark] WARNING: ${task.task_id} npm install failed (exit ${installResult.status}): ${installResult.stderr?.slice(0, 200)}`,
          );
        }
      }
    } catch (err) {
      console.error(`[benchmark] WARNING: ${task.task_id} npm install error: ${String(err)}`);
    }
  }

  // P5: Verify the fixture is in the expected broken state before running the agent
  if (parityCorpusSeedExpectsFailingVerifier(corpusTask)) {
    const baselineExit = runParityCorpusVerifier(projectRoot, corpusTask.verifier_command);
    if (baselineExit === 0) {
      // Workspace is pre-contaminated — force a fresh write and re-check
      console.error(`[benchmark] WARNING: ${task.task_id} workspace is pre-contaminated — verifier passes on broken fixture. Recreating…`);
      rmSync(projectRoot, { recursive: true, force: true });
      mkdirSync(projectRoot, { recursive: true });
      writeParityCorpusRepo(projectRoot, corpusTask);
      const retryExit = runParityCorpusVerifier(projectRoot, corpusTask.verifier_command);
      if (retryExit === 0) {
        throw new Error(
          `Cannot run benchmark ${task.task_id}: fixture cannot be written in broken state after retry. ` +
          `Check filesystem locks or fixture data.`
        );
      }
    }
  }

  // R9: Hash verifier dependency files before the agent runs
  const preRunHashes = computeVerifierDependencyHashes(projectRoot, [corpusTask.verifier_command]);

  const runModeRaw = resolveParityCorpusRunMode(corpusTask);
  const runMode: 'fix' | 'ask' = runModeRaw === 'ask' ? 'ask' : 'fix';
  const prompt =
    runMode === 'ask'
      ? corpusTask.task
      : `Fix the issue in this repository. Run ${corpusTask.verifier_command} before completing.\n\n${corpusTask.task}`;

  const started = performance.now();
  const model = options.provider === 'live' ? resolveBenchmarkDeepSeekModel(task) : undefined;

  // P3: Auto-continue loop — retry up to PARITY_MAX_CONTINUE_ROUNDS if agent is blocked
  let cli = invokeAgentBabelCli(
    [
      ...babelModeArgs(surface, provider, model),
      '--json',
      '--yes',
      '--project-root',
      projectRoot,
      prompt,
    ],
    projectRoot,
    provider,
  );
  let verifierOk = runParityCorpusVerifier(projectRoot, corpusTask.verifier_command) === 0;
  let statusText = typeof cli.payload?.['status'] === 'string' ? cli.payload['status'] : null;
  let scored = scoreChatParityCell({
    corpusTask,
    projectRoot,
    cliExitCode: cli.exitCode,
    statusText,
    verifierOk,
    runMode,
  });
  let usage = extractChatUsage(cli.payload);
  let continueRounds = 0;
  const continueNotes: string[] = [];
  // R12: Track cumulative writes across auto-continue rounds to detect
  // cross-round stall — agent makes just enough tool calls to avoid the
  // per-round stall detector but never actually writes files.
  let totalWrites = extractEvidenceFromPayload(cli.payload).toolCallSummary.writes;
  let zeroWriteRounds = totalWrites === 0 ? 1 : 0;
  // T2.4: Track consecutive rounds with zero tool calls. An auto-continue
  // round that made zero tool calls is in a text-only loop — the engine's
  // R11 guard caught it within the round; restarting would only re-trigger
  // the same loop. Refuse to auto-continue and treat as stuck.
  let totalToolCalls = extractEvidenceFromPayload(cli.payload).toolCallSummary.total;
  let zeroToolCallRounds = totalToolCalls === 0 ? 1 : 0;
  // Continue when agent signals it's blocked — independent of verifier state
  let agentBlocked =
    statusText === 'NEEDS_MORE_CONTEXT' ||
    statusText === null ||
    cli.exitCode !== 0 ||
    (usage.token_count !== null && usage.token_count === 0) ||
    /maximum call stack size exceeded|HTTP 402|positive balance/i.test(
      typeof (cli.payload?.['answer'] as Record<string, unknown> | undefined)?.['answer'] === 'string'
        ? String((cli.payload?.['answer'] as Record<string, unknown>)['answer'])
        : cli.stdout + cli.stderr,
    );

  // T2.4: Do not auto-continue when the first round made zero tool calls —
  // the model was stuck in a text-only loop and restarting wastes budget.
  if (zeroToolCallRounds > 0) {
    continueNotes.push('auto_continue: refusing — round made zero tool calls (text-only loop)');
    agentBlocked = false;
  }

  while (
    continueRounds < PARITY_MAX_CONTINUE_ROUNDS &&
    agentBlocked &&
    !scored.falseComplete &&
    usage.cost_usd !== null &&
    usage.cost_usd < MAX_CONTINUE_COST_USD
  ) {
    const answerText =
      typeof (cli.payload?.['answer'] as Record<string, unknown> | undefined)?.['answer'] === 'string'
        ? String((cli.payload?.['answer'] as Record<string, unknown>)['answer'])
        : '';
    // R12: If the agent's answer mentions BLOCKED, don't auto-continue —
    // the engine or agent declared the task impossible.
    if (/\bBLOCKED\b/i.test(answerText)) {
      continueNotes.push(`auto_continue_round_${continueRounds}: agent declared BLOCKED, stopping`);
      break;
    }
    // T2.4: If the previous round made zero tool calls, refuse to
    // auto-continue — the model is in a text-only loop and restarting
    // would just re-trigger the same R11 guard.
    if (zeroToolCallRounds > 0) {
      continueNotes.push(`auto_continue_round_${continueRounds}: zero tool calls, refusing restart`);
      break;
    }
    const prevEvidence = extractEvidenceFromPayload(cli.payload);
    const contPrompt = buildContinuationPrompt(task, {
      previousStatus: statusText,
      previousAnswer: answerText,
      verifierOk,
      continueRounds,
      writesWereMade: prevEvidence.toolCallSummary.writes > 0,
      cellType: 'parity',
      changedFiles: prevEvidence.changedFiles,
      zeroWriteRounds,
    });
    if (!contPrompt) break; // Agent claims completion — let verifier be the judge

    continueRounds++;
    cli = invokeAgentBabelCli(
      [
        ...babelModeArgs(surface, provider, model),
        '--json',
        '--yes',
        '--project-root',
        projectRoot,
        contPrompt,
      ],
      projectRoot,
      provider,
    );
    verifierOk = runParityCorpusVerifier(projectRoot, corpusTask.verifier_command) === 0;
    statusText = typeof cli.payload?.['status'] === 'string' ? cli.payload['status'] : null;
    scored = scoreChatParityCell({
      corpusTask,
      projectRoot,
      cliExitCode: cli.exitCode,
      statusText,
      verifierOk,
      runMode,
    });
    const roundUsage = extractChatUsage(cli.payload);
    usage = {
      cost_usd: (usage.cost_usd ?? 0) + (roundUsage.cost_usd ?? 0),
      token_count: (usage.token_count ?? 0) + (roundUsage.token_count ?? 0),
      input_tokens: (usage.input_tokens ?? 0) + (roundUsage.input_tokens ?? 0),
      output_tokens: (usage.output_tokens ?? 0) + (roundUsage.output_tokens ?? 0),
      cache_hit_tokens: (usage.cache_hit_tokens ?? 0) + (roundUsage.cache_hit_tokens ?? 0),
      cache_miss_tokens: (usage.cache_miss_tokens ?? 0) + (roundUsage.cache_miss_tokens ?? 0),
    };
    agentBlocked =
      statusText === 'NEEDS_MORE_CONTEXT' ||
      statusText === null ||
      cli.exitCode !== 0 ||
      (roundUsage.token_count !== null && roundUsage.token_count === 0) ||
      /maximum call stack size exceeded|HTTP 402|positive balance/i.test(answerText);
    // R12: Track cumulative writes across rounds. If this round also had
    // zero writes, increment the counter — the next continuation prompt
    // will escalate to a BLOCKED-oriented message.
    const roundEvidence = extractEvidenceFromPayload(cli.payload);
    const roundWrites = roundEvidence.toolCallSummary.writes;
    totalWrites += roundWrites;
    if (roundWrites === 0) {
      zeroWriteRounds++;
    } else {
      zeroWriteRounds = 0; // Reset — progress was made
    }
    // T2.4: Track zero-tool-call rounds. If this round had zero tool
    // calls, the model is stuck in a text-only loop — the next iteration
    // (if any) will check zeroToolCallRounds and refuse to restart.
    const roundToolCalls = roundEvidence.toolCallSummary.total;
    if (roundToolCalls === 0) {
      zeroToolCallRounds++;
    } else {
      zeroToolCallRounds = 0;
    }
    continueNotes.push(`continue_round_${continueRounds}: status=${String(statusText)} verifier=${verifierOk ? 'pass' : 'fail'} writes=${roundWrites} zeroWriteRounds=${zeroWriteRounds}`);
  }

  // R9: Check verifier dependency file hashes after the agent completes
  // package.json is scripts-slice only — legitimate dep edits (PAR-A03) do not flag.
  const postRunHashes = computeVerifierDependencyHashes(projectRoot, [corpusTask.verifier_command]);
  const verifierTampered = hasVerifierDependencyTamper(preRunHashes, postRunHashes);

  // R1 / T1.2: Extract and validate BLOCKED report from final CLI payload
  const blockedReport = extractBlockedReportFromPayload(cli.payload);
  const blockedWithinBudgetParity = isBlockedWithinBudget(usage.token_count, blockedReport);

  const evidencePath = join(evidenceDir, `${task.task_id}-babel.json`);
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        task_id: task.task_id,
        cli_exit_code: cli.exitCode,
        cli_stdout: cli.stdout.slice(0, 20000),
        cli_stderr: cli.stderr.slice(0, 8000),
        cli_payload: cli.payload,
        verifier_ok: verifierOk,
        mutation_ok: scored.mutationOk,
        agent_claimed_complete: scored.claimedComplete,
        surface,
        provider,
        execution_path: surface === 'chat' ? 'chat_engine' : 'deep_pipeline',
        usage,
        blocked_report: blockedReport,
        blocked_within_budget: blockedWithinBudgetParity,
        latency_ms: Math.round(performance.now() - started),
      },
      null,
      2,
    ),
    'utf8',
  );

  // P4: Extract evidence from CLI payload
  const evidence = extractEvidenceFromPayload(cli.payload);

  // Gate verifier on agent completion: a "pass" with 0 tokens and a crash
  // message is a false positive (the fixture was already passing).
  const effectiveSuccess = scored.success && !agentBlocked;

  const parityResult: ParityToolResult = {
    task_id: parityTaskId,
    tool: 'babel',
    status: effectiveSuccess ? 'success' : 'failure',
    verifier: verifierOk ? 'pass' : 'fail',
    false_complete: scored.falseComplete,
    latency_ms: Math.round(performance.now() - started),
    cost_usd: usage.cost_usd,
    token_count: usage.token_count,
    changed_files: evidence.changedFiles,
    user_interventions: 0,
    evidence_path: evidencePath,
    notes: [
      `agent-benchmark surface=${surface} provider=${provider} execution=chat_engine`,
      `status=${String(statusText)} verifier=${verifierOk ? 'pass' : 'fail'} mutation_ok=${scored.mutationOk} claimed=${scored.claimedComplete}${verifierTampered ? ' verifier_tampered=true' : ''}`,
      ...(continueRounds > 0 ? [`auto_continue_rounds=${continueRounds}`] : []),
      ...continueNotes,
    ],
    tool_call_summary: evidence.toolCallSummary,
    run_dir: evidence.runDir,
    verifier_receipt: evidence.verifierReceipt,
  } as ParityToolResult & { tool_call_summary?: typeof evidence.toolCallSummary; run_dir?: string | null; verifier_receipt?: typeof evidence.verifierReceipt };

  // R9: Escalate verifier_tampered to failure_class when the cell is not passing.
  // Scripts-slice hashing means legitimate package.json dep edits no longer set the flag.
  const failureClass =
    verifierTampered && !scored.success
      ? 'verifier_tampered'
      : blockedReport
        ? 'blocked'
        : undefined;
  const cell = toAgentCellResult(task, parityResult, null, failureClass);
  return {
    ...cell,
    execution_path: surface === 'chat' ? 'chat_engine' : 'deep_pipeline',
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    blocked_report: blockedReport,
    blocked_within_budget: blockedWithinBudgetParity,
    ...(verifierTampered ? { verifier_tampered: true } : {}),
  };
}

async function runGovernanceAgentCell(
  task: AgentBenchmarkTask,
  options: RunAgentBenchmarkOptions,
): Promise<AgentBenchmarkCellResult> {
  const govTaskId = task.workspace?.kind === 'governance_fixture' ? task.workspace.task_id : task.external_ref;
  const govTask = governanceTaskById(govTaskId);
  const surface = options.surface ?? task.babel_surface;
  const provider = options.provider ?? 'mock';
  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'agent-benchmark'));
  const fixtureRoot = setupGovernanceFixture(govTask);

  // R9: Hash verifier dependency files before the agent runs
  const allowedCommands: string[] = govTask.allowed_verifier_commands;
  const preRunHashes = computeVerifierDependencyHashes(fixtureRoot, allowedCommands);

  const started = performance.now();
  const model = options.provider === 'live' ? resolveBenchmarkDeepSeekModel(task) : undefined;

  // P3: Auto-continue loop for governance cells
  let cli = invokeAgentBabelCli(
    [
      ...babelModeArgs(surface, provider, model),
      '--json',
      '--yes',
      '--project-root',
      fixtureRoot,
      govTask.task_prompt,
    ],
    fixtureRoot,
    provider,
  );

  let verifierOk = runVerifierCommands(fixtureRoot, govTask.allowed_verifier_commands);
  let statusText = typeof cli.payload?.['status'] === 'string' ? cli.payload['status'] : null;
  let answerText =
    typeof (cli.payload?.['answer'] as Record<string, unknown> | undefined)?.['answer'] === 'string'
      ? String((cli.payload?.['answer'] as Record<string, unknown>)['answer'])
      : '';
  let usage = extractChatUsage(cli.payload);
  let agentBlocked =
    cli.exitCode !== 0 ||
    statusText === 'NEEDS_MORE_CONTEXT' ||
    (usage.token_count !== null && usage.token_count === 0) ||
    /maximum call stack size exceeded|HTTP 402|positive balance/i.test(answerText);
  const claimedComplete =
    statusText === 'ANSWER_READY' ||
    statusText === 'FIX_COMPLETE' ||
    statusText === 'COMPLETE';
  // T1.2: never treat BLOCKED as a pass; stop auto-continue on honest exits
  let declaredBlocked =
    statusText === 'BLOCKED' ||
    extractBlockedReportFromPayload(cli.payload) != null ||
    /\bBLOCKED\b/i.test(answerText);
  let falseComplete = claimedComplete && !verifierOk && !declaredBlocked;
  let success = verifierOk && !agentBlocked && !declaredBlocked;
  let continueRounds = 0;
  const continueNotes: string[] = [];
  // R12: Track cumulative writes across auto-continue rounds.
  let totalWrites = extractEvidenceFromPayload(cli.payload).toolCallSummary.writes;
  let zeroWriteRounds = totalWrites === 0 ? 1 : 0;
  // T2.4: Track consecutive rounds with zero tool calls (see parity loop).
  let totalToolCalls = extractEvidenceFromPayload(cli.payload).toolCallSummary.total;
  let zeroToolCallRounds = totalToolCalls === 0 ? 1 : 0;

  // T2.4: Do not auto-continue when the first round made zero tool calls.
  if (zeroToolCallRounds > 0) {
    continueNotes.push('auto_continue: refusing — round made zero tool calls (text-only loop)');
    agentBlocked = false;
  }

  while (
    continueRounds < MAX_CONTINUE_ROUNDS &&
    agentBlocked &&
    !falseComplete &&
    !declaredBlocked &&
    usage.cost_usd !== null &&
    usage.cost_usd < MAX_CONTINUE_COST_USD
  ) {
    // T2.4: If the previous round made zero tool calls, refuse to auto-continue.
    if (zeroToolCallRounds > 0) {
      continueNotes.push(`auto_continue_round_${continueRounds}: zero tool calls, refusing restart`);
      break;
    }
    const prevEvidence = extractEvidenceFromPayload(cli.payload);
    const contPrompt = buildContinuationPrompt(task, {
      previousStatus: statusText,
      previousAnswer: answerText,
      verifierOk,
      continueRounds,
      writesWereMade: prevEvidence.toolCallSummary.writes > 0,
      cellType: 'governance',
      changedFiles: prevEvidence.changedFiles,
      zeroWriteRounds,
    });
    if (!contPrompt) break;

    continueRounds++;
    cli = invokeAgentBabelCli(
      [
        ...babelModeArgs(surface, provider, model),
        '--json',
        '--yes',
        '--project-root',
        fixtureRoot,
        contPrompt,
      ],
      fixtureRoot,
      provider,
    );
    verifierOk = runVerifierCommands(fixtureRoot, govTask.allowed_verifier_commands);
    statusText = typeof cli.payload?.['status'] === 'string' ? cli.payload['status'] : null;
    answerText =
      typeof (cli.payload?.['answer'] as Record<string, unknown> | undefined)?.['answer'] === 'string'
        ? String((cli.payload?.['answer'] as Record<string, unknown>)['answer'])
        : '';
    agentBlocked =
      cli.exitCode !== 0 ||
      statusText === 'NEEDS_MORE_CONTEXT' ||
      /maximum call stack size exceeded|HTTP 402|positive balance/i.test(answerText);
    declaredBlocked =
      statusText === 'BLOCKED' ||
      extractBlockedReportFromPayload(cli.payload) != null ||
      /\bBLOCKED\b/i.test(answerText);
    falseComplete =
      (statusText === 'ANSWER_READY' || statusText === 'FIX_COMPLETE' || statusText === 'COMPLETE') &&
      !verifierOk &&
      !declaredBlocked;
    success = verifierOk && !agentBlocked && !declaredBlocked;
    const roundUsage = extractChatUsage(cli.payload);
    usage = {
      cost_usd: (usage.cost_usd ?? 0) + (roundUsage.cost_usd ?? 0),
      token_count: (usage.token_count ?? 0) + (roundUsage.token_count ?? 0),
      input_tokens: (usage.input_tokens ?? 0) + (roundUsage.input_tokens ?? 0),
      output_tokens: (usage.output_tokens ?? 0) + (roundUsage.output_tokens ?? 0),
      cache_hit_tokens: (usage.cache_hit_tokens ?? 0) + (roundUsage.cache_hit_tokens ?? 0),
      cache_miss_tokens: (usage.cache_miss_tokens ?? 0) + (roundUsage.cache_miss_tokens ?? 0),
    };
    // R12: Track cumulative writes across rounds.
    const roundEvidence = extractEvidenceFromPayload(cli.payload);
    const roundWrites = roundEvidence.toolCallSummary.writes;
    totalWrites += roundWrites;
    if (roundWrites === 0) {
      zeroWriteRounds++;
    } else {
      zeroWriteRounds = 0;
    }
    // T2.4: Track zero-tool-call rounds (same pattern as parity loop).
    const roundToolCalls = roundEvidence.toolCallSummary.total;
    if (roundToolCalls === 0) {
      zeroToolCallRounds++;
    } else {
      zeroToolCallRounds = 0;
    }
    continueNotes.push(`continue_round_${continueRounds}: status=${String(statusText)} verifier=${verifierOk ? 'pass' : 'fail'} writes=${roundWrites} zeroWriteRounds=${zeroWriteRounds}`);
  }
  // R9: Check verifier dependency file hashes after the agent completes
  const postRunHashes = computeVerifierDependencyHashes(fixtureRoot, allowedCommands);
  const verifierTampered = hasVerifierDependencyTamper(preRunHashes, postRunHashes);

  // R1 / T1.2: Extract and validate BLOCKED report from final CLI payload
  let blockedReport = extractBlockedReportFromPayload(cli.payload);
  if (!blockedReport && declaredBlocked && Array.isArray(cli.payload?.['toolCalls'])) {
    // Synthesize minimal report so diagnosis is preserved when status was BLOCKED
    // but structured field failed soft validation.
    const toolCalls = (cli.payload!['toolCalls'] as Array<Record<string, unknown>>).map((tc) => ({
      tool: String(tc['tool'] ?? ''),
      target: String(tc['target'] ?? ''),
    }));
    const investigateTools = new Set([
      'read_file', 'read_range', 'grep', 'glob', 'list_dir',
      'run_command', 'shell_exec', 'test_run',
    ]);
    if (toolCalls.length > 0) {
      blockedReport = {
        schema_version: 1,
        status: 'BLOCKED',
        reason: answerText.slice(0, 200) || 'Agent declared BLOCKED',
        missing: 'External dependency or precondition not available',
        checked: toolCalls.slice(-10)
          .filter((tc) => investigateTools.has(tc.tool))
          .map((tc) => ({
            action: tc.tool,
            target: tc.target,
            finding: 'Investigated — see tool call log',
          })),
        next_steps: [
          'Provide the missing proprietary binary or environment before retrying.',
        ],
      };
    }
  }

  const blockedWithinBudget = isBlockedWithinBudget(usage.token_count, blockedReport);

  const evidencePath = join(evidenceDir, `${task.task_id}-babel.json`);
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        task_id: task.task_id,
        governance_task_id: govTaskId,
        cli_exit_code: cli.exitCode,
        cli_stdout: cli.stdout.slice(0, 20000),
        cli_stderr: cli.stderr.slice(0, 8000),
        cli_payload: cli.payload,
        verifier_ok: verifierOk,
        usage,
        blocked_report: blockedReport,
        blocked_within_budget: blockedWithinBudget,
        declared_blocked: declaredBlocked,
        execution_path: surface === 'chat' ? 'chat_engine' : 'deep_pipeline',
      },
      null,
      2,
    ),
    'utf8',
  );

  // P4: Extract evidence from CLI payload
  const evidenceGov = extractEvidenceFromPayload(cli.payload);

  const parityResult: ParityToolResult = {
    task_id: govTaskId,
    tool: 'babel',
    status: success ? 'success' : 'failure',
    verifier: verifierOk ? 'pass' : 'fail',
    false_complete: falseComplete,
    latency_ms: Math.round(performance.now() - started),
    cost_usd: usage.cost_usd,
    token_count: usage.token_count,
    changed_files: evidenceGov.changedFiles,
    user_interventions: 0,
    evidence_path: evidencePath,
    notes: [
      `governance fixture ${govTaskId} surface=${surface} execution=chat_engine`,
      `${agentBlocked ? `agent_blocked: ${answerText.slice(0, 120)}` : declaredBlocked ? 'agent_declared_BLOCKED' : 'agent_completed'}${verifierTampered ? ' verifier_tampered=true' : ''}`,
      ...(blockedReport
        ? [
            `blocked_report=present reason=${blockedReport.reason.slice(0, 80)}`,
            `blocked_within_budget=${String(blockedWithinBudget)} token_budget=${BLOCKED_TOKEN_BUDGET}`,
          ]
        : []),
      ...(continueRounds > 0 ? [`auto_continue_rounds=${continueRounds}`] : []),
      ...continueNotes,
    ],
    tool_call_summary: evidenceGov.toolCallSummary,
    run_dir: evidenceGov.runDir,
    verifier_receipt: evidenceGov.verifierReceipt,
  } as ParityToolResult & { tool_call_summary?: typeof evidenceGov.toolCallSummary; run_dir?: string | null; verifier_receipt?: typeof evidenceGov.verifierReceipt };

  // R9: Only escalate verifier_tampered to failure_class when the cell is not passing.
  // verifier_tampered takes precedence — tampering is a more severe finding than a BLOCKED diagnosis.
  const govFailureClass =
    verifierTampered && !success
      ? 'verifier_tampered'
      : blockedReport
        ? 'blocked'
        : declaredBlocked
          ? 'blocked'
          : undefined;
  const cell = toAgentCellResult(task, parityResult, null, govFailureClass);
  return {
    ...cell,
    execution_path: surface === 'chat' ? 'chat_engine' : 'deep_pipeline',
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    blocked_report: blockedReport,
    blocked_within_budget: blockedWithinBudget,
    ...(verifierTampered ? { verifier_tampered: true } : {}),
  };
}

function externalManualCell(
  task: AgentBenchmarkTask,
  failureClass: AgentBenchmarkCellResult['failure_class'],
  datasetPath?: string | null,
): AgentBenchmarkCellResult {
  const harness = harnessCommandForTask(task);
  const datasetNote =
    datasetPath && task.verifier.kind === 'swebench'
      ? `Dataset row available in ${datasetPath} (instance ${task.verifier.instance_id}). Docker checkout + swebench harness still required.`
      : null;
  const base: ParityToolResult = {
    task_id: task.external_ref,
    tool: 'babel',
    status: 'manual_required',
    verifier: 'not_run',
    false_complete: false,
    latency_ms: null,
    cost_usd: null,
    token_count: null,
    changed_files: [],
    user_interventions: null,
    evidence_path: null,
    notes: [
      `Task requires ${task.readiness}. Run harness manually when dataset/Docker is available.`,
      ...(datasetNote ? [datasetNote] : []),
      ...(harness ? [`Harness:\n${harness}`] : []),
    ],
  };
  return toAgentCellResult(task, base, harness, failureClass);
}

function toAgentCellResult(
  task: AgentBenchmarkTask,
  result: ParityToolResult,
  harnessCommand: string | null,
  failureClassOverride?: AgentBenchmarkCellResult['failure_class'],
  executionPath: AgentBenchmarkCellResult['execution_path'] = 'external_harness',
): AgentBenchmarkCellResult {
  const failure_class = failureClassOverride ?? classifyFailure(result);
  return {
    ...result,
    benchmark_task_id: task.task_id,
    source: task.source,
    tier: task.tier,
    external_ref: task.external_ref,
    readiness: task.readiness,
    babel_surface: task.babel_surface,
    execution_path: executionPath,
    input_tokens: null,
    output_tokens: null,
    failure_class,
    harness_command: harnessCommand,
  };
}

export async function runAgentBenchmarkTask(
  task: AgentBenchmarkTask,
  options: RunAgentBenchmarkOptions = {},
): Promise<AgentBenchmarkCellResult> {
  const executeExternal = options.executeExternal ?? options.runnableOnly !== true;

  if (task.readiness === 'requires_dataset') {
    const path =
      task.source === 'hunk4j' ? resolveHunk4jDatasetPath() : resolveSwebenchDatasetPath();
    if (!path || !existsSync(path)) {
      return externalManualCell(task, 'dataset_missing');
    }
    if (!executeExternal || options.provider !== 'live') {
      return externalManualCell(task, 'manual_required', path);
    }
    if (task.verifier.kind !== 'swebench') {
      return externalManualCell(task, 'manual_required', path);
    }
    // Docker is optional for SWE agent cells: harness uses gold_diff when docker
    // is unavailable or platform-skipped (Windows). Do not short-circuit here —
    // that blocked all Windows remeasures after isDockerAvailable was coupled to
    // the eval-skip policy.
    const model = resolveBenchmarkDeepSeekModel(task);
    const harness = await runSwebenchAgentCell(task, {
      evidenceDir: resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'agent-benchmark')),
      provider: 'live',
      surface: options.surface ?? task.babel_surface,
      datasetPath: path,
      model,
    });
    const cell = toAgentCellResult(task, harness.parityResult, harnessCommandForTask(task), undefined, 'external_harness');
    return {
      ...cell,
      input_tokens: harness.input_tokens,
      output_tokens: harness.output_tokens,
      notes: cell.notes ?? [],
    };
  }

  if (task.readiness === 'requires_docker') {
    const tbRoot = resolveTerminalBenchRoot();
    const runner = join(tbRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
    if (!existsSync(runner)) {
      return externalManualCell(task, 'docker_missing');
    }
    if (!executeExternal || options.provider !== 'live') {
      return externalManualCell(task, 'manual_required');
    }
    if (!isDockerAvailable()) {
      return externalManualCell(task, 'docker_missing');
    }
    const model = resolveBenchmarkDeepSeekModel(task);
    const harness = await runTerminalBenchAgentCell(task, {
      evidenceDir: resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'agent-benchmark')),
      provider: 'live',
      surface: options.surface ?? task.babel_surface,
      tbRoot,
      model,
    });
    const cell = toAgentCellResult(task, harness.parityResult, harnessCommandForTask(task), undefined, 'external_harness');
    return {
      ...cell,
      input_tokens: harness.input_tokens,
      output_tokens: harness.output_tokens,
      notes: cell.notes ?? [],
    };
  }

  if (task.source === 'babel_parity') {
    return runParityAgentCell(task, options);
  }

  if (task.source === 'babel_governance') {
    return runGovernanceAgentCell(task, options);
  }

  return externalManualCell(task, 'manual_required');
}

function buildImprovementActions(
  results: AgentBenchmarkCellResult[],
  readiness: AgentBenchmarkReadinessReport,
): string[] {
  const actions: string[] = [];
  const falseCompletes = results.filter((row) => row.failure_class === 'false_complete');
  const multiHunkFails = results.filter(
    (row) =>
      row.tier === 'B_weekly' &&
      row.status === 'failure' &&
      (row.source === 'hunk4j' || row.external_ref === 'multi_file_refactor'),
  );

  if (falseCompletes.length > 0) {
    actions.push(
      `Tighten verifier-before-complete gate: ${falseCompletes.map((row) => row.benchmark_task_id).join(', ')} reported success without verifier pass.`,
    );
  }
  if (multiHunkFails.length > 0) {
    actions.push(
      'Improve multi-hunk coordination: consider plan→propose→fix decomposition or explicit file-scoped subagent dispatch for B-tier tasks.',
    );
  }
  if (readiness.missing_for_full_suite.length > 0) {
    actions.push(`Provision external datasets: ${readiness.missing_for_full_suite.join('; ')}`);
  }
  const tbFails = results.filter(
    (row) => row.source === 'terminal_bench_2_1' && row.status === 'manual_required',
  );
  if (tbFails.length > 0) {
    actions.push(
      'Run Terminal-Bench pilot for C-tier tasks and feed results into benchmarkImprovementLoop analysis.',
    );
  }
  const blockedCells = results.filter((row) => row.failure_class === 'blocked');
  if (blockedCells.length > 0) {
    actions.push(
      `Review blocked-cell diagnoses for accuracy: ${blockedCells.map((row) => row.benchmark_task_id).join(', ')} reported BLOCKED. Verify each checked-entry maps to a real tool call.`,
    );
  }
  const tamperedCells = results.filter((row) => row.failure_class === 'verifier_tampered');
  if (tamperedCells.length > 0) {
    actions.push(
      `Verifier tampering detected in ${tamperedCells.length} cell(s): ${tamperedCells.map((row) => row.benchmark_task_id).join(', ')}. The agent modified verifier dependency files. Consider verifier integrity hardening or fixture redesign.`,
    );
  }
  if (actions.length === 0) {
    actions.push('No automatic improvement actions; review per-task evidence paths for regressions.');
  }
  return actions;
}

/** Compute the p-th percentile (0-1) from a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(p * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(index, sorted.length - 1));
  const value = sorted[clamped];
  return value ?? 0;
}

export async function runAgentBenchmarkSuite(
  options: RunAgentBenchmarkOptions = {},
): Promise<AgentBenchmarkReport> {
  const manifestPath = options.manifestPath ?? defaultAgentBenchmarkManifestPath();
  const manifest = loadAgentBenchmarkManifest(manifestPath);
  const tier = options.tier ?? 'all';
  const readiness = assessAgentBenchmarkReadiness(manifest, manifestPath);

  let tasks = listAgentBenchmarkTasks(manifest, tier);
  if (options.runnableOnly === true) {
    tasks = tasks.filter((task) => task.readiness === 'runnable_local');
  }
  if (options.taskId) {
    tasks = tasks.filter((task) => task.task_id === options.taskId);
    if (tasks.length === 0) {
      throw new Error(`Unknown agent benchmark task "${options.taskId}".`);
    }
  }

  const evidenceDir = resolve(options.evidenceDir ?? join(BABEL_RUNS_DIR, 'agent-benchmark'));
  mkdirSync(evidenceDir, { recursive: true });

  const results: AgentBenchmarkCellResult[] = [];
  for (const task of tasks) {
    results.push(await runAgentBenchmarkTask(task, { ...options, evidenceDir }));
  }

  const runnable = results.filter((row) => row.status !== 'manual_required').length;
  const manual = results.filter((row) => row.status === 'manual_required').length;
  const success = results.filter((row) => row.status === 'success').length;
  const failure = results.filter((row) => row.status === 'failure').length;
  const falseComplete = results.filter((row) => row.false_complete).length;
  const scored = results.filter((row) => row.status !== 'manual_required');
  const emptyPatches = scored.filter((row) => {
    const notesText = Array.isArray(row.notes)
      ? row.notes.join(' ')
      : typeof row.notes === 'string'
        ? row.notes
        : '';
    return /\bempty_patch\b/i.test(notesText) || /\bpatch_bytes=0\b/.test(notesText);
  }).length;
  const emptyPatchRate = scored.length > 0 ? emptyPatches / scored.length : null;
  const correctRate = scored.length > 0 ? success / scored.length : null;
  const latencies = results
    .map((row) => row.latency_ms)
    .filter((value): value is number => typeof value === 'number');
  const costs = results
    .map((row) => row.cost_usd)
    .filter((value): value is number => typeof value === 'number');
  const tokens = results
    .map((row) => row.token_count)
    .filter((value): value is number => typeof value === 'number');
  const meanLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null;
  const totalCost =
    costs.length > 0 ? Number(costs.reduce((sum, value) => sum + value, 0).toFixed(6)) : null;
  const totalTokens = tokens.length > 0 ? tokens.reduce((sum, value) => sum + value, 0) : null;
  const meanCost =
    costs.length > 0 ? Number((totalCost! / costs.length).toFixed(6)) : null;

  // R2: Compute p95 for tokens and cost (p50 is also computed for diagnostic context)
  const sortedTokens = [...tokens].sort((a, b) => a - b);
  const sortedCosts = [...costs].sort((a, b) => a - b);
  const p95Tokens = tokens.length > 0 ? percentile(sortedTokens, 0.95) : null;
  const p95Cost = costs.length > 0 ? percentile(sortedCosts, 0.95) : null;

  const tierPassRates: AgentBenchmarkReport['summary']['tier_pass_rates'] = {};
  for (const tierId of new Set(results.map((row) => row.tier))) {
    const tierRows = results.filter((row) => row.tier === tierId && row.status !== 'manual_required');
    const passed = tierRows.filter((row) => row.status === 'success' && row.verifier === 'pass').length;
    tierPassRates[tierId] = {
      passed,
      total: tierRows.length,
      rate: tierRows.length > 0 ? passed / tierRows.length : null,
    };
  }

  const now = options.now ?? new Date();
  const artifactPath = resolve(
    options.outputPath ?? join(evidenceDir, `agent-benchmark-report-${now.toISOString().replace(/[:.]/g, '-')}.json`),
  );
  mkdirSync(dirname(artifactPath), { recursive: true });

  const report: AgentBenchmarkReport = {
    schema_version: 1,
    benchmark_type: 'babel_agent_benchmark',
    benchmark_id: manifest.benchmark_id,
    generated_at: now.toISOString(),
    artifact_path: artifactPath,
    options: {
      tier,
      provider: options.provider ?? 'mock',
      surface_override: options.surface ?? null,
      task_filter: options.taskId ?? null,
    },
    readiness,
    summary: {
      tasks_selected: results.length,
      runnable,
      manual_required: manual,
      success,
      failure,
      false_complete: falseComplete,
      empty_patches: emptyPatches,
      empty_patch_rate: emptyPatchRate,
      correct_rate: correctRate,
      mean_latency_ms: meanLatency,
      total_cost_usd: totalCost,
      total_tokens: totalTokens,
      mean_cost_usd: meanCost,
      p95_tokens: p95Tokens,
      p95_cost_usd: p95Cost,
      tier_pass_rates: tierPassRates,
    },
    results,
    improvement_actions: buildImprovementActions(results, readiness),
  };

  writeFileSync(artifactPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}
