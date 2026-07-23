import type { BabelEventBus, PipelineResult } from '../pipeline.js';
import type { ValidMode } from './constants.js';
import type { BabelRuntimeEvent } from '../runtime/protocol.js';
import { isAbsolute, join, relative } from 'node:path';
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import type { AskAnswer, TerminalOutcome } from '../schemas/agentContracts.js';
import type { SessionUsageSummary } from '../services/costTracker.js';
import { getUserFacingStatus } from './userFacingStatus.js';
import {
  collectHumanOutputReviewContext,
  validateEffectiveTargetRoot,
  validatePlanTargetsWithinEffectiveRoots,
  type HumanOutputReviewContext,
} from '../pipeline/targetConsistency.js';
import {
  accent,
  commandAccent,
  error,
  info,
  sectionLabel,
  stripAnsi,
  success,
  warning,
} from '../ui/theme.js';
import { isPathInsideRoot } from '../ui/liteFixProgress.js';

export const VALID_RUN_OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;
export type RunOutputFormat = (typeof VALID_RUN_OUTPUT_FORMATS)[number];

// ── API Versioning ───────────────────────────────────────────────────────────

/** Current stable API version for JSON output contracts. */
export const CURRENT_API_VERSION = '1.0';

/** All supported API versions. */
export const SUPPORTED_API_VERSIONS = ['1.0'] as const;

/**
 * Wrap a JSON output payload in the version envelope.
 *
 * When --api-version is specified, JSON output is wrapped as:
 *   { "apiVersion": "1.0", "timestamp": "<ISO>", "data": <original_output> }
 *
 * When --api-version is NOT specified, the original output is emitted
 * unchanged (backward compatible).
 */
export function wrapJsonWithApiVersion(data: unknown, apiVersion?: string): unknown {
  if (!apiVersion) {
    return data;
  }
  if (!SUPPORTED_API_VERSIONS.includes(apiVersion as (typeof SUPPORTED_API_VERSIONS)[number])) {
    throw new Error(
      `Unsupported API version: ${apiVersion}. Supported: ${SUPPORTED_API_VERSIONS.join(', ')}`,
    );
  }
  return {
    apiVersion,
    timestamp: new Date().toISOString(),
    data,
  };
}

/**
 * Parse and validate the --api-version CLI flag value.
 * Returns the version string or undefined if not specified.
 */
export function parseApiVersionFlag(value?: string): string | undefined {
  if (!value || value.trim() === '') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!SUPPORTED_API_VERSIONS.includes(trimmed as (typeof SUPPORTED_API_VERSIONS)[number])) {
    throw new Error(
      `Unsupported API version: "${trimmed}". Supported: ${SUPPORTED_API_VERSIONS.join(', ')}`,
    );
  }
  return trimmed;
}
const BROKEN_STDOUT_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ENOTCONN']);
let stdoutBroken = false;
let stdoutGuardInstalled = false;

function isBrokenStdoutError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    BROKEN_STDOUT_CODES.has(String((error as { code?: unknown }).code ?? ''))
  );
}

function ensureStdoutErrorGuard(): void {
  if (stdoutGuardInstalled) {
    return;
  }
  stdoutGuardInstalled = true;
  process.stdout.on('error', (error) => {
    if (isBrokenStdoutError(error)) {
      stdoutBroken = true;
      return;
    }
    throw error;
  });
}

function writeStdout(text: string): void {
  if (stdoutBroken) {
    return;
  }
  ensureStdoutErrorGuard();
  try {
    // Use synchronous fd-level write to avoid buffered Writable stream
    // data loss when process.exit() follows immediately after writeJson().
    if (process.stdout.fd !== undefined) {
      writeSync(process.stdout.fd, text);
    } else {
      process.stdout.write(text);
    }
  } catch (error) {
    if (isBrokenStdoutError(error)) {
      stdoutBroken = true;
      return;
    }
    throw error;
  }
}

const RUN_OUTPUT_FORMAT_ALIASES: Record<string, RunOutputFormat> = {
  terminal: 'text',
  pretty: 'text',
  jsonl: 'stream-json',
  ndjson: 'stream-json',
};

const STAGE_NAMES: Record<number, string> = {
  1: 'orchestrator',
  2: 'planner',
  3: 'qa',
  4: 'executor',
};

export interface RunOutputContext {
  task: string;
  mode: ValidMode;
  project?: string;
  projectRoot?: string;
  requestedModel?: string;
  requestedModelTier?: string;
  orchestrator?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface LiteRouteMetadata {
  route_reason: string;
  complexity: 'low' | 'medium' | 'high';
  risk_signals: Array<{
    code: string;
    reason: string;
  }>;
  model_tier_recommendation: 'standard' | 'escalation';
  full_babel_equivalent: string;
}

export interface RunStreamEvent {
  type:
    | 'run_start'
    | 'stage'
    | 'agent_id'
    | 'log'
    | 'assistant_chunk'
    | 'runtime_event'
    | 'run_complete'
    | 'run_error'
    | 'turn.started'
    | 'turn.completed'
    | 'turn.failed'
    | 'progress'
    | 'plan.updated'
    | 'approval.required'
    | 'command.started'
    | 'command.completed'
    | 'file.changed'
    | 'diff.ready';
  ts: string;
  task?: string;
  mode?: ValidMode;
  project?: string | null;
  stage_index?: number;
  stage_name?: string;
  agent_id?: string;
  line?: string;
  chunk?: string;
  turn_id?: number;
  runtime_event?: BabelRuntimeEvent;
  result?: Record<string, unknown>;
  error?: string;
  status?: string;
  approval?: unknown;
  next?: string[];
  message?: string;
  item?: Record<string, unknown>;
}

export type LiteVerb = 'ask' | 'plan' | 'report' | 'fix' | 'patch' | 'propose' | 'diff' | 'review' | 'undo' | 'do';

export interface LiteOutputContext extends RunOutputContext {
  verb: LiteVerb;
  selectedLane?: string;
  routeDecision?: LiteRouteMetadata;
}

export interface LiteUsagePayload {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  modelBreakdown: Record<string, unknown>;
  cost_ledger_path: string | null;
}

export type UserFacingStatus = 'success' | 'partial' | 'blocked' | 'failed' | 'not_verified';
export type VerificationStatus = 'passed' | 'failed' | 'skipped' | 'not_required' | 'unknown';

export interface UserFacingScopePayload {
  project_root: string | null;
  allowed_write_paths: string[];
  refused_paths: string[];
}

export interface UserFacingVerificationPayload {
  status: VerificationStatus;
  commands: string[];
  skipped_reason: string | null;
}

export interface UserFacingCheckpointPayload {
  required: boolean;
  available: boolean;
  restore_command: string | null;
  inspect_command: string | null;
}

export interface UserFacingEvidencePayload {
  run_dir: string | null;
  support_path: string | null;
  artifacts: string[];
}

export interface LiteResultPayload {
  status: string;
  user_status: UserFacingStatus;
  internal_status?: string;
  command: LiteVerb;
  lite_command: LiteVerb;
  selected_lane?: string;
  execution_path?: string;
  execution_mode?: 'offline_demo' | 'live';
  task: string;
  project: string | null;
  run_dir: string | null;
  scope: UserFacingScopePayload;
  changed_files: string[];
  verification: UserFacingVerificationPayload;
  checkpoint: UserFacingCheckpointPayload;
  evidence: UserFacingEvidencePayload;
  checks: string[];
  tests_or_checks: string[];
  usage: LiteUsagePayload;
  route_reason?: string;
  complexity?: 'low' | 'medium' | 'high';
  risk_signals?: Array<{ code: string; reason: string }>;
  model_tier_recommendation?: 'standard' | 'escalation';
  full_babel_equivalent?: string;
  schema_retries: number;
  recovered_after_schema_retry: boolean;
  answer?: {
    summary: string | null;
    answer?: string;
    facts: string[];
    assumptions: string[];
    read_only_steps: string[];
  };
  progress_steps?: string[];
  session_loop_steps?: Array<{
    phase: string;
    status: 'pass' | 'fail' | 'blocked';
    policy_decision: string;
  }>;
  next: string[];
  support_path: string | null;
  scope_path?: string;
  retryable?: boolean;
  failure_capsule_path?: string | null;
  execution_report_path?: string | null;
  next_command?: string;
  details: {
    support_path: string | null;
    full_babel_equivalent: string;
  };
}

export interface AskResultPayload {
  status: 'ANSWER_READY' | 'NEEDS_MORE_CONTEXT' | 'ASK_FAILED' | 'BLOCKED' | 'BUDGET_EXCEEDED';
  user_status: UserFacingStatus;
  command: 'ask';
  lite_command?: 'ask' | 'fix';
  execution_path?: string;
  session_loop_steps?: LiteResultPayload['session_loop_steps'];
  task: string;
  project: string | null;
  run_dir: string | null;
  scope: UserFacingScopePayload;
  changed_files: string[];
  verification: UserFacingVerificationPayload;
  checkpoint: UserFacingCheckpointPayload;
  evidence: UserFacingEvidencePayload;
  checks: string[];
  usage: LiteUsagePayload;
  schema_retries: number;
  recovered_after_schema_retry: boolean;
  answer: {
    summary: string;
    answer: string;
    facts: string[];
    assumptions: string[];
    evidence: AskAnswer['evidence'];
  };
  next: string[];
  support_path: string | null;
}

export type RunResultPayloadLike = LiteResultPayload | AskResultPayload | Record<string, unknown>;

export function parseRunOutputFormat(
  raw: string | undefined,
  json: boolean | undefined,
): RunOutputFormat | null {
  if (json === true) {
    return 'json';
  }

  const normalized = (raw ?? 'text').trim().toLowerCase();
  const alias = RUN_OUTPUT_FORMAT_ALIASES[normalized];
  if (alias) {
    return alias;
  }

  if (VALID_RUN_OUTPUT_FORMATS.includes(normalized as RunOutputFormat)) {
    return normalized as RunOutputFormat;
  }

  return null;
}

function quoteTask(task: string): string {
  return `"${task.replace(/"/g, '\\"')}"`;
}

function getLiteStatus(result: PipelineResult, verb: LiteVerb): string {
  if (verb === 'plan' && result.status === 'MANUAL_BRIDGE_REQUIRED') {
    return 'PLAN_READY';
  }
  if (
    verb === 'ask' &&
    (result.status === 'READ_ONLY_NO_MODIFICATION' ||
      result.status === 'COMPLETE_NO_MODIFICATION' ||
      result.status === 'COMPLETE')
  ) {
    return 'ANSWER_READY';
  }
  if (verb === 'patch' && result.status === 'COMPLETE') {
    return 'PATCH_COMPLETE';
  }
  if (verb === 'patch' && result.status === 'MANUAL_BRIDGE_REQUIRED') {
    return 'PATCH_READY';
  }
  if (verb === 'fix' && result.status === 'COMPLETE') {
    return 'FIX_COMPLETE';
  }
  if (verb === 'do' && result.status === 'COMPLETE') {
    return 'DO_COMPLETE';
  }
  return result.status;
}

function getInternalStatus(status: string, resultStatus: string): string | undefined {
  return status !== resultStatus ? resultStatus : undefined;
}

function getChangedFiles(result: PipelineResult): string[] {
  return result.terminalSummary?.changed_files ?? [];
}

function quotePathForCommand(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

function getAllowedWritePaths(context: RunOutputContext, changedFiles: string[]): string[] {
  if (context.mode === 'chat' || context.mode === 'plan') {
    return [];
  }
  if (context.projectRoot) {
    return [context.projectRoot];
  }
  if (changedFiles.length > 0) {
    return [
      ...new Set(
        changedFiles
          .map((file) => file.replace(/\\/g, '/').split('/')[0])
          .filter((path): path is string => typeof path === 'string' && path.length > 0),
      ),
    ];
  }
  return [];
}

function getRefusedPaths(result: PipelineResult): string[] {
  return result.terminalSummary?.target_dirty_conflicts ?? [];
}

function buildScopePayload(
  result: PipelineResult,
  context: RunOutputContext,
  changedFiles = getChangedFiles(result),
): UserFacingScopePayload {
  return {
    project_root: context.projectRoot ?? null,
    allowed_write_paths: getAllowedWritePaths(context, changedFiles),
    refused_paths: getRefusedPaths(result),
  };
}

function getVerificationStatus(result: PipelineResult, checks: string[]): VerificationStatus {
  const verifier = result.verifierContractSummary;
  if (verifier) {
    if (verifier.requiredVerifierFailedCount > 0) {
      return 'failed';
    }
    if (
      verifier.requiredVerifierSkippedCount > 0 ||
      verifier.requiredVerifierCount > verifier.requiredVerifierPassedCount
    ) {
      return 'skipped';
    }
    if (verifier.requiredVerifierPassedCount > 0) {
      return 'passed';
    }
  }
  const terminalStatus = result.terminalSummary?.status ?? result.status;
  if (/VERIFIER_FAILED|REQUIRED_VERIFIER_FAILED/.test(terminalStatus)) {
    return 'failed';
  }
  if (
    /REQUIRED_VERIFIER_MISSING|REQUIRED_VERIFIER_SKIPPED|VERIFIER_CONTRACT_UNSATISFIED/.test(
      terminalStatus,
    )
  ) {
    return 'skipped';
  }
  if (/HALTED|REJECTED|DENIED|DRIFT|UNSAFE|ROLLBACK_FAILED/.test(terminalStatus)) {
    return 'skipped';
  }
  if (checks.some((check) => /passed/i.test(check))) {
    return 'passed';
  }
  if (checks.length === 0) {
    return 'not_required';
  }
  return 'unknown';
}

function buildVerificationPayload(
  result: PipelineResult,
  checks = getChecks(result),
): UserFacingVerificationPayload {
  const status = getVerificationStatus(result, checks);
  const skippedReason =
    status === 'skipped'
      ? (result.verifierContractSummary?.completionBlockingStatus ??
        result.terminalSummary?.condition_summary ??
        result.terminalSummary?.status ??
        result.status)
      : null;
  return {
    status,
    commands: checks,
    skipped_reason: skippedReason,
  };
}

function getLatestCheckpointId(runDir: string | null | undefined): string | null {
  if (!runDir) {
    return null;
  }
  const smallFixCheckpointPath = join(runDir, 'small_fix_checkpoint.json');
  if (existsSync(smallFixCheckpointPath)) {
    try {
      const parsed = JSON.parse(readFileSync(smallFixCheckpointPath, 'utf-8')) as {
        checkpoint_id?: unknown;
      };
      if (typeof parsed.checkpoint_id === 'string' && parsed.checkpoint_id.length > 0) {
        return parsed.checkpoint_id;
      }
    } catch {
      // fall through to checkpoint index
    }
  }
  const checkpointIndex = safeReadJson(join(runDir, 'checkpoints', 'checkpoints.json'));
  if (checkpointIndex === null || typeof checkpointIndex !== 'object') {
    return null;
  }
  const checkpoints = (checkpointIndex as { checkpoints?: unknown }).checkpoints;
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return null;
  }
  const latest = checkpoints[checkpoints.length - 1];
  return latest !== null &&
    typeof latest === 'object' &&
    typeof (latest as { id?: unknown }).id === 'string'
    ? (latest as { id: string }).id
    : null;
}

function buildCheckpointPayload(
  runDir: string | null | undefined,
  changedFiles: string[],
): UserFacingCheckpointPayload {
  const required = changedFiles.length > 0;
  const checkpointId = getLatestCheckpointId(runDir);
  const inspectCommand = runDir
    ? `babel checkpoint list --run ${quotePathForCommand(runDir)}`
    : null;
  return {
    required,
    available: checkpointId !== null,
    restore_command: checkpointId ? 'babel undo' : null,
    inspect_command: inspectCommand,
  };
}

function buildEvidencePayload(input: {
  runDir?: string | null;
  supportPath?: string | null;
  artifacts?: Array<string | null | undefined>;
}): UserFacingEvidencePayload {
  return {
    run_dir: input.runDir ?? null,
    support_path: input.supportPath ?? null,
    artifacts: [
      ...new Set(
        (input.artifacts ?? []).filter(
          (artifact): artifact is string => typeof artifact === 'string' && artifact.length > 0,
        ),
      ),
    ],
  };
}


function getChecks(result: PipelineResult): string[] {
  const terminal = result.terminalSummary;
  const failed = terminal?.failed_command ? [terminal.failed_command] : [];
  const verifier = result.verifierContractSummary;
  if (!verifier) {
    return failed;
  }
  return [
    ...failed,
    ...(verifier.requiredVerifierPassedCount > 0
      ? [`${verifier.requiredVerifierPassedCount} required verifier(s) passed`]
      : []),
    ...(verifier.requiredVerifierFailedCount > 0
      ? [`${verifier.requiredVerifierFailedCount} required verifier(s) failed`]
      : []),
    ...(verifier.requiredVerifierSkippedCount > 0
      ? [`${verifier.requiredVerifierSkippedCount} required verifier(s) skipped`]
      : []),
  ];
}

function safeReadJson(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

function isSchemaRetryError(value: unknown): boolean {
  const text =
    typeof value === 'string'
      ? value
      : value === null || value === undefined
        ? ''
        : JSON.stringify(value);
  return /zod|schema|validation|invalid json|failed to parse|json extraction/i.test(text);
}

export function getSchemaRetrySummary(runDir: string | null | undefined): {
  schema_retries: number;
  recovered_after_schema_retry: boolean;
} {
  if (!runDir) {
    return { schema_retries: 0, recovered_after_schema_retry: false };
  }
  const telemetry = safeReadJson(join(runDir, '05_waterfall_telemetry.json'));
  const entries = Array.isArray(telemetry)
    ? telemetry
    : telemetry !== null &&
        typeof telemetry === 'object' &&
        Array.isArray((telemetry as { entries?: unknown }).entries)
      ? (telemetry as { entries: unknown[] }).entries
      : [];

  let schemaRetries = 0;
  let recovered = false;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as { attempts_detail?: unknown[]; tier_succeeded?: unknown };
    const attempts = Array.isArray(record.attempts_detail) ? record.attempts_detail : [];
    const schemaFailedAttempts = attempts.filter((attempt) => {
      if (attempt === null || typeof attempt !== 'object') {
        return false;
      }
      const attemptRecord = attempt as { succeeded?: unknown; error_summary?: unknown };
      return attemptRecord.succeeded === false && isSchemaRetryError(attemptRecord.error_summary);
    }).length;
    schemaRetries += schemaFailedAttempts;
    if (
      schemaFailedAttempts > 0 &&
      typeof record.tier_succeeded === 'string' &&
      record.tier_succeeded.length > 0
    ) {
      recovered = true;
    }
  }

  return {
    schema_retries: schemaRetries,
    recovered_after_schema_retry: recovered,
  };
}

function getLiteNextSteps(
  status: string,
  context: LiteOutputContext,
  result: PipelineResult,
): string[] {
  const selectedVerb = context.verb === 'do' ? context.selectedLane : context.verb;
  if (selectedVerb === 'plan') {
    return [
      `Run babel ${quoteTask(context.task)} when you are ready to apply the change.`,
      'Use --json if you need artifact paths for automation.',
    ];
  }

  if (selectedVerb === 'patch') {
    return [
      'Review the proposal artifact before making any source changes.',
      `Run babel ${quoteTask(context.task)} when you want Babel to apply a verified change.`,
    ];
  }

  if (selectedVerb === 'ask' || selectedVerb === 'lite_ask' || selectedVerb === 'lite_report') {
    return [
      `Run babel plan ${quoteTask(context.task)} if you want an implementation path.`,
      `Run babel ${quoteTask(context.task)} if you want Babel to make the change.`,
    ];
  }

  if (selectedVerb === 'deep_lane') {
    return [
      `Run babel deep ${quoteTask(context.task)} for governed execution.`,
      'Use babel resume latest if this run needs recovery.',
    ];
  }

  if (
    status === 'PATCH_COMPLETE' ||
    status === 'FIX_COMPLETE' ||
    status === 'DO_COMPLETE' ||
    status === 'COMPLETE'
  ) {
    return ['Review the changes before committing.', 'Run your tests before shipping.'];
  }

  return [
    result.repairPromptPath
      ? 'Inspect the repair prompt for the next attempt.'
      : 'Inspect the run output for the next action.',
  ];
}

function getUsageSummary(result: PipelineResult): LiteUsagePayload {
  return attachCostLedgerPath(
    result.runDir,
    result.usageSummary ?? {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      modelBreakdown: {},
    },
  );
}

function getAskAnswer(result: PipelineResult): LiteResultPayload['answer'] | undefined {
  const plan = result.plan;
  if (!plan) {
    return undefined;
  }

  const readOnlySteps = plan.minimal_action_set
    .filter((step) =>
      [
        'directory_list',
        'file_read',
        'semantic_search',
        'grep',
        'glob',
        'web_search',
        'web_fetch',
      ].includes(step.tool),
    )
    .map((step) => step.description);

  return {
    summary: plan.task_summary || null,
    facts: plan.known_facts ?? [],
    assumptions: plan.assumptions ?? [],
    read_only_steps: readOnlySteps,
  };
}

function getFullBabelEquivalent(context: LiteOutputContext): string {
  if (context.verb === 'ask') {
    return `babel ${quoteTask(context.task)}`;
  }
  if (context.verb === 'plan') {
    return `babel plan ${quoteTask(context.task)}`;
  }
  if (context.verb === 'patch') {
    return `babel plan ${quoteTask(context.task)}`;
  }
  if (context.verb === 'do') {
    return `babel ${quoteTask(context.task)}`;
  }
  return `babel ${quoteTask(context.task)}`;
}

function getFailureArtifacts(result: PipelineResult): {
  retryable?: boolean;
  failure_capsule_path?: string | null;
  execution_report_path?: string | null;
  next_command?: string;
} {
  const runDir = result.runDir ?? null;
  const executionReportPath = runDir ? join(runDir, '04_execution_report.json') : null;
  const terminalCapsule = result.terminalSummary?.failure_capsule_path ?? null;
  const preExecutionCapsule = runDir ? join(runDir, '12_pre_execution_failure_capsule.json') : null;
  const failureCapsulePath =
    terminalCapsule && existsSync(terminalCapsule)
      ? terminalCapsule
      : preExecutionCapsule && existsSync(preExecutionCapsule)
        ? preExecutionCapsule
        : null;
  const capsule = failureCapsulePath ? safeReadJson(failureCapsulePath) : null;
  const retryable =
    capsule !== null &&
    typeof capsule === 'object' &&
    typeof (capsule as { retryable?: unknown }).retryable === 'boolean'
      ? (capsule as { retryable: boolean }).retryable
      : result.status !== 'COMPLETE' &&
        result.status !== 'COMPLETE_NO_MODIFICATION' &&
        result.status !== 'READ_ONLY_NO_MODIFICATION';

  const payload: {
    retryable?: boolean;
    failure_capsule_path?: string | null;
    execution_report_path?: string | null;
    next_command?: string;
  } = {
    retryable,
    failure_capsule_path: failureCapsulePath,
    execution_report_path:
      executionReportPath && existsSync(executionReportPath) ? executionReportPath : null,
  };
  if (retryable) {
    payload.next_command = 'babel continue latest';
  }
  return payload;
}

export function buildLiteResultPayload(
  result: PipelineResult,
  context: LiteOutputContext,
): LiteResultPayload {
  const status =
    context.verb === 'do' &&
    context.selectedLane === 'plan' &&
    result.status === 'MANUAL_BRIDGE_REQUIRED'
      ? 'PLAN_READY'
      : context.verb === 'do' &&
          context.selectedLane === 'patch' &&
          result.status === 'MANUAL_BRIDGE_REQUIRED'
        ? 'PATCH_READY'
        : getLiteStatus(result, context.verb);
  const checks = getChecks(result);
  const changedFiles = getChangedFiles(result);
  const supportPath =
    context.verb === 'plan'
      ? (result.manualPromptPath ?? result.runDir ?? null)
      : (result.repairPromptPath ?? result.runDir ?? null);
  const askAnswer = context.verb === 'ask' ? getAskAnswer(result) : undefined;
  const schemaRetry = getSchemaRetrySummary(result.runDir);
  const failure = isSuccessfulStatus(status) ? {} : getFailureArtifacts(result);
  const verification = buildVerificationPayload(result, checks);
  const evidenceArtifacts = [
    result.runDir ? join(result.runDir, 'terminal_status_summary.json') : null,
    result.runDir ? join(result.runDir, 'verifier_execution_summary.json') : null,
    result.runDir ? join(result.runDir, 'cost_ledger.json') : null,
    result.terminalSummary?.failure_capsule_path ?? null,
  ];
  return {
    status,
    user_status: getUserFacingStatus({ status, verification, changedFiles }),
    ...(getInternalStatus(status, result.status) !== undefined
      ? { internal_status: result.status }
      : {}),
    command: context.verb,
    lite_command: context.verb,
    ...(context.verb === 'do'
      ? {
          selected_lane:
            context.selectedLane ??
            (context.mode === 'plan' ? 'plan' : context.mode === 'chat' ? 'ask' : 'fix'),
        }
      : {}),
    task: context.task,
    project: context.project ?? result.manifest.target_project ?? null,
    run_dir: result.runDir ?? null,
    scope: buildScopePayload(result, context, changedFiles),
    changed_files: changedFiles,
    verification,
    checkpoint: buildCheckpointPayload(result.runDir, changedFiles),
    evidence: buildEvidencePayload({
      runDir: result.runDir,
      supportPath,
      artifacts: evidenceArtifacts,
    }),
    checks,
    tests_or_checks: checks,
    usage: getUsageSummary(result),
    ...schemaRetry,
    ...(askAnswer !== undefined ? { answer: askAnswer } : {}),
    ...(context.routeDecision !== undefined
      ? {
          route_reason: context.routeDecision.route_reason,
          complexity: context.routeDecision.complexity,
          risk_signals: context.routeDecision.risk_signals,
          model_tier_recommendation: context.routeDecision.model_tier_recommendation,
          full_babel_equivalent: context.routeDecision.full_babel_equivalent,
        }
      : {}),
    next: getLiteNextSteps(status, context, result),
    support_path: supportPath,
    ...failure,
    details: {
      support_path: supportPath,
      full_babel_equivalent: getFullBabelEquivalent(context),
    },
  };
}

function isSuccessfulStatus(status: string): boolean {
  return (
    status === 'COMPLETE' ||
    status === 'COMPLETE_NO_MODIFICATION' ||
    status === 'READ_ONLY_NO_MODIFICATION' ||
    status === 'ANSWER_READY' ||
    status === 'PLAN_READY' ||
    status === 'PATCH_READY' ||
    status === 'PATCH_COMPLETE' ||
    status === 'FIX_COMPLETE' ||
    status === 'DO_COMPLETE' ||
    status === 'SMALL_FIX_COMPLETE'
  );
}

function normalizeUsageSummary(usage: SessionUsageSummary | undefined): LiteUsagePayload {
  return attachCostLedgerPath(
    null,
    usage ?? {
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      modelBreakdown: {},
    },
  );
}

function attachCostLedgerPath(
  runDir: string | null | undefined,
  usage: SessionUsageSummary | LiteUsagePayload,
): LiteUsagePayload {
  const usageSummary = usage as LiteUsagePayload;
  const costLedgerPath = runDir ? join(runDir, 'cost_ledger.json') : null;
  return {
    ...usageSummary,
    cost_ledger_path: costLedgerPath && existsSync(costLedgerPath) ? costLedgerPath : null,
  };
}

export function buildAskResultPayload(input: {
  answer: AskAnswer;
  task: string;
  project?: string;
  projectRoot?: string;
  runDir?: string;
  usageSummary?: SessionUsageSummary;
  sessionLoopSteps?: LiteResultPayload['session_loop_steps'];
  lite?: boolean;
  /** Override the lite_command field (default 'ask' when lite is true). */
  liteCommand?: 'ask' | 'fix';
  /** When true, suppress the default "run babel plan" next steps. */
  suppressImplementationNext?: boolean;
}): AskResultPayload {
  const schemaRetry = getSchemaRetrySummary(input.runDir);
  const next = input.suppressImplementationNext
    ? []
    : input.answer.next.length > 0
      ? input.answer.next
      : [
          'Run babel plan if you want an implementation path.',
          'Run babel if you want Babel to make the change.',
        ];
  const sessionLoopSteps = input.sessionLoopSteps ?? [];
  return {
    status: input.answer.status,
    user_status:
      input.answer.status === 'ANSWER_READY'
        ? 'success'
        : input.answer.status === 'NEEDS_MORE_CONTEXT'
          ? 'blocked'
          : 'failed',
    command: 'ask',
    ...(input.lite === true ? { lite_command: input.liteCommand ?? 'ask' as const } : {}),
    ...(sessionLoopSteps.length > 0
      ? {
          execution_path: 'session_loop',
          session_loop_steps: sessionLoopSteps,
        }
      : {}),
    task: input.task,
    project: input.project ?? null,
    run_dir: input.runDir ?? null,
    scope: {
      project_root: input.projectRoot ?? null,
      allowed_write_paths: [],
      refused_paths: [],
    },
    changed_files: [],
    verification: {
      status: 'not_required',
      commands: ['read-only answer path'],
      skipped_reason: null,
    },
    checkpoint: buildCheckpointPayload(input.runDir, []),
    evidence: buildEvidencePayload({
      ...(input.runDir !== undefined ? { runDir: input.runDir } : {}),
      supportPath: input.runDir ?? null,
      artifacts: input.runDir
        ? [
            join(input.runDir, 'ask_answer.json'),
            join(input.runDir, 'ask_grounding_review.json'),
            join(input.runDir, 'cost_ledger.json'),
          ]
        : [],
    }),
    checks: ['read-only answer path'],
    usage: normalizeUsageSummary(input.usageSummary),
    ...schemaRetry,
    answer: {
      summary: input.answer.summary,
      answer: input.answer.answer,
      facts: input.answer.facts,
      assumptions: input.answer.assumptions,
      evidence: input.answer.evidence,
    },
    next,
    support_path: input.runDir ?? null,
  };
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(6)}`;
}

function formatUsageLine(usage: LiteUsagePayload): string {
  if (usage.totalTokens <= 0) {
    return 'No usage data available';
  }
  const base = `Tokens: ${usage.totalTokens} (${formatCost(usage.totalCostUSD)})`;
  if (!usage.cost_ledger_path) {
    return base;
  }
  return `${base}${`\nCost details: ${usage.cost_ledger_path}`}`;
}

function formatWorkPath(path: string): string {
  return path.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatProviderRecovery(schemaRetries: number, recovered: boolean): string | null {
  // Hide retry counts from user output — schema repair is a backend concern.
  // Only surface when unusually high (>3 retries) as a muted note.
  if (schemaRetries <= 0) return null;
  if (schemaRetries > 3) return 'Took a few tries to get a clean response.';
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function cleanHumanText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value
    .replace(/\bOBJECTIVE:\s*/gi, '')
    .replace(/\b(?:SWE Agent|QA Reviewer|Orchestrator|CLI Executor)\b[:\s-]*/gi, '')
    .replace(/\bStage\s+\d+\s*\/\s*\d+\s*[—-]?\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function humanizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatHumanLaneLabel(selectedLane: string | null | undefined): string | null {
  if (!selectedLane) {
    return null;
  }
  const labels: Record<string, string> = {
    lite_ask: 'Read-only answer',
    lite_plan: 'Plan only',
    lite_report: 'Read-only report',
    lite_patch: 'Proposal only',
    lite_fix: 'Scoped fix',
    deep_lane: 'Governed deep execution',
    ask: 'Read-only answer',
    plan: 'Plan only',
    patch: 'Proposal only',
    fix: 'Scoped fix',
    report: 'Read-only report',
  };
  return labels[selectedLane] ?? humanizeToken(selectedLane.replace(/^lite_/, ''));
}

function normalizeCommandVerb(command: string | null, selectedLane?: string | null): string {
  const laneLabel = formatHumanLaneLabel(selectedLane);
  if (laneLabel) {
    return laneLabel;
  }
  if (!command) {
    return 'Run';
  }
  if (command === 'do') {
    return 'Daily work';
  }
  if (command === 'deep' || command === 'full') {
    return 'Governed deep execution';
  }
  if (command === 'propose' || command === 'diff') {
    return 'Patch Proposal';
  }
  return humanizeToken(command);
}

function normalizeOutcome(payload: Record<string, unknown>): string {
  const status = asString(payload['status']) ?? '';
  const userStatus = asString(payload['user_status']) ?? '';
  if (/HALTED|REJECTED|DENIED|DRIFT|UNSAFE|ROLLBACK_FAILED/.test(status)) {
    return 'Blocked';
  }
  if (/FAILED|FAIL|ASK_FAILED/.test(status) || userStatus === 'failed') {
    return 'Failed';
  }
  if (
    /BLOCKED|APPROVAL_REQUIRED|NEEDS_MORE_CONTEXT|REJECTED|DENIED/.test(status) ||
    userStatus === 'blocked'
  ) {
    return 'Blocked';
  }
  if (userStatus === 'not_verified') {
    return 'Needs Verification';
  }
  if (/PLAN_READY|MANUAL_BRIDGE_REQUIRED/.test(status)) {
    return 'Ready';
  }
  if (/PATCH_READY/.test(status)) {
    return 'Ready';
  }
  if (/ANSWER_READY/.test(status)) {
    return 'Ready';
  }
  if (/REPORT_READY/.test(status)) {
    return 'Ready';
  }
  if (/COMPLETE/.test(status)) {
    return 'Complete';
  }
  if (status) {
    return humanizeToken(status);
  }
  return 'Ready';
}

function relativeWorkPath(path: string, projectRoot?: string | null): string {
  if (!isAbsolute(path)) {
    return path.replace(/\\/g, '/');
  }
  const base = projectRoot && isAbsolute(projectRoot) ? projectRoot : process.cwd();
  const rel = relative(base, path);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return rel.replace(/\\/g, '/');
  }
  return path.replace(/\\/g, '/').split('/').slice(-2).join('/');
}

function formatPathList(paths: string[], projectRoot?: string | null, cap = 8): string[] {
  if (paths.length === 0) {
    return ['none'];
  }
  const visible = paths
    .slice(0, cap)
    .map((path) => `- ${info(relativeWorkPath(path, projectRoot))}`);
  if (paths.length > cap) {
    visible.push(`+${paths.length - cap} more`);
  }
  return visible;
}

function firstNextStep(
  payload: Record<string, unknown>,
  fallback: string,
  changedFiles: string[] = [],
): string {
  const next = asStringArray(payload['next']);
  const first = next[0] ?? fallback;
  if (changedFiles.length === 0 && /^Review changed files/i.test(first)) {
    return 'No files changed. Re-run with `babel deep` if you want changes applied.';
  }
  return first;
}

function extractUsage(payload: Record<string, unknown>): LiteUsagePayload | null {
  const usage = asRecord(payload['usage']);
  const totalTokens = typeof usage['totalTokens'] === 'number' ? usage['totalTokens'] : 0;
  const totalCostUSD = typeof usage['totalCostUSD'] === 'number' ? usage['totalCostUSD'] : 0;
  if (totalTokens <= 0 && totalCostUSD <= 0) {
    return null;
  }
  return {
    totalCostUSD,
    totalInputTokens: typeof usage['totalInputTokens'] === 'number' ? usage['totalInputTokens'] : 0,
    totalOutputTokens:
      typeof usage['totalOutputTokens'] === 'number' ? usage['totalOutputTokens'] : 0,
    totalTokens,
    modelBreakdown: asRecord(usage['modelBreakdown']),
    cost_ledger_path: asString(usage['cost_ledger_path']),
  };
}

function truncateHumanErrorMessage(message: string, maxChars = 200): string {
  const trimmed = message.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (/zod validation|invalid json/i.test(trimmed)) {
    return `${trimmed.slice(0, maxChars)}... (see run_dir/schema_failures/ for full details)`;
  }
  return `${trimmed.slice(0, maxChars)}...`;
}

function deriveAnswer(payload: Record<string, unknown>, verb: string, outcome: string): string {
  const answer = asRecord(payload['answer']);
  const answerText = cleanHumanText(asString(answer['answer']));
  if (answerText) {
    return answerText;
  }
  const summary = cleanHumanText(
    asString(answer['summary']) ?? asString(asRecord(payload['plan'])['task_summary']),
  );
  const changedFiles = asStringArray(payload['changed_files']);
  const status = asString(payload['status']) ?? '';
  const supportPath =
    asString(payload['support_path']) ??
    asString(payload['manual_prompt_path']) ??
    asString(payload['repair_prompt_path']);
  const verificationStatus = asString(asRecord(payload['verification'])['status']);
  const taskDirectiveSummary =
    summary !== null && /^(analyze|inspect|determine|summarize|review|check|read)\b/i.test(summary);
  if (outcome === 'Failed' || outcome === 'Blocked') {
    const errorMessages = asStringArray(payload['errors']);
    const reason = cleanHumanText(
      asString(payload['reason']) ??
        asString(asRecord(payload['terminal_status'])['condition_summary']),
    );
    const firstError = errorMessages[0] ? truncateHumanErrorMessage(errorMessages[0]) : null;
    return (
      reason ?? firstError ?? `Babel could not complete this ${verb.toLowerCase()} run safely.`
    );
  }
  if (verb === 'Ask') {
    const facts = asStringArray(answer['facts']);
    return (
      summary ?? facts[0] ?? 'Babel prepared a read-only answer. See Evidence for the run details.'
    );
  }
  if (verb === 'Plan') {
    return (
      summary ??
      (supportPath
        ? `Prepared a plan artifact for review. See Evidence for ${supportPath}.`
        : 'Prepared a plan for review.')
    );
  }
  if (verb === 'Patch' || verb === 'Patch Proposal') {
    return 'Prepared a patch proposal. No source files were changed.';
  }
  if (verb === 'Fix' && summary) {
    return summary;
  }
  if (changedFiles.length > 0) {
    const firstFile = relativeWorkPath(
      changedFiles[0]!,
      asString(asRecord(payload['scope'])['project_root']),
    );
    return `Completed the ${verb.toLowerCase()} run and changed ${firstFile}${changedFiles.length > 1 ? ` plus ${changedFiles.length - 1} more file(s)` : ''}.`;
  }
  if (verb === 'Run' && taskDirectiveSummary && verificationStatus === 'not_required') {
    return 'Completed a read-only run without changing source files. See Evidence for the inspected run bundle.';
  }
  if (/READ_ONLY_NO_MODIFICATION|COMPLETE_NO_MODIFICATION/.test(status)) {
    return `Completed the ${verb.toLowerCase()} run without changing source files.`;
  }
  return summary ?? `Completed the ${verb.toLowerCase()} run.`;
}

function formatVerification(payload: Record<string, unknown>): string[] {
  const verification = asRecord(payload['verification']);
  const status = asString(verification['status']) ?? 'unknown';
  const command = asString(payload['command']) ?? asString(payload['lite_command']) ?? '';
  const runStatus = asString(payload['status']) ?? '';
  const allowedTools = asStringArray(asRecord(payload['tool_policy'])['allowed_tools']);
  const readOnlyToolsOnly =
    allowedTools.length > 0 &&
    allowedTools.every((tool) =>
      [
        'directory_list',
        'file_read',
        'semantic_search',
        'grep',
        'glob',
        'web_search',
        'web_fetch',
      ].includes(tool),
    );
  const commands =
    asStringArray(verification['commands']).length > 0
      ? asStringArray(verification['commands'])
      : asStringArray(payload['checks']);
  if (status === 'passed') {
    return commands.length > 0
      ? commands.map((command) =>
          /:\s*passed$/i.test(command) ? `- ${command}` : `- ${command}: ${success('passed')}`,
        )
      : [`- verification: ${success('passed')}`];
  }
  if (status === 'failed') {
    const command = commands[0] ?? 'verification';
    return [/:?\s*failed$/i.test(command) ? `- ${command}` : `- ${command}: ${error('failed')}`];
  }
  if (status === 'skipped') {
    return [
      `not run - ${asString(verification['skipped_reason']) ?? 'required verification was skipped'}`,
    ];
  }
  if (status === 'not_required') {
    if (command === 'ask' || readOnlyToolsOnly || /READ_ONLY|NO_MODIFICATION/.test(runStatus)) {
      return ['not needed — read-only request'];
    }
    if (command === 'plan' || /PLAN_READY/.test(runStatus)) {
      return ['not needed — plan only'];
    }
    if (command === 'report' || /REPORT_READY/.test(runStatus)) {
      return ['not needed — report only'];
    }
    if (command === 'patch' || command === 'propose' || /PATCH|PROPOSAL/.test(runStatus)) {
      return ['not needed — proposal only'];
    }
    return ['not needed'];
  }
  if (commands.length > 0) {
    return commands.map((command) => `- ${command}: ${warning(status)}`);
  }
  return [`not run - ${status}`];
}

function formatRecovery(payload: Record<string, unknown>): string[] {
  const checkpoint = asRecord(payload['checkpoint']);
  const changedFiles = asStringArray(payload['changed_files']);
  const restore = asString(checkpoint['restore_command']);
  if (restore) {
    const lines = [`- Undo: ${commandAccent(restore)}`];
    if (checkpoint['available'] === true) {
      lines.push('- Checkpoint: available');
    }
    return lines;
  }
  if (changedFiles.length > 0 && checkpoint['available'] === true) {
    return ['- Checkpoint: available'];
  }
  return ['none required'];
}

function formatEvidence(payload: Record<string, unknown>): string[] {
  const evidence = asRecord(payload['evidence']);
  const lines: string[] = [];
  const runDir = asString(payload['run_dir']) ?? asString(evidence['run_dir']);
  const supportPath = asString(payload['support_path']) ?? asString(evidence['support_path']);
  const usage = extractUsage(payload);
  const usageSuffix =
    usage && usage.totalTokens > 0
      ? ` — ${usage.totalTokens.toLocaleString('en-US')} tokens, ${formatCost(usage.totalCostUSD)}`
      : '';
  if (runDir) {
    lines.push(`- Run: ${info(runDir)}${usageSuffix}`);
  } else if (usage && usage.totalTokens > 0) {
    lines.push(
      `- Usage: ${usage.totalTokens.toLocaleString('en-US')} tokens, ${formatCost(usage.totalCostUSD)}`,
    );
  }
  if (supportPath && supportPath !== runDir) {
    lines.push(`- Support: ${info(supportPath)}`);
  }
  if (usage?.cost_ledger_path && (!runDir || !isPathInsideRoot(runDir, usage.cost_ledger_path))) {
    lines.push(`- Cost ledger: ${info(usage.cost_ledger_path)}`);
  }
  const providerRecovery = formatProviderRecovery(
    typeof payload['schema_retries'] === 'number' ? payload['schema_retries'] : 0,
    payload['recovered_after_schema_retry'] === true,
  );
  if (providerRecovery) {
    lines.push(`- ${providerRecovery}`);
  }
  if (lines.length === 0) {
    return ['none'];
  }
  return lines;
}

function addSection(lines: string[], title: string, body: string[] | string): void {
  lines.push('');
  lines.push(sectionLabel(`${title}:`));
  if (Array.isArray(body)) {
    lines.push(...body);
  } else {
    lines.push(body);
  }
}

export function formatRunResultHuman(payload: RunResultPayloadLike): string {
  const record = asRecord(payload);
  const command = asString(record['lite_command']) ?? asString(record['command']);
  const selectedLane = asString(record['selected_lane']);
  const rawVerb = selectedLane && (command === 'do' || command === 'fix') ? selectedLane : command;
  const verb = normalizeCommandVerb(rawVerb, selectedLane);
  const outcome = normalizeOutcome(record);
  const scope = asRecord(record['scope']);
  const projectRoot = asString(scope['project_root']);
  const changedFiles = asStringArray(record['changed_files']);
  const title = `${accent('Babel')} ${verb} ${outcome}`;
  const answer = deriveAnswer(record, verb, outcome);
  const lines = [title];
  const modeLabel = formatHumanLaneLabel(selectedLane);
  if (modeLabel) {
    lines.push('', sectionLabel('Mode:'), modeLabel);
  }
  const routeReason = asString(record['route_reason']);
  if (routeReason && command === 'do') {
    lines.push('', sectionLabel('Route:'), routeReason);
  }
  if (projectRoot) {
    lines.push('', sectionLabel('Target:'), projectRoot);
  }
  lines.push('', sectionLabel('Answer:'), answer);

  const progressSteps = asStringArray(record['progress_steps']);
  if (progressSteps.length > 0) {
    addSection(
      lines,
      'Progress',
      progressSteps.slice(0, 6).map((step) => `- ${step}`),
    );
  }

  if (outcome === 'Failed' || outcome === 'Blocked') {
    const why = [
      ...asStringArray(record['errors']).slice(0, 3),
      asString(asRecord(record['terminal_status'])['condition_summary']),
    ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    if (why.length > 0) {
      addSection(
        lines,
        'Why',
        why.map((entry) => `- ${truncateHumanErrorMessage(entry)}`),
      );
    }
  }

  if ((verb === 'Patch' || verb === 'Patch Proposal') && changedFiles.length === 0) {
    addSection(lines, 'Proposal', [
      '- Prepared proposal-only output; see Evidence for the artifact path.',
    ]);
  }

  const readOnlySteps = asStringArray(asRecord(record['answer'])['read_only_steps']);
  if (readOnlySteps.length > 0) {
    addSection(
      lines,
      'Inspected',
      readOnlySteps.slice(0, 5).map((step) => `- ${step}`),
    );
  }

  // Only show sections that have meaningful content (hide empties)
  const changedList = formatPathList(changedFiles, projectRoot);
  if (!(changedList.length === 1 && changedList[0] === 'none')) {
    addSection(lines, 'Changed', changedList);
  }

  const verification = formatVerification(record);
  if (
    verification.length > 0 &&
    !(verification.length === 1 && /not needed/i.test(verification[0] ?? ''))
  ) {
    addSection(lines, 'Verified', verification);
  }

  const recovery = formatRecovery(record);
  if (recovery.length > 0 && !(recovery.length === 1 && /none required/i.test(recovery[0] ?? ''))) {
    addSection(lines, 'Recovery', recovery);
  }

  addSection(lines, 'Evidence', formatEvidence(record));

  // Fix Next advice for chat mode: don't suggest deep mode for read-only questions
  const fallback = changedFiles.length > 0 ? 'Review the changes and commit when ready.' : '';
  const nextStep = firstNextStep(record, fallback, changedFiles);
  const mode = asString(record['mode']) || asString(record['lite_command']);
  if (mode === 'chat' && changedFiles.length === 0 && /deep/i.test(nextStep)) {
    addSection(lines, 'Next', ['Ask a follow-up question or type your next task.']);
  } else if (nextStep) {
    addSection(lines, 'Next', [nextStep]);
  }

  return lines.join('\n');
}

export interface HumanOutputReview {
  schema_version: 1;
  artifact_type: 'babel_human_output_review';
  status: 'pass' | 'needs_attention';
  score: number;
  checks: Array<{
    id: string;
    status: 'pass' | 'fail';
    finding: string;
  }>;
  findings: string[];
}

function contextTargetMismatch(summaryTarget: string, context?: HumanOutputReviewContext): boolean {
  if (!context) {
    return false;
  }
  const effective = context.expectedTargetRoot?.trim() || summaryTarget;
  const result = validateEffectiveTargetRoot({
    expectedTargetRoot: effective || null,
    manifestTargetRoot: context.manifestTargetRoot ?? null,
  });
  return !result.ok;
}

function hasWrongPathEnoent(text: string, context?: HumanOutputReviewContext): boolean {
  const target = context?.expectedTargetRoot?.trim();
  if (!target || !/\bENOENT\b|cannot find path|no such file or directory/i.test(text)) {
    return false;
  }
  const pathMatches = text.match(/[A-Z]:[\\/][^\s"'`]+|\/[^\s"'`]+/g) ?? [];
  const scopeResult = validatePlanTargetsWithinEffectiveRoots({
    effectiveTargetRoot: target,
    approvedRoots: [],
    targets: pathMatches,
  });
  return !scopeResult.ok;
}

function hasReportIntent(task: string | null | undefined): boolean {
  if (!task) {
    return false;
  }
  const normalized = task.trim().toLowerCase();
  const hasMutationIntent =
    /\b(fix|repair|apply|update|edit|modify|change|implement|write|create|delete|remove)\b/i.test(
      normalized,
    );
  const explicitPlanIntent =
    /^\s*(plan|design|outline|approach)\b|\b(implementation plan|migration plan|plan for|planning)\b/i.test(
      normalized,
    );
  return (
    /\b(compare|analy[sz]e|audit|diagnose|diagnostic|assess|investigate|report|findings|evaluate)\b/i.test(
      normalized,
    ) &&
    !explicitPlanIntent &&
    !hasMutationIntent
  );
}

function hasFutureOnlyReportLanguage(text: string): boolean {
  const answerMatch = text.match(/Answer:\n([\s\S]*?)(?:\n\n[A-Z][A-Za-z ]+:\n|$)/);
  const answer = answerMatch?.[1] ?? text;
  const futurePlanSignals =
    /\b(?:we will|i will|will inspect|will review|will analyze|will compare|will produce|the plan involves|this plan|proposed plan|produce a .*report)\b/i;
  const completedSignals =
    /\b(?:i found|found that|the evidence shows|completed|inspected|compared|analysis shows|findings?:|reported|diagnosed|assessed)\b/i;
  return futurePlanSignals.test(answer) && !completedSignals.test(answer);
}

function hasCompareReportIntent(task: string | null | undefined): boolean {
  return /\b(compare|versus|vs\.?|trade-?offs?|options?|paths?)\b/i.test(task ?? '');
}

function hasAuditDiagnosticReportIntent(task: string | null | undefined): boolean {
  return /\b(audit|diagnos(?:e|is|tic)|debug|assess|evaluate|investigate|findings?)\b/i.test(
    task ?? '',
  );
}

function extractReportBody(text: string): string {
  const answerMatch = text.match(
    /Answer:\n([\s\S]*?)(?:\n\nChanged:\n|\n\nVerified:\n|\n\nEvidence:\n|$)/,
  );
  return answerMatch?.[1]?.trim() || text;
}

function countSubstantiveReportBullets(text: string): number {
  const genericOnly =
    /\b(?:primary evidence source|no mutation(?: was)? requested|no source files were changed|review report\.md|local read-only report|available contract points)\b/i;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .filter((line) => !genericOnly.test(line))
    .filter((line) =>
      /\b(?:evidence|risk|tradeoff|compare|compared|whereas|while|option|likely|suspected|verification|observed|recommended|bounded|surface|because|separate|distinct|stronger|weaker|guard|catch|fail|pass)\b/i.test(
        line,
      ),
    ).length;
}

function reportDepthFailure(text: string, context?: HumanOutputReviewContext): boolean {
  const task = context?.task ?? null;
  const isReport =
    /^Babel Report\b/m.test(text) ||
    /REPORT_READY/i.test(context?.runStatus ?? '') ||
    hasReportIntent(task);
  if (!isReport) {
    return false;
  }
  const body = extractReportBody(text);
  const shallowOnly =
    /\b(?:primary evidence source|no mutation(?: was)? requested|no source files were changed|review report\.md|available contract points)\b/i.test(
      body,
    ) &&
    !/\b(?:tradeoff|compared|whereas|while|option|risk|observed|recommended|because|separate|distinct|stronger|weaker|verification candidate|likely files|suspected files)\b/i.test(
      body,
    );
  if (shallowOnly) {
    return true;
  }
  if (hasCompareReportIntent(task)) {
    const hasComparisonLanguage =
      /\b(?:compared?|versus|vs\.?|trade-?off|option|whereas|while|separate|distinct|stronger|weaker|prefer|recommend)\b/i.test(
        body,
      );
    const answerHasSubstance =
      /\b(?:evidence shows|risk|verification|trade-?off|whereas|while|separate|distinct|because|likely|suspected|recommended)\b/i.test(
        body,
      );
    return (
      !hasComparisonLanguage || (!answerHasSubstance && countSubstantiveReportBullets(text) < 2)
    );
  }
  if (hasAuditDiagnosticReportIntent(task)) {
    const hasObservedConclusion =
      /\b(?:observed|found|evidence shows|risk|issue|failure|bounded|diagnosed|assessed|recommended|because)\b/i.test(
        body,
      );
    return !hasObservedConclusion && countSubstantiveReportBullets(text) < 1;
  }
  return (
    countSubstantiveReportBullets(text) === 0 &&
    !/\b(?:evidence shows|observed|found|recommended|risk|bounded|because)\b/i.test(body)
  );
}

export function buildHumanOutputReview(
  summary: string,
  transcript = '',
  context?: HumanOutputReviewContext,
): HumanOutputReview {
  const text = stripAnsi(`${summary}\n${transcript}`).trim();
  const internalLanguagePattern =
    /\b(?:Orchestrator|SWE Agent|QA Reviewer|CLI Executor|Stage\s+\d+\s*\/\s*\d+|v9 stack telemetry|prompt_manifest|selected_entry_ids|provider_model_id)\b/i;
  const isAsk = /^Babel Ask\b/m.test(text);
  const targetMatch = text.match(/Target:\n([^\n]+)/);
  const target = targetMatch?.[1]?.trim() ?? '';
  const targetBase = target
    ? (target.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '')
    : '';
  const absenceClaimPattern =
    /\b(?:not\s+(?:recognized|found|mentioned|listed|present)|does\s+not\s+appear|no\s+mention|none\s+reference|absent)\b/gi;
  const absenceClaim = absenceClaimPattern.test(text);
  // Only flag absence when the claim is ABOUT the target, not when the agent
  // correctly reports that a user-asked term (like "relic") doesn't exist
  let unsupportedAbsence = false;
  if (Boolean(targetBase) && absenceClaim) {
    // Reset lastIndex: .test() on a global regex advances lastIndex past the
    // match, causing subsequent .matchAll() to start from the wrong position.
    absenceClaimPattern.lastIndex = 0;
    const targetPattern = new RegExp(
      `\\b${targetBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    );
    // Require the absence claim and target mention to be within 120 chars
    // (same sentence/paragraph) — avoids false positives when the agent
    // correctly reports a different term as absent
    for (const match of text.matchAll(absenceClaimPattern)) {
      const near = text.substring(Math.max(0, match.index! - 120), match.index! + 120);
      if (targetPattern.test(near)) {
        unsupportedAbsence = true;
        break;
      }
    }
  }
  const effectiveTargetRoot = context?.expectedTargetRoot?.trim() || target || null;
  const targetScope = validatePlanTargetsWithinEffectiveRoots({
    effectiveTargetRoot,
    approvedRoots: [],
    targets: context?.executedTargets ?? [],
  });
  const blockedOrFailed =
    /\b(?:Blocked|Failed|EXECUTOR_HALTED|QA_REJECTED|FATAL_ERROR|Run blocked)\b/i.test(text) ||
    /HALTED|FAILED|ERROR|REJECTED/i.test(context?.terminalStatus ?? '');
  const verifiedBadge =
    /\bVERIFIED\b/i.test(context?.shellBadge ?? '') || /\[VERIFIED\]/i.test(text);
  const reportIntentMismatch = hasReportIntent(context?.task) && hasFutureOnlyReportLanguage(text);
  const reportDepthMismatch = reportDepthFailure(text, context);
  const checks: HumanOutputReview['checks'] = [
    {
      id: 'answer_first',
      status: /^Babel .+\n\n(?:[^\n]*\n)*\nAnswer:/m.test(text) ? 'pass' : 'fail',
      finding: 'Final human output starts with a Babel title, optional Target, then Answer.',
    },
    {
      id: 'status_accuracy',
      status:
        /Run Complete/i.test(text) && /EXECUTOR_HALTED|Run blocked|Blocked|Failed/i.test(text)
          ? 'fail'
          : 'pass',
      finding: 'Completion wording must not contradict blocked or failed status.',
    },
    {
      id: 'proof_sections',
      status:
        /Changed:\n/.test(text) &&
        /Verified:\n/.test(text) &&
        /Evidence:\n/.test(text) &&
        /Next:\n/.test(text)
          ? 'pass'
          : 'fail',
      finding: 'Summary includes changed files, verification, evidence, and next action.',
    },
    {
      id: 'target_disclosure',
      status: !isAsk || /Target:\n/.test(text) ? 'pass' : 'fail',
      finding: 'Read-only ask output discloses the local target root.',
    },
    {
      id: 'unsupported_absence_claim',
      status: unsupportedAbsence ? 'fail' : 'pass',
      finding: targetBase
        ? `Answer must not claim the target is absent when local evidence discloses target "${targetBase}".`
        : 'Answer must not claim the target is absent without local evidence.',
    },
    {
      id: 'target_consistency',
      status: contextTargetMismatch(target, context) ? 'fail' : 'pass',
      finding: 'Summary target must match the manifest/effective target root.',
    },
    {
      id: 'tool_target_scope',
      status: targetScope.ok ? 'pass' : 'fail',
      finding: 'Executed tool targets must stay inside the effective target or approved roots.',
    },
    {
      id: 'wrong_path_failure',
      status: hasWrongPathEnoent(text, context) ? 'fail' : 'pass',
      finding: 'Path-not-found failures must not reference a path outside the disclosed target.',
    },
    {
      id: 'blocked_badge_accuracy',
      status: blockedOrFailed && verifiedBadge ? 'fail' : 'pass',
      finding: 'Blocked or failed summaries cannot leave the shell badge in a verified state.',
    },
    {
      id: 'intent_fulfillment',
      status: reportIntentMismatch ? 'fail' : 'pass',
      finding:
        'Read-only report, compare, audit, or diagnostic requests must provide findings instead of only promising future analysis.',
    },
    {
      id: 'report_depth',
      status: reportDepthMismatch ? 'fail' : 'pass',
      finding:
        'Read-only report output must include concrete findings, comparisons, tradeoffs, risks, or recommendations.',
    },
    {
      id: 'internal_language',
      status: internalLanguagePattern.test(text) ? 'fail' : 'pass',
      finding: 'Default human output avoids internal control-plane labels.',
    },
    {
      id: 'stripped_readability',
      status: /^Babel .+/m.test(text) && /Answer:\n/.test(text) ? 'pass' : 'fail',
      finding: 'Persisted output is readable without ANSI control sequences.',
    },
  ];
  const failures = checks.filter((check) => check.status === 'fail');
  return {
    schema_version: 1,
    artifact_type: 'babel_human_output_review',
    status: failures.length === 0 ? 'pass' : 'needs_attention',
    score: checks.length - failures.length,
    checks,
    findings: failures.map((check) => check.finding),
  };
}

export function writeHumanSummaryArtifact(
  runDir: string | null | undefined,
  summary: string,
  transcript?: string | null,
): HumanOutputReview | null {
  if (!runDir) {
    return null;
  }
  try {
    const strippedSummary = stripAnsi(summary).trimEnd();
    const strippedTranscript =
      transcript !== undefined && transcript !== null ? stripAnsi(transcript).trimEnd() : '';
    writeFileSync(join(runDir, 'human_summary.txt'), `${strippedSummary}\n`, 'utf-8');
    if (transcript !== undefined && transcript !== null && transcript.trim().length > 0) {
      writeFileSync(join(runDir, 'terminal_transcript.txt'), `${strippedTranscript}\n`, 'utf-8');
    }
    const review = buildHumanOutputReview(
      strippedSummary,
      strippedTranscript,
      collectHumanOutputReviewContext(runDir, strippedSummary),
    );
    writeFileSync(
      join(runDir, 'output_review.json'),
      `${JSON.stringify(review, null, 2)}\n`,
      'utf-8',
    );
    writeProgressArtifact(runDir, strippedTranscript, extractProgressFallback(strippedSummary));
    return review;
  } catch {
    // Human summary artifacts are audit helpers; they must not change run success.
    return null;
  }
}

export function formatHumanOutputReviewNote(
  review: HumanOutputReview | null | undefined,
): string | null {
  if (!review || review.status !== 'needs_attention') {
    return null;
  }
  const failedIds = new Set(
    review.checks.filter((check) => check.status === 'fail').map((check) => check.id),
  );
  if (failedIds.has('intent_fulfillment') && failedIds.has('report_depth')) {
    return 'Output review: task asked for analysis but was routed as plan. Re-run with: babel report "your task" for actual findings';
  }
  if (failedIds.has('intent_fulfillment')) {
    return 'Output review: intent mismatch detected';
  }
  if (failedIds.has('report_depth')) {
    return 'Output review: report depth issue detected';
  }
  if (
    failedIds.has('target_consistency') ||
    failedIds.has('tool_target_scope') ||
    failedIds.has('wrong_path_failure')
  ) {
    return 'Output review: target mismatch detected';
  }
  return 'Output review: human output needs attention';
}

function extractProgressFallback(summary: string): string {
  const firstLine = summary
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  return firstLine ?? 'Run completed';
}

function parseProgressLine(line: string): { message: string; elapsed?: string } {
  const stripped = stripAnsi(line).trim();
  const elapsedMatch = stripped.match(
    /^\[(?<elapsed>\d{1,2}:\d{2}(?::\d{2})?)\]\s*(?<message>.+)$/,
  );
  if (elapsedMatch?.groups) {
    const elapsed = elapsedMatch.groups['elapsed'];
    return {
      message: elapsedMatch.groups['message']?.trim() ?? stripped,
      ...(elapsed !== undefined ? { elapsed } : {}),
    };
  }
  return {
    message: stripped.replace(/^\[[^\]]+\]\s*/, '').trim(),
  };
}

export function writeProgressArtifact(
  runDir: string | null | undefined,
  transcript?: string | null,
  fallbackMessage = 'Run completed',
): string | null {
  if (!runDir) {
    return null;
  }
  const lines: string[] = String(stripAnsi(String(transcript ?? '')))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const path = join(runDir, 'progress.jsonl');
  if (lines.length === 0 && existsSync(path)) {
    return path;
  }
  const events = (lines.length > 0 ? lines : [fallbackMessage]).map((line, index) => {
    const parsed = parseProgressLine(line);
    return JSON.stringify({
      type: 'progress',
      index,
      message: parsed.message,
      ...(parsed.elapsed !== undefined ? { elapsed: parsed.elapsed } : {}),
      source: 'terminal',
      ts: new Date().toISOString(),
    });
  });
  try {
    writeFileSync(path, `${events.join('\n')}\n`, 'utf-8');
    return path;
  } catch {
    return null;
  }
}

export function formatLiteResultHuman(payload: LiteResultPayload): string {
  return formatRunResultHuman(payload);
}

export function formatAskResultHuman(payload: AskResultPayload): string {
  return formatRunResultHuman(payload);
}

export function buildRunResultPayload(
  result: PipelineResult,
  context: RunOutputContext,
): Record<string, unknown> {
  const manifest = result.manifest;
  const compiledArtifacts = manifest.compiled_artifacts;
  const instructionStack = manifest.instruction_stack;
  const usageSummary = getUsageSummary(result);
  const verifier = result.verifierContractSummary;
  const checks = getChecks(result);
  const changedFiles = getChangedFiles(result);
  const status =
    context.mode === 'plan' && result.status === 'MANUAL_BRIDGE_REQUIRED'
      ? 'PLAN_READY'
      : result.status;
  const supportPath = result.manualPromptPath ?? result.repairPromptPath ?? result.runDir ?? null;
  const schemaRetry = getSchemaRetrySummary(result.runDir);
  const failure = isSuccessfulStatus(status) ? {} : getFailureArtifacts(result);
  const verification = buildVerificationPayload(result, checks);

  return {
    status,
    user_status: getUserFacingStatus({ status, verification, changedFiles }),
    ...(getInternalStatus(status, result.status) !== undefined
      ? { internal_status: result.status }
      : {}),
    command: context.mode === 'plan' ? 'plan' : 'run',
    mode: context.mode,
    task: context.task,
    project: context.project ?? manifest.target_project ?? null,
    run_dir: result.runDir,
    scope: buildScopePayload(result, context, changedFiles),
    changed_files: changedFiles,
    verification,
    checkpoint: buildCheckpointPayload(result.runDir, changedFiles),
    evidence: buildEvidencePayload({
      runDir: result.runDir,
      supportPath,
      artifacts: [
        result.runDir ? join(result.runDir, 'terminal_status_summary.json') : null,
        result.runDir ? join(result.runDir, 'verifier_execution_summary.json') : null,
        result.runDir ? join(result.runDir, 'worktree_safety_summary.json') : null,
        result.runDir ? join(result.runDir, 'cost_ledger.json') : null,
        result.terminalSummary?.failure_capsule_path ?? null,
      ],
    }),
    ...(result.finalAnswer ? { answer: { answer: result.finalAnswer } } : {}),
    checks,
    support_path: supportPath,
    next:
      status === 'PLAN_READY'
        ? [
            'Run babel "<task>" or babel plan when you are ready to apply the change.',
            'Use babel continue latest to inspect recovery state.',
          ]
        : isSuccessfulStatus(status)
          ? ['Review changed files and run your normal project verification before shipping.']
          : ['Run babel continue latest to inspect recovery state and the next command.'],
    ...schemaRetry,
    ...failure,
    manual_prompt_path: result.manualPromptPath ?? null,
    repair_prompt_path: result.repairPromptPath ?? null,
    errors: result.errors ?? [],
    routing: {
      orchestrator: context.orchestrator ?? 'v9',
      requested_model: context.requestedModel ?? null,
      requested_model_tier: context.requestedModelTier ?? null,
      target_project: manifest.target_project ?? null,
      task_category: manifest.analysis?.task_category ?? null,
      pipeline_mode: manifest.analysis?.pipeline_mode ?? null,
      domain_id: instructionStack?.domain_id ?? null,
      model_adapter_id: instructionStack?.model_adapter_id ?? null,
      selected_entry_ids: compiledArtifacts?.selected_entry_ids ?? [],
      prompt_manifest_count:
        compiledArtifacts?.prompt_manifest?.length ?? manifest.prompt_manifest?.length ?? 0,
    },
    tool_policy: {
      allowed_tools: context.allowedTools ?? [],
      disallowed_tools: context.disallowedTools ?? [],
    },
    terminal_status: result.terminalSummary ?? null,
    attempt_safety: result.attemptSafetySummary ?? null,
    requiredVerifierCount: verifier?.requiredVerifierCount ?? 0,
    requiredVerifierPassedCount: verifier?.requiredVerifierPassedCount ?? 0,
    requiredVerifierFailedCount: verifier?.requiredVerifierFailedCount ?? 0,
    requiredVerifierSkippedCount: verifier?.requiredVerifierSkippedCount ?? 0,
    verifierCompletionSatisfied: verifier?.verifierCompletionSatisfied ?? true,
    missingRequiredVerifiers: verifier?.missingRequiredVerifiers ?? [],
    skippedRequiredVerifiers: verifier?.skippedRequiredVerifiers ?? [],
    failedRequiredVerifiers: verifier?.failedRequiredVerifiers ?? [],
    artifacts: {
      terminal_status_summary: result.runDir
        ? join(result.runDir, 'terminal_status_summary.json')
        : null,
      verifier_plan: result.runDir ? join(result.runDir, 'verifier_plan.json') : null,
      verifier_execution_summary: result.runDir
        ? join(result.runDir, 'verifier_execution_summary.json')
        : null,
      attempt_safety_summary: result.attemptSafetySummary
        ? join(result.runDir, 'attempt_safety_summary.json')
        : null,
      repair_attempt_timeline: result.attemptSafetySummary
        ? join(result.runDir, 'repair_attempt_timeline.json')
        : null,
      worktree_safety_summary: result.runDir
        ? join(result.runDir, 'worktree_safety_summary.json')
        : null,
      cost_ledger: result.runDir ? join(result.runDir, 'cost_ledger.json') : null,
      rollback_summary: result.terminalSummary?.rollback_summary_path ?? null,
    },
    plan: result.plan
      ? {
          plan_type: result.plan.plan_type ?? null,
          task_summary: result.plan.task_summary ?? null,
          step_count: result.plan.minimal_action_set?.length ?? 0,
        }
      : null,
    usage: usageSummary,
    model_policy: result.modelPolicy ?? null,
  };
}

export function writeJson(payload: unknown): void {
  writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
}

export function writeNdjson(event: RunStreamEvent): void {
  writeStdout(`${JSON.stringify(event)}\n`);
  if (event.type === 'run_complete') {
    writeStdout(
      `${JSON.stringify(
        makeRunStreamEvent('turn.completed', {
          ...(event.result !== undefined ? { result: event.result } : {}),
          ...(event.status !== undefined ? { status: event.status } : {}),
        }),
      )}\n`,
    );
  } else if (event.type === 'run_error') {
    writeStdout(
      `${JSON.stringify(
        makeRunStreamEvent('turn.failed', {
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.result !== undefined ? { result: event.result } : {}),
        }),
      )}\n`,
    );
  }
}

export function makeRunStreamEvent(
  type: RunStreamEvent['type'],
  fields: Omit<RunStreamEvent, 'type' | 'ts'> = {},
): RunStreamEvent {
  return {
    type,
    ts: new Date().toISOString(),
    ...fields,
  };
}

function progressMessageForStage(index: number): string {
  if (index === 1) return 'Routing request';
  if (index === 2) return 'Planning';
  if (index === 3) return 'Reviewing';
  if (index === 4) return 'Applying';
  if (index === 5) return 'Running checks';
  return 'Working';
}

export function attachRunEventStream(eventBus: BabelEventBus, context: RunOutputContext): void {
  writeNdjson(
    makeRunStreamEvent('run_start', {
      task: context.task,
      mode: context.mode,
      project: context.project ?? null,
    }),
  );
  writeNdjson(
    makeRunStreamEvent('turn.started', {
      task: context.task,
      mode: context.mode,
      project: context.project ?? null,
    }),
  );

  eventBus.on('stage', (index: number) => {
    writeNdjson(
      makeRunStreamEvent('stage', {
        stage_index: index,
        stage_name: STAGE_NAMES[index] ?? `stage_${index}`,
      }),
    );
    writeNdjson(
      makeRunStreamEvent('progress', {
        stage_index: index,
        stage_name: STAGE_NAMES[index] ?? `stage_${index}`,
        message: progressMessageForStage(index),
      }),
    );
  });

  eventBus.on('agent_id', (agentId: string) => {
    writeNdjson(
      makeRunStreamEvent('agent_id', {
        agent_id: agentId,
      }),
    );
  });

  eventBus.on('log', (line: string) => {
    writeNdjson(
      makeRunStreamEvent('log', {
        line,
      }),
    );
    writeNdjson(
      makeRunStreamEvent('progress', {
        message: line,
      }),
    );
  });

  eventBus.on('assistant_chunk', (payload: { chunk: string; turn_id?: number }) => {
    writeNdjson(
      makeRunStreamEvent('assistant_chunk', {
        chunk: payload.chunk,
        ...(payload.turn_id !== undefined ? { turn_id: payload.turn_id } : {}),
      }),
    );
  });

  eventBus.on('runtime_event', (event: BabelRuntimeEvent) => {
    writeNdjson(
      makeRunStreamEvent('runtime_event', {
        runtime_event: event,
      }),
    );
  });
}
