/**
 * SWE-Bench Pro (Scale AI) campaign runner — standalone path for shadow scoreboard data.
 *
 * - Does not reuse Verified docker eval (`swebench.harness`)
 * - V1 verifier: semantic gold_diff when gold patch present
 * - Early-stop: abort after N consecutive identical failure signatures
 * - Harvests policy_events for offline shadow precision/recall
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';
import {
  buildSweAgentChatEnv,
  buildSweIssuePrompt,
  isDockerAvailable,
  parseSweStringList,
  patchesMatchSemantically,
  type SwebenchInstanceRow,
} from './agentBenchmarkHarness.js';
import {
  ensureBabelCliDistReady,
  parseCliJson,
  resolveBabelCliEntry,
  buildCliFailureCapsule,
  syntheticPayloadFromFailureCapsule,
  type CliFailureCapsule,
} from './liteTrustDemo.js';
import {
  createArmRegistry,
  createBabelCliChatHeadlessArmExecutor,
  type ArmExecutionRequest,
  type ArmExecutionResult,
} from './campaignExecutors.js';
import { createOpenCodeCliArmExecutor } from './campaignExecutors.opencode.js';
import {
  executionProfileForArm,
  harnessIdentityForArm,
  type ExecutionProfile,
  type HarnessIdentity,
} from './experimentIdentity.js';
import {
  applyDepPreflightEnv,
  packageHintFromRepo,
  runWorkspaceDepPreflight,
  type WorkspaceDepPreflightResult,
} from './workspaceDepPreflight.js';
import {
  createWorkspaceReadinessReceipt,
  createWorkspaceReadinessSigner,
  encodeWorkspaceReadinessReceipt,
} from './workspaceReadinessReceipt.js';
import {
  createVerifierOverlay,
  getHeadCommitChangedPaths,
  removeVerifierOverlay,
} from './verifierOverlay.js';
import {
  buildCampaignManifest,
  CAUSAL_STAGE1_ARMS,
  captureGitIdentity,
  findAttemptForTaskArm,
  hashFileSha256,
  loadCampaignManifest,
  seedQueuedAttempts,
  transitionAttempt,
  writeCampaignManifest,
  type CausalStage1Arm,
  type ExpectedAttempt,
} from './causalCampaignContract.js';
import { buildCellTelemetryBundle } from '../agent/chatEngineObservability.js';
import type { TurnRoutingReceipt } from '../agent/turnRoutingReceipt.js';
import { writeDerivedCampaignState } from './causalCampaignValidator.js';

export const SWE_PRO_CAMPAIGN_SCHEMA = 1 as const;

export interface SwebenchProInstanceRow extends SwebenchInstanceRow {
  test_patch?: string;
  repo_language?: string;
  requirements?: string;
  interface?: string;
  fail_to_pass?: string;
  pass_to_pass?: string;
  dockerhub_tag?: string;
  before_repo_set_cmd?: string;
  selected_test_files_to_run?: string;
  _babel_source?: string;
}

/**
 * Keep native Windows extension/DLL paths short while retaining a stable,
 * collision-resistant mapping from evidence identity to workspace directory.
 *
 * B1 (attempt-scoped isolation): when an arm/replicate pair is supplied, every
 * ExpectedAttempt maps to its OWN directory, so the existing
 * `existsSync → checkout` logic guarantees a fresh checkout per attempt
 * (test_patch baselines are committed into workspaces; a shared directory
 * would let attempt N inherit attempt N−1's diff). Backward compatible: no
 * arm/replicate args — or explicitly 'babel_enforce' × replicate 0 — keep the
 * historical bare name so legacy evidence-dir layouts and infra→live disk
 * reuse are unchanged.
 */
export function workspaceDirectoryName(
  instanceId: string,
  arm?: CausalStage1Arm,
  replicateId?: number,
): string {
  const prefix =
    instanceId
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .slice(0, 20) || 'instance';
  const digest = createHash('sha256').update(instanceId).digest('hex').slice(0, 16);
  const effArm = arm ?? 'babel_enforce';
  const effReplicate = replicateId ?? 0;
  if (effArm === 'babel_enforce' && effReplicate === 0) {
    return `${prefix}-${digest}`;
  }
  return `${prefix}-${digest}.${effArm}.r${effReplicate}`;
}

export type CampaignPhase = 'infra' | 'live';

/** How campaign `status=pass` is decided (default gold for continuity). */
export type SweProPassMode = 'gold' | 'ftp' | 'both';

/** W1 D: host fail_to_pass outcome class (not just ok/false). */
export type FailToPassClass =
  | 'pass'
  | 'assert_fail'
  | 'collect_error'
  | 'env_error'
  | 'timeout'
  | 'skipped'
  | 'unknown';

export interface CampaignCellResult {
  instance_id: string;
  phase: CampaignPhase;
  status: 'pass' | 'fail' | 'skipped';
  signature: string;
  notes: string[];
  patch_bytes: number;
  /** Semantic gold patch match (existing scoreboard). */
  gold_diff_ok: boolean | null;
  /**
   * W1.3: host ran bound fail_to_pass after agent (best-effort).
   * null = not run / skipped; true/false = pytest exit.
   */
  fail_to_pass_ok?: boolean | null;
  /** W1 D: collect_error vs assert_fail (do not treat collect as "code wrong"). */
  fail_to_pass_class?: FailToPassClass | null;
  policy_events: Array<{ at_turn?: number; kind?: string; detail?: string; tool?: string }>;
  has_shadow_summary: boolean;
  duration_ms: number;
  evidence_path: string;
  cli_exit_code?: number | null;
  status_text?: string | null;
  verifier_overlay?: {
    used: boolean;
    excluded_path_count: number;
    applied_file_count: number;
    reason: string | null;
  };
  /** Slice 2: effort / cost / boundary telemetry from chat-headless payload. */
  telemetry?: {
    effort: ReturnType<typeof buildCellTelemetryBundle>['effort'];
    cost: ReturnType<typeof buildCellTelemetryBundle>['cost'];
    boundary: ReturnType<typeof buildCellTelemetryBundle>['boundary'];
  };
  /**
   * Dual scoreboard: host FTP is product capability primary; gold is diagnostic only
   * (multi-file PR reference — never sole capability criterion).
   */
  scoreboard?: {
    host_fail_to_pass: boolean | null;
    gold_diagnostic: boolean | null;
    capability_primary: 'host_fail_to_pass';
    gold_role: 'diagnostic_only';
  };
  /**
   * In-session Babel authoritative verifier (allowlisted command only).
   * null = not run / non-authoritative; true/false = pass/fail.
   */
  babel_authoritative_verifier?: boolean | null;
  babel_authoritative_verifier_command?: string | null;
  /**
   * W2: experiment identity of the manifest attempt this cell executed
   * (live cells only; additive keys — see experimentIdentity.ts).
   */
  arm?: CausalStage1Arm;
  replicate_id?: number;
  arm_harness?: HarnessIdentity;
  execution_profile?: ExecutionProfile;
}

export interface CampaignAbort {
  reason: string;
  signature: string;
  streak: number;
  phase: CampaignPhase;
  cell_ids: string[];
}

export interface CampaignReport {
  schema_version: typeof SWE_PRO_CAMPAIGN_SCHEMA;
  kind: 'babel_swe_bench_pro_campaign';
  campaign_id: string;
  generated_at: string;
  provider: 'mock' | 'live';
  early_stop_n: number;
  /** W1.3 pass policy for cell.status (gold | ftp | both). */
  pass_mode: SweProPassMode;
  dataset_path: string;
  evidence_dir: string;
  cells: CampaignCellResult[];
  aborted: CampaignAbort | null;
  policy_events_jsonl: string;
  shadow_sessions_with_summary: number;
  summary_lines: string[];
}

export interface CampaignOptions {
  datasetPath: string;
  evidenceDir?: string;
  provider: 'mock' | 'live';
  earlyStopN?: number;
  instanceLimit?: number;
  instanceIds?: string[];
  model?: string;
  /** Agent subprocess timeout in milliseconds; 0 disables only this deadline. */
  agentTimeoutMs?: number;
  /** Host fail-to-pass verifier timeout in milliseconds; 0 disables only this deadline. */
  failToPassTimeoutMs?: number;
  /** Optional redacted progress file for detached long-running campaigns. */
  heartbeatFile?: string;
  /** When true, skip live agent even if provider=live (infra only). */
  infraOnly?: boolean;
  /** Pull docker image during infra for first K instances (default 0 = skip pull). */
  dockerPullFirstK?: number;
  /**
   * C2: workspace dep install preflight before the agent (default true).
   * Set false or env BABEL_SWE_PRO_DEP_PREFLIGHT=0 to skip.
   * When install fails / package still not importable → honest env_blocked cell
   * without multi-minute agent thrash.
   */
  depPreflight?: boolean;
  now?: Date;
  /** Inject for tests */
  runCell?: (instance: SwebenchProInstanceRow, phase: CampaignPhase) => CampaignCellResult;
  /**
   * Stage 1 causal arms to freeze in campaign-manifest.json.
   * Default: `['babel_enforce']` (reliability-only; not a complete causal design).
   * Placebo arms 'babel_shadow'/'babel_prompt_control' are REFUSED until their
   * runtime wiring lands (assertSelectableStage1Arms); pair with 'raw_opencode'
   * for the current two-arm design.
   */
  causalArms?: CausalStage1Arm[];
  /** Replicates per task×arm (default 1). */
  causalReplicates?: number;
  /**
   * W2: restrict live-phase execution to these arms (default undefined =
   * legacy behavior: single 'babel_enforce' × replicate 0 per instance).
   * Must be a subset of the arms frozen in campaign-manifest.json (causalArms).
   */
  arms?: CausalStage1Arm[];
  /** W2: cap replicates per task×arm (default undefined = legacy single replicate). */
  replicates?: number;
}

const DEFAULT_EARLY_STOP = 5;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const CHECKOUT_TIMEOUT_MS = 5 * 60 * 1000;
/** Outer kill must exceed product general_swe wall (10m) so the agent can finalize + flush policy-events. */
const AGENT_TIMEOUT_MS = 25 * 60 * 1000;
const FAIL_TO_PASS_TIMEOUT_MS = 180_000;

export interface SweProHeartbeat {
  schema_version: 1;
  campaign_id: string;
  pid: number;
  phase: CampaignPhase | 'starting' | 'complete';
  current_instance_id: string | null;
  started_at: string;
  last_progress_at: string;
  completed_cells: number;
  total_cells: number;
  evidence_files: number;
  last_error_class: string | null;
  process_state: 'running' | 'complete';
}

function validateNonNegativeTimeout(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function gitHeadForReceipt(repoRoot: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  return result.status === 0 && result.stdout?.trim() ? result.stdout.trim() : null;
}

function writeSweProHeartbeat(
  file: string | undefined,
  state: SweProHeartbeat,
): void {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function defaultSweProDatasetPath(): string {
  return join(BABEL_ROOT, 'benchmarks', 'datasets', 'swe-bench-pro', 'pilot-subset.jsonl');
}

export function resolveSweProDatasetPath(explicit?: string): string | null {
  if (explicit) {
    const r = resolve(explicit);
    return existsSync(r) ? r : null;
  }
  const fromEnv = process.env['SWEBENCH_PRO_DATASET_PATH'];
  if (fromEnv) {
    const r = resolve(fromEnv);
    return existsSync(r) ? r : null;
  }
  const fallback = defaultSweProDatasetPath();
  return existsSync(fallback) ? fallback : null;
}

export function loadSweProInstances(datasetPath: string): SwebenchProInstanceRow[] {
  const text = readFileSync(datasetPath, 'utf8');
  const rows: SwebenchProInstanceRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t) as SwebenchProInstanceRow);
  }
  return rows;
}

/** Normalize a finished cell into a stable early-stop signature. */
export function classifyCampaignFailureSignature(input: {
  phase: CampaignPhase;
  infraOk?: boolean;
  infraError?: string;
  cliExitCode?: number | null;
  /** Prefer CLI `status` (ENV_BLOCKED / BLOCKED / …). */
  statusText?: string | null;
  /**
   * Prefer CLI `terminal_outcome` (BLOCKED_EXTERNAL / BLOCKED_POLICY / …).
   * When present, outranks noisy stdout blob heuristics (Pri-3).
   */
  terminalOutcome?: string | null;
  /** Explicit payload.env_blocked when known. */
  envBlocked?: boolean | null;
  patchBytes?: number;
  goldDiffOk?: boolean | null;
  stdoutStderr?: string;
  missingApiKey?: boolean;
  /** W1 C/D: host fail_to_pass class when known. */
  failToPassClass?: FailToPassClass | null;
}): string {
  if (input.missingApiKey || /missing.?api.?key|DEEPSEEK_API_KEY/i.test(input.infraError ?? '')) {
    return 'infra:missing_api_key';
  }
  if (input.phase === 'infra') {
    if (input.infraOk) return 'infra:ok';
    const err = (input.infraError ?? '').toLowerCase();
    if (err.includes('docker') || err.includes('pull')) return 'infra:docker_pull_failed';
    if (err.includes('clone') || err.includes('checkout') || err.includes('git')) {
      return 'infra:checkout_failed';
    }
    return `infra:failed:${slug(input.infraError ?? 'unknown')}`;
  }

  const blob = input.stdoutStderr ?? '';
  const status = (input.statusText ?? '').trim();
  const terminal = (input.terminalOutcome ?? '').trim();

  if (/HTTP 402|positive balance|insufficient.?credit/i.test(blob)) {
    return 'agent:provider_error:billing';
  }
  if (/401|unauthorized|invalid.?api.?key|authentication/i.test(blob)) {
    return 'agent:provider_error:auth';
  }
  if (
    status === 'BUDGET_EXCEEDED' ||
    terminal === 'BUDGET_EXHAUSTED' ||
    /budget.?exceeded|harness_timeout|process timed out/i.test(blob)
  ) {
    // Distinguish outer harness timeout from in-agent cost ceiling when possible.
    if (/harness_timeout|process timed out after/i.test(blob)) {
      return 'agent:harness_timeout';
    }
    return 'agent:budget_exhausted';
  }

  // W1 C/D: production patch + collect-only fail → failed_with_evidence (not thrash/env).
  if (
    (input.patchBytes ?? 0) > 0 &&
    (input.failToPassClass === 'collect_error' ||
      terminal === 'AGENT_FAILURE' ||
      /verifier_collect|failed_with_evidence|collect_error/i.test(
        `${status}\n${terminal}\n${blob}`,
      ))
  ) {
    if (input.failToPassClass === 'collect_error') {
      return 'agent:verifier_collect_error';
    }
  }

  // Pri-3: structured fields first — do not let ImportError text in a
  // policy-killed transcript re-label investigate_hard_cap as env_blocked.
  if (input.envBlocked === true || status === 'ENV_BLOCKED') {
    return 'agent:env_blocked';
  }
  if (terminal === 'BLOCKED_POLICY' || status === 'BLOCKED_POLICY') {
    return 'agent:blocked_policy';
  }
  // W1 C: after a production patch, BLOCKED_EXTERNAL from collect soft-deps
  // is failed-with-evidence — not a pure env quarantine (hasAnyWrites path).
  if (
    terminal === 'BLOCKED_EXTERNAL' &&
    (input.patchBytes ?? 0) > 0 &&
    input.failToPassClass === 'collect_error'
  ) {
    return 'agent:verifier_collect_error';
  }
  if (terminal === 'BLOCKED_EXTERNAL') {
    // External without env_blocked flag → generic external (permission, etc.)
    return 'agent:blocked_external';
  }
  if (status === 'BLOCKED') {
    // Legacy generic BLOCKED: prefer policy unless blob is clearly env-only
    // and no policy markers — still require clear env signal in blob.
    // Never override an explicit envBlocked=false (in-agent policy may log
    // "env_blocked:" wording without host quarantine).
    if (
      input.envBlocked !== false &&
      /env_blocked|importerror|modulenotfound|while loading conftest/i.test(blob) &&
      !/investigate.?hard.?cap|zero.?write|blocked_policy|progress_terminal/i.test(blob)
    ) {
      return 'agent:env_blocked';
    }
    return 'agent:blocked_policy';
  }
  // Structured non-env terminals with zero production patch: empty_patch beats
  // blob "env_blocked" noise from progress-policy shadow logs (mock openlibrary).
  if (
    input.envBlocked === false &&
    (input.patchBytes ?? 0) === 0 &&
    (status === 'NEEDS_MORE_CONTEXT' ||
      terminal === 'AGENT_FAILURE' ||
      terminal === 'BLOCKED_EXTERNAL' ||
      terminal === 'BLOCKED_POLICY')
  ) {
    return 'agent:empty_patch';
  }
  // Blob heuristics only when structured status/outcome were absent AND
  // envBlocked was not explicitly false.
  if (
    input.envBlocked !== false &&
    !status &&
    !terminal &&
    /env_blocked|importerror|modulenotfound|while loading conftest/i.test(blob)
  ) {
    return 'agent:env_blocked';
  }
  if (status === 'NEEDS_MORE_CONTEXT' || /blocked_policy|BLOCKED_POLICY/i.test(blob)) {
    return 'agent:blocked_policy';
  }
  if ((input.patchBytes ?? 0) === 0 && input.goldDiffOk !== true) {
    if (input.cliExitCode !== 0 && input.cliExitCode != null) {
      return `agent:cli_nonzero:${input.cliExitCode}`;
    }
    return 'agent:empty_patch';
  }
  if (input.goldDiffOk === true) return 'agent:task_pass';
  if (input.cliExitCode !== 0 && input.cliExitCode != null) {
    return `agent:cli_nonzero:${input.cliExitCode}`;
  }
  return 'agent:task_fail';
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48) || 'unknown';
}

/**
 * Update consecutive failure streak. Returns abort info when threshold hit.
 */
export function updateFailureStreak(
  prev: { signature: string | null; count: number; cell_ids: string[] },
  cell: CampaignCellResult,
  earlyStopN: number,
  phase: CampaignPhase,
): { signature: string | null; count: number; cell_ids: string[]; abort: CampaignAbort | null } {
  if (cell.status === 'pass' || cell.signature.endsWith(':ok') || cell.signature === 'agent:task_pass') {
    return { signature: null, count: 0, cell_ids: [], abort: null };
  }
  const same = prev.signature === cell.signature;
  const signature = cell.signature;
  const count = same ? prev.count + 1 : 1;
  const cell_ids = same ? [...prev.cell_ids, cell.instance_id] : [cell.instance_id];
  if (count >= earlyStopN) {
    return {
      signature,
      count,
      cell_ids,
      abort: {
        reason: `early_stop: ${count} consecutive failures with signature ${signature}`,
        signature,
        streak: count,
        phase,
        cell_ids,
      },
    };
  }
  return { signature, count, cell_ids, abort: null };
}

export function liveApiKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env['DEEPSEEK_API_KEY']?.trim() ||
      env['DEEPINFRA_API_KEY']?.trim() ||
      env['OPENAI_API_KEY']?.trim(),
  );
}

function checkoutProRepo(instance: SwebenchProInstanceRow, repoRoot: string): void {
  if (existsSync(repoRoot)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  mkdirSync(dirname(repoRoot), { recursive: true });
  const url = `https://github.com/${instance.repo}.git`;
  let result = spawnSync('git', ['clone', '--filter=blob:none', url, repoRoot], {
    encoding: 'utf8',
    timeout: CLONE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git clone failed for ${instance.repo}: ${result.stderr || result.stdout}`);
  }
  result = spawnSync('git', ['checkout', instance.base_commit], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: CHECKOUT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `git checkout ${instance.base_commit} failed: ${result.stderr || result.stdout}`,
    );
  }
}

export interface TestPatchApplyResult {
  /** True when a non-empty test_patch was present. */
  attempted: boolean;
  /** True when git apply (or 3-way) succeeded. */
  applied: boolean;
  method: 'git_apply' | 'git_apply_3way' | 'none' | 'skip_empty';
  error?: string;
}

/**
 * W1.2 / H3: Apply instance `test_patch` into a checked-out workspace so
 * fail_to_pass tests exist on disk before the agent (and dep preflight collect).
 *
 * Does not hard-fail the campaign when apply fails — caller records notes.
 */
export function applyInstanceTestPatch(
  workspaceRoot: string,
  testPatch: string | undefined | null,
): TestPatchApplyResult {
  if (typeof testPatch !== 'string' || !testPatch.trim()) {
    return { attempted: false, applied: false, method: 'skip_empty' };
  }
  const markerPath = join(workspaceRoot, '.babel-swe-pro-test-patch.ok');
  // Reused campaign workspaces: skip re-apply when prior cell already applied.
  if (existsSync(markerPath)) {
    return { attempted: true, applied: true, method: 'git_apply' };
  }
  const patchPath = join(workspaceRoot, '.babel-swe-pro-test.patch');
  try {
    writeFileSync(patchPath, testPatch, 'utf8');
    const tryApply = (args: string[]): { ok: boolean; err: string } => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
      });
      if (result.status === 0) return { ok: true, err: '' };
      const err = `${result.stderr || ''}${result.stdout || ''}`.trim();
      return { ok: false, err: err.slice(0, 500) || `git apply exit ${result.status}` };
    };

    const first = tryApply(['apply', '--whitespace=nowarn', patchPath]);
    if (first.ok) {
      try {
        rmSync(patchPath, { force: true });
      } catch {
        /* ignore */
      }
      // Marker + commit so later captureGitPatch is agent-only (not gold pollution).
      writeFileSync(markerPath, 'ok\n', 'utf8');
      commitTestPatchBaseline(workspaceRoot);
      return { attempted: true, applied: true, method: 'git_apply' };
    }

    const second = tryApply(['apply', '--3way', '--whitespace=nowarn', patchPath]);
    try {
      rmSync(patchPath, { force: true });
    } catch {
      /* ignore */
    }
    if (second.ok) {
      writeFileSync(markerPath, 'ok\n', 'utf8');
      commitTestPatchBaseline(workspaceRoot);
      return { attempted: true, applied: true, method: 'git_apply_3way' };
    }
    return {
      attempted: true,
      applied: false,
      method: 'git_apply',
      error: second.err || first.err,
    };
  } catch (err) {
    return {
      attempted: true,
      applied: false,
      method: 'none',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Stage + commit applied test_patch so agent git-diff is production-only. */
function commitTestPatchBaseline(workspaceRoot: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Babel SWE-Pro',
    GIT_AUTHOR_EMAIL: 'babel-swe-pro@local',
    GIT_COMMITTER_NAME: 'Babel SWE-Pro',
    GIT_COMMITTER_EMAIL: 'babel-swe-pro@local',
  };
  spawnSync('git', ['add', '-A'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
  spawnSync(
    'git',
    ['commit', '--allow-empty', '-m', 'babel: apply instance test_patch (baseline)'],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      env,
    },
  );
}

/** Prefer selected_test_files, else fail_to_pass file path (node id stripped). */
export function resolveProTestPathHint(instance: SwebenchProInstanceRow): string | null {
  const selected = parseSweStringList(instance.selected_test_files_to_run);
  if (selected[0]) return selected[0]!;
  const ftp = parseSweStringList(instance.fail_to_pass);
  if (!ftp[0]) return null;
  const node = ftp[0]!;
  const idx = node.indexOf('::');
  return idx >= 0 ? node.slice(0, idx) : node;
}

function testPatchNotes(result: TestPatchApplyResult): string[] {
  if (!result.attempted) {
    return ['test_patch_applied=false', 'test_patch_reason=absent_or_empty'];
  }
  if (result.applied) {
    return [`test_patch_applied=true`, `test_patch_method=${result.method}`];
  }
  return [
    'test_patch_applied=false',
    `test_patch_method=${result.method}`,
    `test_patch_error=${(result.error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 200)}`,
  ];
}

/**
 * W1.3: pass_mode for live_pass / cell.status only.
 * Capability primary remains host fail_to_pass; gold is diagnostic (multi-file PR ref).
 * Default `gold` keeps historical scoreboard; canaries force `both`.
 * Set BABEL_SWE_PRO_PASS_MODE=ftp|both|gold to change cell.status aggregation.
 */
export function resolveSweProPassMode(
  env: NodeJS.ProcessEnv = process.env,
): SweProPassMode {
  const raw = (env['BABEL_SWE_PRO_PASS_MODE'] ?? 'gold').trim().toLowerCase();
  if (raw === 'ftp' || raw === 'fail_to_pass') return 'ftp';
  if (raw === 'both' || raw === 'gold+ftp') return 'both';
  return 'gold';
}

/**
 * cell.status aggregation only — does not redefine dual axes.
 * Prefer reporting host_fail_to_pass_ok and gold_diagnostic_ok separately.
 */
export function cellPassesByMode(
  goldDiffOk: boolean | null,
  failToPassOk: boolean | null | undefined,
  mode: SweProPassMode,
): boolean {
  const gold = goldDiffOk === true;
  const ftp = failToPassOk === true;
  if (mode === 'ftp') return ftp;
  if (mode === 'both') return gold && ftp;
  return gold;
}

export interface FailToPassCheckResult {
  ok: boolean | null;
  command: string | null;
  exitCode: number | null;
  skippedReason?: string;
  /** W1 D */
  failToPassClass: FailToPassClass;
  /** Captured stdout/stderr slice for classification. */
  outputSnippet?: string;
  /** Interpreter used (W1 B). */
  pythonBin?: string;
}

/**
 * Classify host fail_to_pass output. Pure — collect_error ≠ assert_fail (W1 D).
 */
export function classifyFailToPassResult(input: {
  exitCode: number | null;
  output?: string | null;
  skippedReason?: string | null;
}): FailToPassClass {
  if (input.skippedReason) {
    if (/timeout|signal_/i.test(input.skippedReason)) return 'timeout';
    if (/python_missing|disabled|no_fail_to_pass/i.test(input.skippedReason)) {
      return input.skippedReason === 'disabled' || input.skippedReason === 'no_fail_to_pass'
        ? 'skipped'
        : 'env_error';
    }
    return 'env_error';
  }
  if (input.exitCode === 0) return 'pass';
  const blob = (input.output ?? '').toLowerCase();
  if (
    /\bimporterror\b/.test(blob) ||
    /\bmodulenotfounderror\b/.test(blob) ||
    /\bwhile loading conftest\b/.test(blob) ||
    /\bno module named\b/.test(blob) ||
    /\berror collecting\b/.test(blob) ||
    /\bno tests ran\b/.test(blob) ||
    /\bcollected 0 items\b/.test(blob) ||
    // pytest exit 4 = usage error; often collect/import path failures
    (input.exitCode === 4 && blob.length > 0) ||
    input.exitCode === 5
  ) {
    // exit 5 = no tests collected; exit 4 with import noise = collect_error
    if (
      /\bimporterror\b/.test(blob) ||
      /\bmodulenotfounderror\b/.test(blob) ||
      /\bwhile loading conftest\b/.test(blob) ||
      /\bno module named\b/.test(blob) ||
      /\berror collecting\b/.test(blob) ||
      input.exitCode === 5 ||
      input.exitCode === 4
    ) {
      return 'collect_error';
    }
  }
  if (input.exitCode === 1) return 'assert_fail';
  if (input.exitCode == null) return 'unknown';
  return 'assert_fail';
}

/**
 * Best-effort host fail_to_pass after the agent. Does not throw.
 * Skip with BABEL_SWE_PRO_FTP_CHECK=0.
 * W1 B: prefer preflight pythonBin / BABEL_WORKSPACE_PYTHON over bare `python`.
 */
export function runFailToPassCheck(
  workspaceRoot: string,
  instance: SwebenchProInstanceRow,
  env: NodeJS.ProcessEnv = process.env,
  options?: { pythonBin?: string | null; timeoutMs?: number },
): FailToPassCheckResult {
  const disabled = (env['BABEL_SWE_PRO_FTP_CHECK'] ?? '1').trim() === '0';
  if (disabled) {
    return {
      ok: null,
      command: null,
      exitCode: null,
      skippedReason: 'disabled',
      failToPassClass: 'skipped',
    };
  }
  const targets = parseSweStringList(instance.fail_to_pass).slice(0, 5);
  if (targets.length === 0) {
    return {
      ok: null,
      command: null,
      exitCode: null,
      skippedReason: 'no_fail_to_pass',
      failToPassClass: 'skipped',
    };
  }
  const pythonBin =
    options?.pythonBin?.trim() ||
    env['BABEL_WORKSPACE_PYTHON']?.trim() ||
    (process.platform === 'win32' ? 'python' : 'python3');
  const command = `${pythonBin} -m pytest ${targets.join(' ')} -q --tb=short`;
  try {
    const timeoutMs = validateNonNegativeTimeout(
      'failToPassTimeoutMs',
      options?.timeoutMs ?? FAIL_TO_PASS_TIMEOUT_MS,
    );
    // Prefer argv form without shell so venv pythonBin paths with spaces work.
    const result = spawnSync(pythonBin, ['-m', 'pytest', ...targets, '-q', '--tb=short'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env,
      ...(timeoutMs === undefined || timeoutMs === 0 ? {} : { timeout: timeoutMs }),
      windowsHide: true,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          ok: null,
          command,
          exitCode: null,
          skippedReason: 'python_missing',
          failToPassClass: 'env_error',
          pythonBin,
          outputSnippet: result.error.message.slice(0, 300),
        };
      }
      return {
        ok: null,
        command,
        exitCode: null,
        skippedReason: result.error.message.slice(0, 120),
        failToPassClass: 'env_error',
        pythonBin,
      };
    }
    if (result.status === null && result.signal) {
      return {
        ok: false,
        command,
        exitCode: null,
        skippedReason: `signal_${result.signal}`,
        failToPassClass: 'timeout',
        pythonBin,
        outputSnippet: output.slice(0, 500),
      };
    }
    const exitCode = typeof result.status === 'number' ? result.status : null;
    const failToPassClass = classifyFailToPassResult({ exitCode, output });
    return {
      ok: exitCode === 0,
      command,
      exitCode,
      failToPassClass,
      pythonBin,
      outputSnippet: output.slice(0, 800),
    };
  } catch (err) {
    return {
      ok: null,
      command,
      exitCode: null,
      skippedReason: err instanceof Error ? err.message.slice(0, 120) : String(err),
      failToPassClass: 'env_error',
      pythonBin,
    };
  }
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
  return [unstaged.stdout ?? '', staged.stdout ?? ''].filter((p) => p.trim().length > 0).join('\n');
}

function dockerPullTag(tag: string): void {
  if (!tag.trim()) return;
  const image = tag.includes('/') ? tag : `jefzda/sweap-images:${tag}`;
  const result = spawnSync('docker', ['pull', image], {
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`docker pull failed for ${image}: ${result.stderr || result.stdout}`);
  }
}

function proPrompt(instance: SwebenchProInstanceRow): string {
  // Reuse Verified prompt builder; map fail_to_pass into extractable form.
  // parseSweStringList runs inside extractSweTestNames so Python-style lists
  // (`['path::test']`) never emit `pytest ['path` brackets (H4).
  const ftpClean = parseSweStringList(instance.fail_to_pass);
  const selectedClean = parseSweStringList(instance.selected_test_files_to_run);
  const asVerified: SwebenchInstanceRow = {
    instance_id: instance.instance_id,
    repo: instance.repo,
    base_commit: instance.base_commit,
    problem_statement: [
      instance.problem_statement,
      instance.requirements
        ? `\n\n## Requirements\n${String(instance.requirements).slice(0, 4000)}`
        : '',
      instance.interface
        ? `\n\n## Interface\n${String(instance.interface).slice(0, 3000)}`
        : '',
    ]
      .filter(Boolean)
      .join(''),
    patch: instance.patch,
    // Pass already-parsed arrays so prompt builder never re-stringifies brackets.
    fail_to_pass: ftpClean.length > 0 ? ftpClean : instance.fail_to_pass,
    selected_test_files_to_run:
      selectedClean.length > 0 ? selectedClean : instance.selected_test_files_to_run,
  } as SwebenchInstanceRow & {
    fail_to_pass?: string | string[];
    selected_test_files_to_run?: string | string[];
  };
  return buildSweIssuePrompt(asVerified);
}

function extractPolicyEvents(
  payload: Record<string, unknown> | null | undefined,
  workspaceRoot?: string,
): CampaignCellResult['policy_events'] {
  if (payload) {
    const raw = payload['policy_events'] ?? payload['policyEvents'];
    if (Array.isArray(raw) && raw.length > 0) {
      return raw as CampaignCellResult['policy_events'];
    }
    // Headless CLI JSON often omits policy_events; load session JSONL from run_dir.
    const runDir =
      typeof payload['run_dir'] === 'string'
        ? payload['run_dir']
        : typeof payload['runDir'] === 'string'
          ? payload['runDir']
          : null;
    if (runDir && existsSync(join(runDir, 'policy-events.jsonl'))) {
      return loadPolicyEventsJsonl(join(runDir, 'policy-events.jsonl'));
    }
  }
  // Timeout recovery: mid-loop flushes leave policy-events under recent chat-sessions
  // even when the synthetic failure payload has no run_dir.
  if (workspaceRoot) {
    const recovered = findRecentPolicyEventsForWorkspace(workspaceRoot);
    if (recovered.length > 0) return recovered;
  }
  return [];
}

const SHADOW_KIND_RE =
  /^(zero_write_shadow|force_mutate_shadow|read_thrash_shadow|exploration_shadow|stall_shadow_kill)$/;

/**
 * If the agent was hard-killed after mid-loop flush, synthesize a scoreboard
 * session boundary so would-kill sessions still count offline.
 */
export function ensureShadowSummaryForCampaign(
  events: CampaignCellResult['policy_events'],
  input: {
    patchBytes: number;
    goldDiffOk: boolean | null;
    terminalOutcome: string | null;
  },
): CampaignCellResult['policy_events'] {
  if (events.some((e) => e.kind === 'policy_shadow_summary')) return events;
  const shadows = events.filter((e) => typeof e.kind === 'string' && SHADOW_KIND_RE.test(e.kind));
  if (shadows.length === 0) return events;
  const laterProgressed = input.patchBytes > 0 ? 1 : 0;
  const laterSucceeded = input.goldDiffOk === true ? 1 : 0;
  const outcome = input.terminalOutcome ?? 'UNKNOWN';
  return [
    ...events,
    {
      kind: 'policy_shadow_summary',
      detail:
        `shadow_count=${shadows.length} later_succeeded=${laterSucceeded} ` +
        `later_progressed=${laterProgressed} mutation=${laterProgressed} ` +
        `coding_pass=${laterSucceeded} outcome=${outcome} source=campaign_synthetic`,
    },
  ];
}

/** Best-effort: newest chat-session under BABEL_RUNS_DIR with a non-empty policy log. */
function findRecentPolicyEventsForWorkspace(
  workspaceRoot: string,
): CampaignCellResult['policy_events'] {
  const sessionsRoot = join(BABEL_RUNS_DIR, 'chat-sessions');
  if (!existsSync(sessionsRoot)) return [];
  try {
    const dirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('chat-'))
      .map((d) => {
        const full = join(sessionsRoot, d.name);
        const pe = join(full, 'policy-events.jsonl');
        let mtime = 0;
        try {
          mtime = existsSync(pe) ? statSync(pe).mtimeMs : statSync(full).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { full, pe, mtime };
      })
      .filter((d) => existsSync(d.pe) && statSync(d.pe).size > 0)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 8);
    // Prefer a session whose thread/metadata mentions this workspace when possible.
    const needle = workspaceRoot.replace(/\\/g, '/').toLowerCase();
    for (const d of dirs) {
      try {
        const metaPath = join(d.full, 'metadata.json');
        if (existsSync(metaPath)) {
          const meta = readFileSync(metaPath, 'utf8').toLowerCase().replace(/\\/g, '/');
          if (meta.includes(needle) || meta.includes(workspaceRoot.toLowerCase())) {
            return loadPolicyEventsJsonl(d.pe);
          }
        }
      } catch {
        // continue
      }
    }
    // Fall back to most recent non-empty policy log (same campaign window).
    if (dirs[0]) return loadPolicyEventsJsonl(dirs[0].pe);
  } catch {
    return [];
  }
  return [];
}

/** Load PolicyEvent JSONL (one object per line). */
export function loadPolicyEventsJsonl(
  path: string,
): CampaignCellResult['policy_events'] {
  if (!existsSync(path)) return [];
  const events: CampaignCellResult['policy_events'] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t) as CampaignCellResult['policy_events'][number]);
    } catch {
      // skip bad lines
    }
  }
  return events;
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
  if (provider === 'live') {
    delete base['DEEPINFRA_API_KEY'];
    base['BABEL_BENCHMARK_DEEPSEEK_ONLY'] = '1';
    base['BABEL_COMPACTION_MODEL'] = 'deepseek-v4-flash';
  }
  return base;
}

function defaultRunInfraCell(
  instance: SwebenchProInstanceRow,
  evidenceDir: string,
  dockerPull: boolean,
): CampaignCellResult {
  const started = performance.now();
  const evidence_path = join(evidenceDir, 'infra', `${instance.instance_id}.json`);
  mkdirSync(dirname(evidence_path), { recursive: true });
  const notes: string[] = [];
  try {
    const workspaceRoot = join(evidenceDir, 'workspaces', workspaceDirectoryName(instance.instance_id));
    checkoutProRepo(instance, workspaceRoot);
    notes.push('checkout_ok');
    if (dockerPull && instance.dockerhub_tag && isDockerAvailable()) {
      dockerPullTag(instance.dockerhub_tag);
      notes.push('docker_pull_ok');
    } else if (dockerPull && !isDockerAvailable()) {
      notes.push('docker_unavailable_skip_pull');
    }
    const result: CampaignCellResult = {
      instance_id: instance.instance_id,
      phase: 'infra',
      status: 'pass',
      signature: 'infra:ok',
      notes,
      patch_bytes: 0,
      gold_diff_ok: null,
      policy_events: [],
      has_shadow_summary: false,
      duration_ms: Math.round(performance.now() - started),
      evidence_path,
    };
    writeFileSync(evidence_path, JSON.stringify(result, null, 2), 'utf8');
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const signature = classifyCampaignFailureSignature({
      phase: 'infra',
      infraOk: false,
      infraError: msg,
    });
    const result: CampaignCellResult = {
      instance_id: instance.instance_id,
      phase: 'infra',
      status: 'fail',
      signature,
      notes: [msg],
      patch_bytes: 0,
      gold_diff_ok: null,
      policy_events: [],
      has_shadow_summary: false,
      duration_ms: Math.round(performance.now() - started),
      evidence_path,
    };
    writeFileSync(evidence_path, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }
}

function depPreflightEnabled(optionsDepPreflight?: boolean): boolean {
  if (optionsDepPreflight === false) return false;
  if (optionsDepPreflight === true) return true;
  const env = process.env['BABEL_SWE_PRO_DEP_PREFLIGHT']?.trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off' || env === 'skip') return false;
  return true;
}

// ─── W2: arms × replicates execution helpers ─────────────────────────────────

type ArmExecutorRegistry = ReturnType<typeof createArmRegistry>;

/**
 * Live evidence file stem per attempt so multi-arm campaigns never collide on
 * `${instance_id}.*` files. Legacy continuity: 'babel_enforce' × replicate 0
 * keeps the historical bare instance_id stem.
 */
export function liveEvidenceStem(
  instanceId: string,
  arm: CausalStage1Arm,
  replicateId: number,
): string {
  return arm === 'babel_enforce' && replicateId === 0
    ? instanceId
    : `${instanceId}.${arm}.r${replicateId}`;
}

/**
 * B2: stage-1 placebo arms whose runtime wiring does not exist yet —
 * policy_mode / prompt_delta reach neither argv nor env, so selecting them
 * would launch byte-identical invocations while stamping false identity
 * claims ('shadow', diagnostic profiles, prompt_delta) into evidence.
 */
const UNBAKED_STAGE1_ARMS: readonly CausalStage1Arm[] = [
  'babel_shadow',
  'babel_prompt_control',
];

/**
 * Loud refusal over silent placebo runs: throws when any unbaked arm is
 * selected. 'babel_enforce' + 'raw_opencode' remain selectable together.
 */
export function assertSelectableStage1Arms(arms: readonly CausalStage1Arm[]): void {
  const unbaked = CAUSAL_STAGE1_ARMS.filter(
    (a) => UNBAKED_STAGE1_ARMS.includes(a) && arms.includes(a),
  );
  if (unbaked.length === 0) return;
  throw new Error(
    `Refusing to select unimplemented stage-1 arm(s): ${unbaked.map((a) => `'${a}'`).join(', ')}. ` +
      'Their runtime wiring is not implemented yet — policy_mode/prompt_delta reach neither argv nor env, ' +
      "so every attempt would silently execute the full product invocation while recording false placebo identities. " +
      "Selectable arms today: 'babel_enforce' and 'raw_opencode'. " +
      'Track wiring in docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md (W2 follow-up).',
  );
}

/** Additive cell-evidence keys derived from the manifest attempt being run. */
function experimentIdentityFields(exp: ExpectedAttempt): {
  arm: CausalStage1Arm;
  replicate_id: number;
  arm_harness: HarnessIdentity;
  execution_profile: ExecutionProfile;
} {
  return {
    arm: exp.arm,
    replicate_id: exp.replicate_id,
    arm_harness: harnessIdentityForArm(exp.arm),
    execution_profile: executionProfileForArm(exp.arm),
  };
}

/** Zero-cost honest skip cell for one selected attempt (infra-fail / mock raw). */
function skippedLiveCell(
  evidenceDir: string,
  instanceId: string,
  exp: ExpectedAttempt,
  signature: string,
  notes: string[],
): CampaignCellResult {
  return {
    instance_id: instanceId,
    phase: 'live',
    status: 'skipped',
    signature,
    notes,
    patch_bytes: 0,
    gold_diff_ok: null,
    policy_events: [],
    has_shadow_summary: false,
    duration_ms: 0,
    evidence_path: join(
      evidenceDir,
      'live',
      `${liveEvidenceStem(instanceId, exp.arm, exp.replicate_id)}.skipped.json`,
    ),
    ...experimentIdentityFields(exp),
  };
}

/** Attempt lifecycle transition that never throws mid-campaign. */
function terminalizeAttemptQuietly(
  evidenceDir: string,
  attemptId: string,
  next: Parameters<typeof transitionAttempt>[2],
): void {
  try {
    transitionAttempt(evidenceDir, attemptId, next);
  } catch {
    /* ignore illegal transition */
  }
}

/** Minimal CliInvocationResult-shaped view over an executor result. */
interface CompatCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown> | null;
  timedOut: boolean;
  failureCapsule?: CliFailureCapsule;
}

/**
 * Reconstruct the CLI result view from an ArmExecutionResult. Mirrors the
 * post-processing inside runBabelCli (liteTrustDemo.ts: payload recovery via
 * parseCliJson + failure capsule/synthetic payload on timeout or empty JSON)
 * so ALL downstream parsing in this file stays byte-for-byte identical.
 */
function compatCliFromExecResult(exec: ArmExecutionResult, timeoutMs: number): CompatCliResult {
  if (exec.launchError !== null) {
    const capsule = buildCliFailureCapsule({
      timedOut: false,
      timeoutMs,
      exitCode: 1,
      signal: null,
      errorName: 'LaunchError',
      errorMessage: exec.launchError,
      stdout: exec.stdout,
      stderr: exec.stderr || exec.launchError,
    });
    return {
      exitCode: exec.exitCode,
      stdout: exec.stdout,
      stderr: exec.stderr || exec.launchError,
      payload: syntheticPayloadFromFailureCapsule(capsule),
      timedOut: false,
      failureCapsule: capsule,
    };
  }
  let payload = parseCliJson(exec.stdout) ?? parseCliJson(exec.stderr);
  let failureCapsule: CliFailureCapsule | undefined;
  if (payload === null || exec.timedOut) {
    failureCapsule = buildCliFailureCapsule({
      timedOut: exec.timedOut,
      timeoutMs,
      exitCode: exec.exitCode ?? 1,
      // m1 fidelity: keep what the executor actually observed. Real process
      // signals are unknown through the ArmExecutor seam, so signal stays
      // honestly null; timeouts and launch errors are preserved.
      signal: null,
      errorName: exec.timedOut ? 'timeout' : null,
      errorMessage: exec.launchError ?? (exec.timedOut ? 'timeout' : null),
      stdout: exec.stdout,
      stderr: exec.stderr,
    });
    if (payload === null) {
      payload = syntheticPayloadFromFailureCapsule(failureCapsule);
    } else if (exec.timedOut && payload) {
      // Timed out but had JSON — stamp the class for scorers (runBabelCli parity).
      payload = {
        ...payload,
        failure_class_hint:
          typeof payload['failure_class_hint'] === 'string'
            ? payload['failure_class_hint']
            : 'harness_timeout',
        failure_capsule: failureCapsule,
        budget_exceeded: true,
      };
    }
  }
  return {
    exitCode: exec.exitCode,
    stdout: exec.stdout,
    stderr: exec.stderr,
    payload,
    timedOut: exec.timedOut,
    ...(failureCapsule ? { failureCapsule } : {}),
  };
}

/** Honest C2 terminal when workspace deps cannot be made ready. */
function envBlockedPreflightCell(
  instance: SwebenchProInstanceRow,
  evidenceDir: string,
  started: number,
  evidence_path: string,
  preflight: WorkspaceDepPreflightResult,
  extraNotes: string[] = [],
  fileStem: string = instance.instance_id,
): CampaignCellResult {
  const result: CampaignCellResult = {
    instance_id: instance.instance_id,
    phase: 'live',
    status: 'fail',
    signature: 'agent:env_blocked',
    notes: [
      ...extraNotes,
      'dep_preflight_blocked',
      `dep_ready=false`,
      `dep_installed=${preflight.installed}`,
      `dep_kind=${preflight.plan.kind}`,
      `dep_package=${preflight.plan.packageHint ?? 'null'}`,
      `dep_ms=${preflight.durationMs}`,
      `status=ENV_BLOCKED`,
      `terminal_outcome=ENV_BLOCKED`,
      `reason=${(preflight.reason ?? 'workspace deps not ready').slice(0, 240)}`,
      ...preflight.commands.map((c) => `dep_cmd=${c}`),
    ],
    patch_bytes: 0,
    gold_diff_ok: false,
    policy_events: [
      {
        at_turn: 0,
        kind: 'env_blocked',
        detail: `workspace_dep_preflight: ${preflight.reason ?? 'not ready'}`,
      },
    ],
    has_shadow_summary: false,
    duration_ms: Math.round(performance.now() - started),
    evidence_path,
    cli_exit_code: null,
    status_text: 'ENV_BLOCKED',
  };
  writeFileSync(
    evidence_path,
    JSON.stringify(
      {
        ...result,
        dep_preflight: preflight,
        preds: {
          model_name_or_path: 'babel-agent-chat',
          instance_id: instance.instance_id,
          model_patch: '',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(evidenceDir, 'live', `${fileStem}.patch`), '', 'utf8');
  return result;
}

/** Exported for harness-side verification seams (tests observe executor dispatch). */
export async function defaultRunLiveCell(
  instance: SwebenchProInstanceRow,
  evidenceDir: string,
  provider: 'mock' | 'live',
  model: string,
  options?: Pick<CampaignOptions, 'depPreflight' | 'agentTimeoutMs' | 'failToPassTimeoutMs'>,
  execCtx?: { registry: ArmExecutorRegistry; exp: ExpectedAttempt },
): Promise<CampaignCellResult> {
  const started = performance.now();
  const stem = execCtx
    ? liveEvidenceStem(instance.instance_id, execCtx.exp.arm, execCtx.exp.replicate_id)
    : instance.instance_id;
  const evidence_path = join(evidenceDir, 'live', `${stem}.json`);
  mkdirSync(dirname(evidence_path), { recursive: true });

  const arm = execCtx?.exp.arm ?? 'babel_enforce';
  const executor = execCtx?.registry.resolve(arm) ?? createBabelCliChatHeadlessArmExecutor();
  const preflightReq: ArmExecutionRequest = {
    arm,
    workspaceRoot: '',
    prompt: '',
    model,
    provider,
    env: process.env,
    timeoutMs: options?.agentTimeoutMs ?? AGENT_TIMEOUT_MS,
    cliEntry: resolveBabelCliEntry(),
    spawnCwd: join(BABEL_ROOT, 'babel-cli'),
  };
  const readiness = executor.preflight ? await executor.preflight(preflightReq) : { ready: true };
  if (!readiness.ready) {
    const isMockSkip = readiness.signature === 'live:skipped_mock_provider';
    const result: CampaignCellResult = {
      instance_id: instance.instance_id,
      phase: 'live',
      status: isMockSkip ? 'skipped' : 'fail',
      signature: readiness.signature ?? 'infra:missing_api_key',
      notes: [readiness.reason ?? 'Executor preflight check failed'],
      patch_bytes: 0,
      gold_diff_ok: null,
      policy_events: [],
      has_shadow_summary: false,
      duration_ms: Math.round(performance.now() - started),
      evidence_path,
      ...(execCtx ? experimentIdentityFields(execCtx.exp) : {}),
    };
    writeFileSync(evidence_path, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }

  const workspaceRoot = join(
    evidenceDir,
    'workspaces',
    // B1: attempt-scoped key — distinct (arm, replicate) ⇒ distinct fresh
    // checkout; legacy babel_enforce×r0 keeps the historical bare name.
    workspaceDirectoryName(instance.instance_id, execCtx?.exp.arm, execCtx?.exp.replicate_id),
  );
  try {
    if (!existsSync(workspaceRoot)) {
      checkoutProRepo(instance, workspaceRoot);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const result: CampaignCellResult = {
      instance_id: instance.instance_id,
      phase: 'live',
      status: 'fail',
      signature: classifyCampaignFailureSignature({
        phase: 'infra',
        infraOk: false,
        infraError: msg,
      }),
      notes: [msg],
      patch_bytes: 0,
      gold_diff_ok: null,
      policy_events: [],
      has_shadow_summary: false,
      duration_ms: Math.round(performance.now() - started),
      evidence_path,
    };
    writeFileSync(evidence_path, JSON.stringify(result, null, 2), 'utf8');
    return result;
  }

  // W1.2 / H3: apply test_patch before dep preflight + agent so fail_to_pass is collectable.
  const testPatchResult = applyInstanceTestPatch(workspaceRoot, instance.test_patch);
  const patchNotes = testPatchNotes(testPatchResult);

  // C2: install workspace deps (or honest ENV_BLOCKED) before burning agent wall/cost.
  let depNotes: string[] = [];
  let depEnvPatch: WorkspaceDepPreflightResult | null = null;
  const verifierTestPath = resolveProTestPathHint(instance);
  if (depPreflightEnabled(options?.depPreflight)) {
    const preflight = runWorkspaceDepPreflight({
      workspaceRoot,
      packageHint: packageHintFromRepo(instance.repo),
      testPath: verifierTestPath,
      install: true,
      // typing.Required and modern packaging — refuse host Python 3.10 venvs.
      minPython: { major: 3, minor: 11 },
    });
    depEnvPatch = preflight;
    depNotes = [
      `dep_preflight=1`,
      `dep_ready=${preflight.ready}`,
      `dep_installed=${preflight.installed}`,
      `dep_kind=${preflight.plan.kind}`,
      `dep_package=${preflight.plan.packageHint ?? 'null'}`,
      `dep_python=${preflight.pythonBin ?? 'null'}`,
      `dep_ms=${preflight.durationMs}`,
      ...(preflight.softDepsAttempted
        ? [
            `soft_deps_attempted=true`,
            `soft_deps_installed=${(preflight.softDepsInstalled ?? []).join('|') || 'none'}`,
          ]
        : []),
    ];
    if (preflight.blocked || !preflight.ready) {
      return envBlockedPreflightCell(
        instance,
        evidenceDir,
        started,
        evidence_path,
        preflight,
        patchNotes,
        stem,
      );
    }
  } else {
    depNotes = ['dep_preflight=0'];
  }

  ensureBabelCliDistReady();
  const prompt = proPrompt(instance);
  // Product general_swe budgets only — do not inflate turns/cost for "benchmark max".
  // Allow operator env to raise caps; strip harness-only MAX_TURNS default of 250
  // when unset so chatTaskClass general_swe (250/3.0/10min) is the sole source of truth.
  const baseEnv = benchmarkBabelEnv(provider);
  let productEnv = buildSweAgentChatEnv(baseEnv);
  if (depEnvPatch) {
    productEnv = applyDepPreflightEnv(productEnv, depEnvPatch);
  }
  // W0: provider calls are allowed only after a redacted, signed readiness
  // receipt has been created from the completed local preflight. The private
  // signing key remains in this parent process; only the public key and
  // encoded receipt cross into the CLI subprocess.
  const readinessSigner = createWorkspaceReadinessSigner();
  const readinessReceipt = createWorkspaceReadinessReceipt(
    {
      workspaceRoot,
      gitHead: gitHeadForReceipt(workspaceRoot),
      testPath: verifierTestPath,
      verifierCommand: verifierTestPath
        ? `python -m pytest ${verifierTestPath} -q --tb=short`
        : null,
      dependencyReady: depEnvPatch?.ready === true,
      pythonExecutableValid: depEnvPatch?.pythonExecutableValid ?? null,
      collectionReady: depEnvPatch ? depEnvPatch.ready : false,
      testPatchApplied: testPatchResult.applied,
      verifierAuthority: verifierTestPath || testPatchResult.applied ? 'dataset_bound' : 'project_bound',
    },
    readinessSigner,
  );
  productEnv = {
    ...productEnv,
    BABEL_REQUIRE_WORKSPACE_READINESS: '1',
    BABEL_WORKSPACE_READINESS_RECEIPT: encodeWorkspaceReadinessReceipt(readinessReceipt),
    BABEL_WORKSPACE_READINESS_PUBLIC_KEY: readinessSigner.publicKeyBase64,
  };
  // Prefer product stall tune over harness stall=25 unless operator set it.
  if (!process.env['BABEL_CHAT_STALL_TURNS']?.trim()) {
    delete productEnv['BABEL_CHAT_STALL_TURNS'];
  }
  if (!process.env['BABEL_CHAT_MAX_TURNS']?.trim()) {
    delete productEnv['BABEL_CHAT_MAX_TURNS'];
  }
  // Never auto-raise cost for Pro campaign (no BABEL_CHAT_MAX_COST injection).
  delete productEnv['BABEL_CHAT_MAX_COST'];

  // ── W2 executor seam: every arm launches through an ArmExecutor ────────────
  // COMPARABILITY INVARIANT: for babel arms the wrapped invocation MUST stay
  // byte-identical to the pre-seam direct call in this file — args
  // ['run','--mode','chat-headless',('--model',model)?,'--json','--yes','--project-root',workspaceRoot,prompt]
  // plus identical env/productEnv, cwd=join(BABEL_ROOT,'babel-cli'),
  // cliEntry, and timeout handling. createBabelCliChatHeadlessArmExecutor
  // reproduces exactly that argv/env contract; do not change either side alone.
  if (!executor || !execCtx) {
    // Consistent failure handling: honest env-blocked cell without agent run.
    const failed: CampaignCellResult = {
      instance_id: instance.instance_id,
      phase: 'live',
      status: 'fail',
      signature: 'agent:env_blocked',
      notes: [`no_executor_registered_for_arm=${arm}`],
      patch_bytes: 0,
      gold_diff_ok: false,
      policy_events: [
        { kind: 'env_blocked', detail: `no executor registered for arm ${arm}` },
      ],
      has_shadow_summary: false,
      duration_ms: Math.round(performance.now() - started),
      evidence_path,
      cli_exit_code: null,
      status_text: 'ENV_BLOCKED',
      ...(execCtx ? experimentIdentityFields(execCtx.exp) : {}),
    };
    writeFileSync(evidence_path, JSON.stringify(failed, null, 2), 'utf8');
    writeFileSync(join(evidenceDir, 'live', `${stem}.patch`), '', 'utf8');
    return failed;
  }
  const exec = await executor.execute({
    arm,
    workspaceRoot,
    prompt,
    model,
    provider,
    env: productEnv,
    timeoutMs: options?.agentTimeoutMs ?? AGENT_TIMEOUT_MS,
    cliEntry: resolveBabelCliEntry(),
    spawnCwd: join(BABEL_ROOT, 'babel-cli'),
  });
  const cli = compatCliFromExecResult(
    exec,
    options?.agentTimeoutMs ?? AGENT_TIMEOUT_MS,
  );

  const agentPatch = captureGitPatch(workspaceRoot);

  // W0: verify in a clean detached overlay. The test_patch baseline remains
  // committed in the agent workspace; its changed paths plus the selected
  // verifier file are excluded from the agent production diff.
  const protectedVerifierPaths = [
    ...(testPatchResult.applied ? getHeadCommitChangedPaths(workspaceRoot) : []),
    ...(verifierTestPath ? [verifierTestPath] : []),
  ];
  const verifierOverlay = createVerifierOverlay({
    agentRoot: workspaceRoot,
    overlayRoot: join(evidenceDir, 'verifier-overlays', instance.instance_id),
    protectedPaths: protectedVerifierPaths,
  });
  let patch = agentPatch;
  let ftpCheck: ReturnType<typeof runFailToPassCheck>;
  if (verifierOverlay.ok && verifierOverlay.root) {
    patch = captureGitPatch(verifierOverlay.root);
    ftpCheck = runFailToPassCheck(verifierOverlay.root, instance, productEnv, {
      pythonBin: depEnvPatch?.pythonBin ?? productEnv['BABEL_WORKSPACE_PYTHON'] ?? null,
      ...(options?.failToPassTimeoutMs !== undefined
        ? { timeoutMs: options.failToPassTimeoutMs }
        : {}),
    });
  } else {
    ftpCheck = {
      ok: null,
      command: null,
      exitCode: null,
      skippedReason: `verifier_overlay_${verifierOverlay.reason ?? 'unavailable'}`,
      failToPassClass: 'env_error',
    };
  }
  removeVerifierOverlay(workspaceRoot, verifierOverlay.root);

  const gold = instance.patch ?? '';
  let gold_diff_ok: boolean | null = null;
  if (patch.trim() && gold.trim()) {
    gold_diff_ok = patchesMatchSemantically(patch, gold);
  } else if (!patch.trim()) {
    gold_diff_ok = false;
  }

  // W1.3/B/D: dual scoreboard + venv interpreter + collect vs assert class.
  const fail_to_pass_ok = ftpCheck.ok;
  const fail_to_pass_class = ftpCheck.failToPassClass;
  const passMode = resolveSweProPassMode();

  const payload = cli.payload as Record<string, unknown> | null;
  // Persist failure capsule when CLI timed out / had no real JSON (ansible pilot).
  if (cli.failureCapsule) {
    writeFileSync(
      join(evidenceDir, 'live', `${stem}.failure-capsule.json`),
      JSON.stringify(cli.failureCapsule, null, 2),
      'utf8',
    );
  }
  const statusText =
    typeof payload?.['status'] === 'string' ? (payload['status'] as string) : null;
  // Prefer structured terminal_outcome (Pri-3); keep status separate.
  let terminalOutcome =
    typeof payload?.['terminal_outcome'] === 'string'
      ? (payload['terminal_outcome'] as string)
      : null;
  // W1 C: production patch + host collect_error → failed-with-evidence terminal class.
  if (
    patch.length > 0 &&
    fail_to_pass_class === 'collect_error' &&
    (terminalOutcome === 'BLOCKED_EXTERNAL' ||
      terminalOutcome === 'BLOCKED_POLICY' ||
      !terminalOutcome)
  ) {
    terminalOutcome = 'AGENT_FAILURE';
  }
  const envBlockedFlag =
    payload?.['env_blocked'] === true || statusText === 'ENV_BLOCKED';
  // Do not treat collect_error after patch as env_blocked for scoreboard.
  const envBlockedForSig =
    envBlockedFlag && !(patch.length > 0 && fail_to_pass_class === 'collect_error');
  const streamBlob = `${cli.stdout ?? ''}\n${cli.stderr ?? ''}`;
  const signature = classifyCampaignFailureSignature({
    phase: 'live',
    cliExitCode: cli.exitCode,
    statusText,
    terminalOutcome: terminalOutcome ?? statusText,
    envBlocked: envBlockedForSig,
    patchBytes: patch.length,
    goldDiffOk: gold_diff_ok,
    failToPassClass: fail_to_pass_class,
    stdoutStderr:
      cli.timedOut || cli.failureCapsule?.timed_out
        ? `harness_timeout process timed out after\n${streamBlob}`
        : streamBlob,
  });
  // Pass mode controls cell.status only; always report both gold_diff and fail_to_pass.
  // Do not OR with agent:task_pass (gold-derived) — that would break pass_mode=ftp|both.
  // W1 D: collect_error must not count as ftp pass for pass_mode=ftp|both (already false).
  const modePass = cellPassesByMode(gold_diff_ok, fail_to_pass_ok, passMode);
  const status: CampaignCellResult['status'] = modePass ? 'pass' : 'fail';

  const runDir =
    typeof payload?.['run_dir'] === 'string' ? (payload['run_dir'] as string) : null;

  let policy_events = extractPolicyEvents(payload, workspaceRoot);
  policy_events = ensureShadowSummaryForCampaign(policy_events, {
    patchBytes: patch.length,
    goldDiffOk: gold_diff_ok,
    terminalOutcome: terminalOutcome ?? signature,
  });
  const has_shadow_summary = policy_events.some((e) => e.kind === 'policy_shadow_summary');

  // Slice 2: cell effort/cost/boundary from chat-headless turnRouting + policy/tools
  const turnRoutingRaw = payload?.['turnRouting'] ?? payload?.['turn_routing'];
  const turnRouting: TurnRoutingReceipt[] = Array.isArray(turnRoutingRaw)
    ? (turnRoutingRaw as TurnRoutingReceipt[])
    : [];
  const toolCallsRaw = payload?.['toolCalls'] ?? payload?.['tool_calls'];
  const toolCalls = Array.isArray(toolCallsRaw)
    ? (toolCallsRaw as Array<{
        tool?: string;
        error?: string;
        exit_code?: number;
        index?: number;
        turn?: number;
      }>)
    : [];
  // Rebuild logIndexToTurn from tool.turn when present (headless export)
  const logIndexToTurn = new Map<number, number>();
  for (let i = 0; i < toolCalls.length; i += 1) {
    const tc = toolCalls[i]!;
    if (typeof tc.turn === 'number') {
      logIndexToTurn.set(typeof tc.index === 'number' ? tc.index : i, tc.turn);
    }
  }
  const telemetry = buildCellTelemetryBundle({
    turnRouting,
    policyEvents: policy_events,
    toolCalls,
    ...(logIndexToTurn.size > 0 ? { logIndexToTurn } : {}),
  });

  // In-session Babel authoritative verifier (allowlisted only)
  const completionVerification = payload?.['completion_verification'] as
    | {
        status?: string;
        authority?: boolean | null;
        verification?: { command?: string; exit_code?: number } | null;
      }
    | undefined;
  const verifierReceiptPayload = payload?.['verifier_receipt'] as
    | { command?: string; exit_code?: number }
    | undefined;
  let babel_authoritative_verifier: boolean | null = null;
  let babel_authoritative_verifier_command: string | null = null;
  if (completionVerification && completionVerification.authority === true) {
    babel_authoritative_verifier = completionVerification.status === 'pass';
    babel_authoritative_verifier_command =
      completionVerification.verification?.command ??
      verifierReceiptPayload?.command ??
      null;
  } else if (
    completionVerification &&
    completionVerification.authority === false &&
    completionVerification.verification?.command
  ) {
    // Explicit non-authoritative receipt → not_run for capability axis
    babel_authoritative_verifier = null;
    babel_authoritative_verifier_command = completionVerification.verification.command;
  }

  const scoreboard = {
    host_fail_to_pass: fail_to_pass_ok ?? null,
    gold_diagnostic: gold_diff_ok,
    capability_primary: 'host_fail_to_pass' as const,
    gold_role: 'diagnostic_only' as const,
  };

  const ftpNotes: string[] = [
    `pass_mode=${passMode}`,
    `fail_to_pass_ok=${fail_to_pass_ok === null || fail_to_pass_ok === undefined ? 'null' : fail_to_pass_ok}`,
    `fail_to_pass_class=${fail_to_pass_class}`,
    `gold_diagnostic=${gold_diff_ok} (not capability sole criterion)`,
    `capability_primary=host_fail_to_pass`,
    `babel_authoritative_verifier=${babel_authoritative_verifier === null ? 'not_run' : babel_authoritative_verifier}`,
    ...(babel_authoritative_verifier_command
      ? [`babel_authoritative_cmd=${babel_authoritative_verifier_command.slice(0, 160)}`]
      : []),
    `turns_to_first_write=${telemetry.boundary.turns_to_first_applied_write ?? 'null'}`,
    `verifier_overlay=${verifierOverlay.ok}`,
    `verifier_overlay_excluded=${verifierOverlay.excludedPaths.length}`,
    `verifier_overlay_files=${verifierOverlay.appliedFiles.length}`,
    ...(verifierOverlay.reason ? [`verifier_overlay_reason=${verifierOverlay.reason}`] : []),
    'readiness_receipt=signed',
  ];
  if (ftpCheck.pythonBin) ftpNotes.push(`fail_to_pass_python=${ftpCheck.pythonBin}`);
  if (ftpCheck.command) ftpNotes.push(`fail_to_pass_cmd=${ftpCheck.command.slice(0, 240)}`);
  if (ftpCheck.exitCode !== null && ftpCheck.exitCode !== undefined) {
    ftpNotes.push(`fail_to_pass_exit=${ftpCheck.exitCode}`);
  }
  if (ftpCheck.skippedReason) ftpNotes.push(`fail_to_pass_skip=${ftpCheck.skippedReason}`);
  if (gold_diff_ok === false && fail_to_pass_ok === true) {
    ftpNotes.push('gold_ftp_gap=true (host FTP pass; gold multi-file PR mismatch is diagnostic)');
  }

  const result: CampaignCellResult = {
    instance_id: instance.instance_id,
    phase: 'live',
    status,
    signature,
    notes: [
      ...patchNotes,
      ...depNotes,
      ...ftpNotes,
      `cli_exit=${cli.exitCode}`,
      `status=${statusText ?? 'null'}`,
      `terminal_outcome=${terminalOutcome ?? 'null'}`,
      `env_blocked=${envBlockedFlag}`,
      `patch_bytes=${patch.length}`,
      `gold_diff=${gold_diff_ok}`,
      `policy_events=${policy_events.length}`,
      `shadow_summary=${has_shadow_summary}`,
      `effort_aliased=${telemetry.effort.effort_aliased}`,
      `effort_source=${telemetry.effort.effective_source}`,
      `cost_est_usd=${telemetry.cost.estimated_usd}`,
      `boundary_writes=${telemetry.boundary.successful_write_tool_count}`,
      `boundary_force_mutate=${telemetry.boundary.force_mutate_count + telemetry.boundary.force_mutate_shadow_count}`,
      ...(runDir ? [`run_dir=${runDir}`] : []),
    ],
    patch_bytes: patch.length,
    gold_diff_ok,
    fail_to_pass_ok: fail_to_pass_ok ?? null,
    fail_to_pass_class,
    policy_events,
    has_shadow_summary,
    duration_ms: Math.round(performance.now() - started),
    evidence_path,
    cli_exit_code: cli.exitCode,
    status_text: statusText,
    verifier_overlay: {
      used: verifierOverlay.ok,
      excluded_path_count: verifierOverlay.excludedPaths.length,
      applied_file_count: verifierOverlay.appliedFiles.length,
      reason: verifierOverlay.reason,
    },
    telemetry,
    scoreboard,
    babel_authoritative_verifier,
    babel_authoritative_verifier_command,
    ...(execCtx ? experimentIdentityFields(execCtx.exp) : {}),
  };

  writeFileSync(
    evidence_path,
    JSON.stringify(
      {
        ...result,
        test_patch_applied: testPatchResult.applied,
        test_patch_attempted: testPatchResult.attempted,
        test_patch_method: testPatchResult.method,
        ...(testPatchResult.error ? { test_patch_error: testPatchResult.error } : {}),
        fail_to_pass_check: ftpCheck,
        dep_preflight: depEnvPatch,
        readiness_receipt: readinessReceipt,
        verifier_overlay: {
          used: verifierOverlay.ok,
          excluded_path_count: verifierOverlay.excludedPaths.length,
          applied_file_count: verifierOverlay.appliedFiles.length,
          reason: verifierOverlay.reason,
        },
        preds: {
          model_name_or_path: 'babel-agent-chat',
          instance_id: instance.instance_id,
          model_patch: patch,
        },
        cli_payload: payload,
        run_dir: runDir,
      },
      null,
      2,
    ),
    'utf8',
  );

  // Copy session policy log into campaign evidence for offline scoreboard
  if (runDir && existsSync(join(runDir, 'policy-events.jsonl'))) {
    writeFileSync(
      join(evidenceDir, 'live', `${stem}.policy-events.jsonl`),
      readFileSync(join(runDir, 'policy-events.jsonl'), 'utf8'),
      'utf8',
    );
  }

  // Also drop patch alone for Pro gather_patches compatibility
  writeFileSync(
    join(evidenceDir, 'live', `${stem}.patch`),
    patch,
    'utf8',
  );

  return result;
}

/**
 * Run infra phase then live phase with early-stop on consecutive same-signature failures.
 */
export async function runSwebenchProCampaign(
  options: CampaignOptions,
): Promise<CampaignReport> {
  validateNonNegativeTimeout('agentTimeoutMs', options.agentTimeoutMs);
  validateNonNegativeTimeout('failToPassTimeoutMs', options.failToPassTimeoutMs);
  const earlyStopN = options.earlyStopN ?? DEFAULT_EARLY_STOP;
  const datasetPath = resolve(options.datasetPath);
  if (!existsSync(datasetPath)) {
    throw new Error(`SWE-Bench Pro dataset missing: ${datasetPath}`);
  }
  // B2 honesty gate: refuse placebo arms BEFORE any evidence artifact exists.
  // Checked on both selection surfaces — frozen denominator (causalArms) and
  // executed subset (arms) — so no manifest can freeze attempts that could
  // only ever run as byte-identical placebos.
  if (options.causalArms?.length) assertSelectableStage1Arms(options.causalArms);
  if (options.arms?.length) assertSelectableStage1Arms(options.arms);

  const campaign_id =
    (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19) +
    (options.provider === 'live' ? '-live' : '-mock');
  const evidenceDir =
    options.evidenceDir ??
    join(BABEL_RUNS_DIR, 'agent-benchmark', 'swe-pro', campaign_id);
  mkdirSync(evidenceDir, { recursive: true });

  let instances = loadSweProInstances(datasetPath);
  if (options.instanceIds?.length) {
    const want = new Set(options.instanceIds);
    instances = instances.filter((i) => want.has(i.instance_id));
  }
  if (options.instanceLimit != null && options.instanceLimit > 0) {
    instances = instances.slice(0, options.instanceLimit);
  }

  // ── Frozen Stage 1 denominator (immutable manifest + queued attempts) ─────
  // Written BEFORE any cell runs so crash mid-campaign cannot erase expected set.
  const gitId = captureGitIdentity(BABEL_ROOT);
  const causalArms: CausalStage1Arm[] = options.causalArms?.length
    ? options.causalArms
    : ['babel_enforce'];
  const causalManifest = buildCampaignManifest({
    campaignId: campaign_id,
    createdAt: (options.now ?? new Date()).toISOString(),
    taskIds: instances.map((i) => i.instance_id),
    arms: causalArms,
    replicates: options.causalReplicates ?? 1,
    identity: {
      babel_commit: gitId.babel_commit,
      babel_branch: gitId.babel_branch,
      dirty_digest: gitId.dirty_digest,
      project_root: BABEL_ROOT,
      canonical_remote: gitId.canonical_remote,
      dataset_path: datasetPath,
      dataset_sha256: hashFileSha256(datasetPath),
      model: options.provider === 'live' ? (options.model ?? 'deepseek-v4-flash') : null,
      provider: options.provider,
    },
  });
  writeCampaignManifest(evidenceDir, causalManifest);
  seedQueuedAttempts(evidenceDir, causalManifest, options.now);

  // ── W2: one ArmExecutor registry per campaign run ──────────────────────────
  // Babel chat-headless executor serves all babel_* arms; the raw OpenCode CLI
  // executor serves the external baseline arm. Executors own launch/capture
  // only; workspace prep and verification remain in this harness.
  const armRegistry = createArmRegistry();
  armRegistry.register(createBabelCliChatHeadlessArmExecutor());
  armRegistry.register(createOpenCodeCliArmExecutor());

  const cells: CampaignCellResult[] = [];
  let aborted: CampaignAbort | null = null;
  const policyJsonlPath = join(evidenceDir, 'policy-events.jsonl');
  writeFileSync(policyJsonlPath, '', 'utf8');
  const startedAt = new Date().toISOString();

  // W2 attempt selection. Default (arms/replicates undefined) preserves legacy
  // single-attempt runs exactly: 'babel_enforce' × replicate 0 per instance.
  const requestedArms = options.arms;
  const replicateCap = options.replicates;
  const selectedAttemptsForInstance = (instanceId: string): ExpectedAttempt[] =>
    causalManifest.expected_attempts.filter(
      (exp) =>
        exp.task_id === instanceId &&
        (requestedArms === undefined
          ? exp.arm === 'babel_enforce' && exp.replicate_id === 0
          : requestedArms.includes(exp.arm)) &&
        (replicateCap === undefined ? true : exp.replicate_id < replicateCap),
    );
  const totalLiveCells = instances.reduce(
    (n, i) => n + selectedAttemptsForInstance(i.instance_id).length,
    0,
  );

  const heartbeat = (phase: SweProHeartbeat['phase'], instance: string | null, error: string | null = null) => {
    const evidenceFiles = ['infra', 'live']
      .map((part) => {
        try {
          return readdirSync(join(evidenceDir, part)).length;
        } catch {
          return 0;
        }
      })
      .reduce((sum, count) => sum + count, 0);
    writeSweProHeartbeat(options.heartbeatFile, {
      schema_version: 1,
      campaign_id,
      pid: process.pid,
      phase,
      current_instance_id: instance,
      started_at: startedAt,
      last_progress_at: new Date().toISOString(),
      completed_cells: cells.length,
      total_cells: options.infraOnly
        ? instances.length
        : instances.length + totalLiveCells,
      evidence_files: evidenceFiles,
      last_error_class: error,
      process_state: phase === 'complete' ? 'complete' : 'running',
    });
  };
  heartbeat('starting', null);

  const liveCellOptions =
    options.depPreflight === undefined
      ? {
          ...(options.agentTimeoutMs !== undefined
            ? { agentTimeoutMs: options.agentTimeoutMs }
            : {}),
          ...(options.failToPassTimeoutMs !== undefined
            ? { failToPassTimeoutMs: options.failToPassTimeoutMs }
            : {}),
        }
      : {
          depPreflight: options.depPreflight,
          ...(options.agentTimeoutMs !== undefined
            ? { agentTimeoutMs: options.agentTimeoutMs }
            : {}),
          ...(options.failToPassTimeoutMs !== undefined
            ? { failToPassTimeoutMs: options.failToPassTimeoutMs }
            : {}),
        };
  const runInfraCell = (instance: SwebenchProInstanceRow): CampaignCellResult => {
    if (options.runCell) return options.runCell(instance, 'infra');
    const idx = instances.findIndex((i) => i.instance_id === instance.instance_id);
    const pull =
      (options.dockerPullFirstK ?? 0) > 0 && idx >= 0 && idx < (options.dockerPullFirstK ?? 0);
    return defaultRunInfraCell(instance, evidenceDir, pull);
  };
  // W2: one cell per (arm, replicate_id); lifecycle transitions target that
  // attempt. Injected runCell fixtures stay arm-agnostic and are stamped here.
  const runLiveAttempt = async (
    instance: SwebenchProInstanceRow,
    exp: ExpectedAttempt,
  ): Promise<CampaignCellResult> => {
    const base = options.runCell
      ? options.runCell(instance, 'live')
      : await defaultRunLiveCell(
          instance,
          evidenceDir,
          options.provider,
          options.model ?? 'deepseek-v4-flash',
          liveCellOptions,
          { registry: armRegistry, exp },
        );
    return { ...base, ...experimentIdentityFields(exp) };
  };

  // ── Infra phase (substage of each attempt; not a separate capability row) ─
  let streak = { signature: null as string | null, count: 0, cell_ids: [] as string[] };
  for (const instance of instances) {
    // Mark primary arm attempt as running/infra for this task (reliability default arm).
    const exp = findAttemptForTaskArm(causalManifest, instance.instance_id, 'babel_enforce', 0);
    if (exp) {
      try {
        transitionAttempt(evidenceDir, exp.attempt_id, {
          lifecycle: 'running',
          substage: 'infra',
        });
      } catch {
        /* already terminal/orphaned — leave alone */
      }
    }
    heartbeat('infra', instance.instance_id);
    const cell = runInfraCell(instance);
    cells.push(cell);
    heartbeat('infra', instance.instance_id, cell.status === 'fail' ? cell.signature : null);
    const next = updateFailureStreak(streak, cell, earlyStopN, 'infra');
    streak = { signature: next.signature, count: next.count, cell_ids: next.cell_ids };
    if (next.abort) {
      aborted = next.abort;
      break;
    }
  }

  // ── Live phase: one cell per selected (arm, replicate_id) attempt (W2) ────
  if (!aborted && !options.infraOnly) {
    streak = { signature: null, count: 0, cell_ids: [] };
    const infraPassed = new Set(
      cells.filter((c) => c.phase === 'infra' && c.status === 'pass').map((c) => c.instance_id),
    );
    let stopLive = false;
    for (const instance of instances) {
      if (stopLive) break;
      const attempts = selectedAttemptsForInstance(instance.instance_id);
      if (!infraPassed.has(instance.instance_id)) {
        // One honest skipped cell per selected attempt; each attempt terminalized.
        for (const exp of attempts) {
          const cell = skippedLiveCell(
            evidenceDir,
            instance.instance_id,
            exp,
            'live:skipped_infra_fail',
            ['skipped because infra phase failed'],
          );
          cells.push(cell);
          terminalizeAttemptQuietly(evidenceDir, exp.attempt_id, {
            lifecycle: 'terminal',
            substage: 'done',
            terminal_signature: cell.signature,
            cell_evidence_path: cell.evidence_path,
          });
        }
        continue;
      }
      for (const exp of attempts) {
        // W2 honesty rule: mock provider never fabricates a raw baseline.
        if (options.provider === 'mock' && exp.arm === 'raw_opencode') {
          const cell = skippedLiveCell(
            evidenceDir,
            instance.instance_id,
            exp,
            'live:skipped_mock_provider',
            ['raw_opencode requires live provider (mock produces no genuine baseline)'],
          );
          cells.push(cell);
          terminalizeAttemptQuietly(evidenceDir, exp.attempt_id, {
            lifecycle: 'terminal',
            substage: 'done',
            terminal_signature: cell.signature,
            cell_evidence_path: cell.evidence_path,
          });
          continue;
        }
        terminalizeAttemptQuietly(evidenceDir, exp.attempt_id, {
          lifecycle: 'running',
          substage: 'live',
        });
        heartbeat('live', instance.instance_id);
        const cell = await runLiveAttempt(instance, exp);
        cells.push(cell);
        terminalizeAttemptQuietly(evidenceDir, exp.attempt_id, {
          lifecycle: 'terminal',
          substage: 'done',
          terminal_signature: cell.signature,
          cell_evidence_path: cell.evidence_path,
        });
        heartbeat('live', instance.instance_id, cell.status === 'fail' ? cell.signature : null);
        // Append policy events for scoreboard
        for (const pe of cell.policy_events) {
          appendFileSync(
            policyJsonlPath,
            `${JSON.stringify({ ...pe, _instance_id: cell.instance_id })}\n`,
            'utf8',
          );
        }
        // Session boundary: if shadow summary missing but we have shadow kinds, still emit events
        const next = updateFailureStreak(streak, cell, earlyStopN, 'live');
        streak = { signature: next.signature, count: next.count, cell_ids: next.cell_ids };
        if (next.abort) {
          aborted = next.abort;
          stopLive = true;
          break;
        }
      }
    }
  } else if (!aborted && options.infraOnly) {
    // Infra-only: each selected attempt ends after the infra substage.
    for (const instance of instances) {
      const infraCell = cells.find(
        (c) => c.instance_id === instance.instance_id && c.phase === 'infra',
      );
      if (!infraCell) continue;
      for (const exp of selectedAttemptsForInstance(instance.instance_id)) {
        terminalizeAttemptQuietly(evidenceDir, exp.attempt_id, {
          lifecycle: 'terminal',
          substage: 'done',
          terminal_signature: infraCell.signature,
          cell_evidence_path: infraCell.evidence_path,
        });
      }
    }
  }

  // Re-load manifest for summary note (immutable; must still match)
  let causalNote = 'causal_manifest=present';
  try {
    const m = loadCampaignManifest(evidenceDir);
    causalNote = `causal_manifest attempts=${m.expected_attempts.length} complete_design=${m.causal_stage1_complete_design}`;
  } catch {
    causalNote = 'causal_manifest=missing';
  }

  const shadow_sessions_with_summary = cells.filter((c) => c.has_shadow_summary).length;
  const liveCells = cells.filter((c) => c.phase === 'live' && c.status !== 'skipped');
  const livePass = liveCells.filter((c) => c.status === 'pass').length;
  const goldOk = liveCells.filter((c) => c.gold_diff_ok === true).length;
  const ftpOk = liveCells.filter((c) => c.fail_to_pass_ok === true).length;
  const ftpRan = liveCells.filter(
    (c) => c.fail_to_pass_ok === true || c.fail_to_pass_ok === false,
  ).length;
  const ftpCollect = liveCells.filter((c) => c.fail_to_pass_class === 'collect_error').length;
  const ftpAssert = liveCells.filter((c) => c.fail_to_pass_class === 'assert_fail').length;
  const passMode = resolveSweProPassMode();

  const summary_lines = [
    `SWE-Bench Pro campaign ${campaign_id}`,
    `instances=${instances.length} provider=${options.provider} early_stop_n=${earlyStopN}`,
    `pass_mode=${passMode} (BABEL_SWE_PRO_PASS_MODE=gold|ftp|both; default gold)`,
    `scoreboard: capability_primary=host_fail_to_pass; gold_role=diagnostic_only (never sole capability)`,
    causalNote,
    `infra_pass=${cells.filter((c) => c.phase === 'infra' && c.status === 'pass').length}`,
    `live_pass=${livePass}/${liveCells.length} (cell.status under pass_mode=${passMode})`,
    `host_fail_to_pass_ok=${ftpOk}/${liveCells.length} (ran=${ftpRan}) [capability primary]`,
    `gold_diagnostic_ok=${goldOk}/${liveCells.length} [diagnostic only — multi-file PR ref]`,
    `fail_to_pass_class collect_error=${ftpCollect} assert_fail=${ftpAssert}`,
    `babel_authoritative_pass=${cells.filter((c) => c.babel_authoritative_verifier === true).length}/${liveCells.length}`,
    `shadow_summaries=${shadow_sessions_with_summary}`,
    aborted ? `ABORTED: ${aborted.reason}` : 'completed_without_early_stop',
    `policy_events_jsonl=${policyJsonlPath}`,
  ];

  const report: CampaignReport = {
    schema_version: SWE_PRO_CAMPAIGN_SCHEMA,
    kind: 'babel_swe_bench_pro_campaign',
    campaign_id,
    generated_at: (options.now ?? new Date()).toISOString(),
    provider: options.provider,
    early_stop_n: earlyStopN,
    pass_mode: passMode,
    dataset_path: datasetPath,
    evidence_dir: evidenceDir,
    cells,
    aborted,
    policy_events_jsonl: policyJsonlPath,
    shadow_sessions_with_summary,
    summary_lines,
  };

  writeFileSync(join(evidenceDir, 'campaign-report.json'), JSON.stringify(report, null, 2), 'utf8');
  if (aborted) {
    writeFileSync(join(evidenceDir, 'campaign_abort.json'), JSON.stringify(aborted, null, 2), 'utf8');
  }

  // Slice 3: independently derived eligibility + multi-axis rates (not writer pass_mode)
  let derivedNote = 'derived=skipped';
  try {
    const derived = writeDerivedCampaignState({
      evidenceDir,
      ...(options.now !== undefined ? { now: options.now } : {}),
      writerCells: cells,
      manifest: causalManifest,
      legacyPassMode: passMode,
    });
    derivedNote = [
      `derived_artifact_valid=${derived.eligibility.artifact_valid}`,
      `derived_complete=${derived.eligibility.campaign_complete}`,
      `derived_reliability_eligible=${derived.eligibility.reliability_eligible}`,
      `derived_promotion_eligible=${derived.eligibility.promotion_eligible}`,
      `derived_capability_score_valid=${derived.eligibility.capability_score_valid}`,
      `itt_capability=${derived.intent_to_treat_capability.numerator}/${derived.intent_to_treat_capability.denominator}`,
      `cond_capability=${derived.conditional_capability.numerator}/${derived.conditional_capability.denominator}`,
    ].join(' ');
    summary_lines.push(derivedNote);
    report.summary_lines = summary_lines;
    writeFileSync(join(evidenceDir, 'campaign-report.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    derivedNote = `derived=error:${err instanceof Error ? err.message : String(err)}`;
    summary_lines.push(derivedNote);
    report.summary_lines = summary_lines;
    writeFileSync(join(evidenceDir, 'campaign-report.json'), JSON.stringify(report, null, 2), 'utf8');
  }

  writeFileSync(join(evidenceDir, 'campaign-summary.txt'), summary_lines.join('\n') + '\n', 'utf8');
  heartbeat('complete', null, aborted ? aborted.signature : null);

  return report;
}

export function formatCampaignReportHuman(report: CampaignReport): string {
  const lines = [
    'Babel SWE-Bench Pro Campaign',
    `id: ${report.campaign_id}`,
    `provider: ${report.provider}`,
    '',
    '## Summary',
    ...report.summary_lines.map((l) => `- ${l}`),
    '',
    '## Cells',
  ];
  for (const c of report.cells) {
    lines.push(
      `- [${c.phase}] ${c.status} \`${c.instance_id}\` sig=${c.signature} patch=${c.patch_bytes}b shadow=${c.has_shadow_summary}`,
    );
  }
  if (report.aborted) {
    lines.push('', '## Abort', JSON.stringify(report.aborted, null, 2));
  }
  lines.push(
    '',
    '## Next',
    `babel evidence shadow-precision --events ${report.policy_events_jsonl} --json`,
  );
  return lines.join('\n');
}
