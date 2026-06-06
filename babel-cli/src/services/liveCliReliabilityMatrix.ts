import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_ROOT } from '../cli/constants.js';
import {
  parseJsonObjectStdout,
  validateAutonomousLiveFailThenPassTimeline,
  type AutonomousRepairProofTimeline,
} from './autonomousRepairProofEvidence.js';
import { buildFailureCapsule, type FailureCapsule } from './repairGovernance.js';
import {
  buildVerifierPlan,
  reconcileVerifierPlan,
  summarizeVerifierContract,
} from './requiredVerifierContract.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';
import type { AttemptSafetySummary, TerminalStatusSummary } from './terminalStatus.js';
import type { WorktreeRollbackSummary, WorktreeSafetySummary } from './worktreeSafety.js';

export interface LiveCliReliabilityMatrixOptions {
  babelCliRoot?: string;
  outputDir?: string;
  caseFilter?: readonly string[];
  timeoutMs?: number;
  resumeDir?: string;
  onlyFailed?: boolean;
  fromCase?: string;
  now?: Date;
}

export interface LiveCliReliabilityCaseListing {
  schema_version: 1;
  report_type: 'babel_live_cli_reliability_case_list';
  generated_at: string;
  case_count: number;
  cases: LiveCliReliabilityCaseListEntry[];
}

export interface LiveCliReliabilityCaseListEntry {
  id: string;
  name: string;
  expected_status: string;
  timeout_ms: number;
}

export type LiveCliReliabilityFinalStatus = 'PASS' | 'FAILED' | 'INCOMPLETE' | 'TIMED_OUT';
export type LiveCliReliabilityReleaseGate = 'PASSED' | 'BLOCKED';
export type LiveCliReliabilityCaseStatus = 'passed' | 'failed' | 'timed_out' | 'skipped';

export interface LiveCliReliabilityReport {
  schema_version: 1;
  report_type: 'babel_live_cli_reliability_matrix';
  generated_at: string;
  matrix_root: string;
  artifact_path: string;
  summary_path: string;
  dist_index: string;
  final_status: LiveCliReliabilityFinalStatus;
  releaseGate: LiveCliReliabilityReleaseGate;
  summary: {
    total: number;
    passed: number;
    failed: number;
    timed_out: number;
    skipped: number;
    completed: number;
  };
  timed_out_cases: string[];
  failed_cases: string[];
  skipped_cases: string[];
  resume: {
    source_matrix_root: string | null;
    only_failed: boolean;
    from_case: string | null;
  };
  cases: LiveCliReliabilityCaseResult[];
}

export interface LiveCliReliabilityCaseResult {
  id: string;
  name: string;
  status: LiveCliReliabilityCaseStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  timeoutMs: number;
  command: string;
  expected_status: string;
  actual_status: string | null;
  terminal_status: string | null;
  exit_code: number | null;
  artifact_path: string;
  stdout_log_path: string | null;
  stderr_log_path: string | null;
  run_dir: string | null;
  last_known_babel_run_dir: string | null;
  pass: boolean;
  error: string | null;
  timeout_reason: string | null;
  notes: string[];
  details?: Record<string, unknown>;
  repair_attempts?: LiveCliReliabilityRepairAttempt[];
}

export interface LiveCliReliabilityRepairAttempt {
  attempt: number;
  kind: 'live_cli' | 'deterministic_stub' | 'injected_failure' | 'harness';
  command: string;
  status: string;
  exit_code: number | null;
  changed_files: string[];
  failed_command: string | null;
  verifier_command: string | null;
  verifier_cwd?: string | null;
  verifier_exit_code: number | null;
  verifier_stdout_summary?: string | null;
  verifier_stderr_summary?: string | null;
  failure_capsule_id?: string | null;
  failure_capsule_path?: string | null;
  input_capsule_id?: string | null;
  input_capsule_path?: string | null;
  input_capsule_consumed?: boolean;
  next_attempt_consumed_capsule?: boolean | null;
  repeated_failure_signature?: string | null;
  meaningful_diff_since_previous_attempt?: boolean | null;
  failure_capsule: FailureCapsule | null;
  rollback: {
    status: 'not_needed' | 'rolled_back' | 'carried_forward' | 'skipped';
    reason: string;
    files_restored: string[];
    files_removed: string[];
  };
}

interface MatrixCase {
  id: string;
  name: string;
  expectedStatus: string;
  timeoutMs?: number;
  prepare: (ctx: MatrixContext) => PreparedCase;
  execute?: (ctx: MatrixContext) => ExecutedCase;
  validate: (result: RawRunResult, prepared: PreparedCase) => { pass: boolean; notes: string[] };
}

interface MatrixContext {
  babelCliRoot: string;
  distIndex: string;
  matrixRoot: string;
  defaultTimeoutMs: number;
}

interface PreparedCase {
  root: string;
  args: string[];
  expectedStatus: string;
  filesToCheck?: string[];
  beforeFiles?: Record<string, FileFingerprint | null>;
  details?: Record<string, unknown>;
  repairAttempts?: LiveCliReliabilityRepairAttempt[];
}

interface ExecutedCase {
  prepared: PreparedCase;
  raw: RawRunResult;
}

interface RawRunResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  parsed: Record<string, unknown> | null;
  parseError: string | null;
  timedOut?: boolean;
  error?: string | null;
  signal?: NodeJS.Signals | null;
}

interface FileFingerprint {
  exists: boolean;
  size: number;
  mtimeMs: number;
  content: string | null;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export function runLiveCliReliabilityMatrix(
  options: LiveCliReliabilityMatrixOptions = {},
): LiveCliReliabilityReport {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const babelCliRoot = resolve(options.babelCliRoot ?? join(BABEL_ROOT, 'babel-cli'));
  const distIndex = join(babelCliRoot, 'dist', 'index.js');
  const outputRoot = resolve(options.outputDir ?? join(BABEL_ROOT, 'runs', 'live-cli-reliability'));
  const matrixRoot = resolve(options.resumeDir ?? join(outputRoot, `matrix-${formatTimestampForFile(now)}`));
  mkdirSync(matrixRoot, { recursive: true });

  const ctx: MatrixContext = {
    babelCliRoot,
    distIndex,
    matrixRoot,
    defaultTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const filter = new Set((options.caseFilter ?? []).map(value => value.trim()).filter(Boolean));
  let cases = buildMatrixCases().filter(testCase =>
    filter.size === 0 || filter.has(testCase.id) || filter.has(testCase.name),
  );
  if (options.fromCase) {
    const fromIndex = cases.findIndex(testCase => testCase.id === options.fromCase || testCase.name === options.fromCase);
    if (fromIndex >= 0) {
      cases = cases.slice(fromIndex);
    }
  }

  const previousResults = options.resumeDir
    ? loadPreviousMatrixResults(matrixRoot)
    : new Map<string, LiveCliReliabilityCaseResult>();
  const results = new Map<string, LiveCliReliabilityCaseResult>();
  for (const testCase of cases) {
    const previous = previousResults.get(testCase.id);
    if (previous && options.onlyFailed === true && previous.status === 'passed') {
      results.set(testCase.id, previous);
    }
  }

  writeMatrixReportSnapshot({
    generatedAt,
    ctx,
    cases,
    results,
    resumeDir: options.resumeDir ? matrixRoot : null,
    onlyFailed: options.onlyFailed === true,
    fromCase: options.fromCase ?? null,
  });

  for (const testCase of cases) {
    const previous = previousResults.get(testCase.id);
    const shouldRun = !(previous && options.onlyFailed === true && previous.status === 'passed');
    if (!shouldRun) {
      continue;
    }
    const result = runOneCase(testCase, ctx);
    results.set(testCase.id, result);
    writeMatrixReportSnapshot({
      generatedAt,
      ctx,
      cases,
      results,
      resumeDir: options.resumeDir ? matrixRoot : null,
      onlyFailed: options.onlyFailed === true,
      fromCase: options.fromCase ?? null,
    });
  }

  return writeMatrixReportSnapshot({
    generatedAt,
    ctx,
    cases,
    results,
    resumeDir: options.resumeDir ? matrixRoot : null,
    onlyFailed: options.onlyFailed === true,
    fromCase: options.fromCase ?? null,
  });
}

export function formatLiveCliReliabilityReportHuman(report: LiveCliReliabilityReport): string {
  const lines = [
    'Babel Live CLI Reliability Matrix',
    `Status: ${report.final_status} (${report.summary.passed}/${report.summary.total} passed, ${report.summary.timed_out} timed out)`,
    `Release gate: ${report.releaseGate}`,
    `Artifact: ${report.artifact_path}`,
    '',
    'Cases:',
  ];
  for (const result of report.cases) {
    lines.push(
      `- ${result.status.toUpperCase()} ${result.id}: expected=${result.expected_status}, actual=${result.actual_status ?? '(none)'}, exit=${result.exit_code ?? '(null)'}, duration=${result.durationMs ?? 0}ms`,
    );
    if (result.notes.length > 0) {
      lines.push(`  ${result.notes.join(' ')}`);
    }
  }
  return lines.join('\n');
}

export function listLiveCliReliabilityCases(now: Date = new Date()): LiveCliReliabilityCaseListing {
  const cases = buildMatrixCases().map((testCase) => ({
    id: testCase.id,
    name: testCase.name,
    expected_status: testCase.expectedStatus,
    timeout_ms: testCase.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }));
  return {
    schema_version: 1,
    report_type: 'babel_live_cli_reliability_case_list',
    generated_at: now.toISOString(),
    case_count: cases.length,
    cases,
  };
}

export function formatLiveCliReliabilityCaseListHuman(listing: LiveCliReliabilityCaseListing): string {
  const lines = [
    'Babel Live CLI Reliability Matrix Cases',
    `Cases: ${listing.case_count}`,
    '',
  ];
  for (const testCase of listing.cases) {
    lines.push(`- ${testCase.id} :: ${testCase.name} :: expected=${testCase.expected_status}`);
  }
  return lines.join('\n');
}

function writeMatrixReportSnapshot(input: {
  generatedAt: string;
  ctx: MatrixContext;
  cases: readonly MatrixCase[];
  results: ReadonlyMap<string, LiveCliReliabilityCaseResult>;
  resumeDir: string | null;
  onlyFailed: boolean;
  fromCase: string | null;
}): LiveCliReliabilityReport {
  const orderedResults = input.cases.map(testCase =>
    input.results.get(testCase.id) ?? makeSkippedCaseResult(testCase, input.ctx),
  );
  const timedOutCases = orderedResults.filter(result => result.status === 'timed_out').map(result => result.id);
  const failedCases = orderedResults.filter(result => result.status === 'failed').map(result => result.id);
  const skippedCases = orderedResults.filter(result => result.status === 'skipped').map(result => result.id);
  const finalStatus: LiveCliReliabilityFinalStatus = timedOutCases.length > 0
    ? 'TIMED_OUT'
    : skippedCases.length > 0
      ? 'INCOMPLETE'
      : failedCases.length > 0
        ? 'FAILED'
        : 'PASS';
  const report: LiveCliReliabilityReport = {
    schema_version: 1,
    report_type: 'babel_live_cli_reliability_matrix',
    generated_at: input.generatedAt,
    matrix_root: input.ctx.matrixRoot,
    artifact_path: join(input.ctx.matrixRoot, 'reliability-matrix.json'),
    summary_path: join(input.ctx.matrixRoot, 'reliability-matrix-summary.md'),
    dist_index: input.ctx.distIndex,
    final_status: finalStatus,
    releaseGate: finalStatus === 'PASS' ? 'PASSED' : 'BLOCKED',
    summary: {
      total: orderedResults.length,
      passed: orderedResults.filter(result => result.status === 'passed').length,
      failed: orderedResults.filter(result => result.status !== 'passed').length,
      timed_out: timedOutCases.length,
      skipped: skippedCases.length,
      completed: orderedResults.filter(result => result.status !== 'skipped').length,
    },
    timed_out_cases: timedOutCases,
    failed_cases: failedCases,
    skipped_cases: skippedCases,
    resume: {
      source_matrix_root: input.resumeDir,
      only_failed: input.onlyFailed,
      from_case: input.fromCase,
    },
    cases: orderedResults,
  };
  writeFileSync(report.artifact_path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(report.summary_path, `${formatLiveCliReliabilityReportMarkdown(report)}\n`, 'utf8');
  return report;
}

function makeSkippedCaseResult(testCase: MatrixCase, ctx: MatrixContext): LiveCliReliabilityCaseResult {
  const root = caseRoot(ctx, testCase.id);
  return {
    id: testCase.id,
    name: testCase.name,
    status: 'skipped',
    startedAt: null,
    endedAt: null,
    durationMs: null,
    timeoutMs: testCase.timeoutMs ?? ctx.defaultTimeoutMs,
    command: '(not run)',
    expected_status: testCase.expectedStatus,
    actual_status: null,
    terminal_status: null,
    exit_code: null,
    artifact_path: join(root, 'case-result.json'),
    stdout_log_path: null,
    stderr_log_path: null,
    run_dir: null,
    last_known_babel_run_dir: null,
    pass: false,
    error: 'Case has not run in this matrix snapshot.',
    timeout_reason: null,
    notes: ['case not run yet; matrix report is incomplete'],
  };
}

function formatLiveCliReliabilityReportMarkdown(report: LiveCliReliabilityReport): string {
  const lines = [
    '# Babel Live CLI Reliability Matrix',
    '',
    `- Final status: ${report.final_status}`,
    `- Release gate: ${report.releaseGate}`,
    `- Passed: ${report.summary.passed}/${report.summary.total}`,
    `- Failed or incomplete: ${report.summary.failed}`,
    `- Timed out: ${report.summary.timed_out}`,
    `- Skipped: ${report.summary.skipped}`,
    `- Artifact: ${report.artifact_path}`,
    '',
    '| Case | Status | Terminal | Exit | Duration | Notes |',
    '| --- | --- | --- | ---: | ---: | --- |',
  ];
  for (const result of report.cases) {
    lines.push([
      result.id,
      result.status,
      result.actual_status ?? '',
      String(result.exit_code ?? ''),
      result.durationMs === null ? '' : String(result.durationMs),
      result.notes.join(' ').replace(/\|/g, '/'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return lines.join('\n');
}

function loadPreviousMatrixResults(matrixRoot: string): Map<string, LiveCliReliabilityCaseResult> {
  const results = new Map<string, LiveCliReliabilityCaseResult>();
  const report = readJsonFile<LiveCliReliabilityReport>(join(matrixRoot, 'reliability-matrix.json'));
  if (report?.cases) {
    for (const result of report.cases) {
      results.set(result.id, normalizePreviousCaseResult(result));
    }
  }
  for (const artifactPath of findCaseResultFiles(matrixRoot)) {
    const artifact = readJsonFile<{ result?: LiveCliReliabilityCaseResult }>(artifactPath);
    if (artifact?.result?.id) {
      results.set(artifact.result.id, normalizePreviousCaseResult(artifact.result));
    }
  }
  return results;
}

function normalizePreviousCaseResult(result: LiveCliReliabilityCaseResult): LiveCliReliabilityCaseResult {
  const status = result.status ?? (result.pass ? 'passed' : 'failed');
  return {
    ...result,
    status,
    terminal_status: result.terminal_status ?? result.actual_status ?? null,
    stdout_log_path: result.stdout_log_path ?? null,
    stderr_log_path: result.stderr_log_path ?? null,
    last_known_babel_run_dir: result.last_known_babel_run_dir ?? result.run_dir ?? null,
    error: result.error ?? null,
    timeout_reason: result.timeout_reason ?? null,
  };
}

function findCaseResultFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSyncSafe(directory)) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name === 'case-result.json') {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function runOneCase(testCase: MatrixCase, ctx: MatrixContext): LiveCliReliabilityCaseResult {
  const started = new Date();
  const startedAt = started.toISOString();
  const timeoutMs = testCase.timeoutMs ?? ctx.defaultTimeoutMs;
  let executed: ExecutedCase;
  try {
    executed = testCase.execute
      ? testCase.execute(ctx)
      : (() => {
          const preparedCase = testCase.prepare(ctx);
          mkdirSync(preparedCase.root, { recursive: true });
          return {
            prepared: preparedCase,
            raw: runCommand(ctx, preparedCase.args, timeoutMs),
          };
        })();
  } catch (error) {
    const root = caseRoot(ctx, testCase.id);
    mkdirSync(root, { recursive: true });
    executed = {
      prepared: {
        root,
        args: [],
        expectedStatus: testCase.expectedStatus,
      },
      raw: {
        command: `matrix-harness --${testCase.id}`,
        stdout: '',
        stderr: '',
        exitCode: null,
        parsed: null,
        parseError: null,
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
        signal: null,
      },
    };
  }
  const ended = new Date();
  const prepared = executed.prepared;
  mkdirSync(prepared.root, { recursive: true });
  const raw = executed.raw;
  const timedOut = raw.timedOut === true;
  const validation = timedOut
    ? { pass: false, notes: [`case timed out after ${timeoutMs}ms`] }
    : testCase.validate(raw, prepared);
  const artifactPath = join(prepared.root, 'case-result.json');
  const stdoutLogPath = join(prepared.root, 'stdout.log');
  const stderrLogPath = join(prepared.root, 'stderr.log');
  writeFileSync(stdoutLogPath, raw.stdout, 'utf8');
  writeFileSync(stderrLogPath, raw.stderr, 'utf8');
  const actualStatus = stringValue(raw.parsed?.['status']);
  const runDir = stringValue(raw.parsed?.['run_dir']);
  const caseStatus: LiveCliReliabilityCaseStatus = timedOut
    ? 'timed_out'
    : validation.pass
      ? 'passed'
      : 'failed';
  const result: LiveCliReliabilityCaseResult = {
    id: testCase.id,
    name: testCase.name,
    status: caseStatus,
    startedAt,
    endedAt: ended.toISOString(),
    durationMs: ended.getTime() - started.getTime(),
    timeoutMs,
    command: raw.command,
    expected_status: prepared.expectedStatus,
    actual_status: actualStatus,
    terminal_status: actualStatus,
    exit_code: raw.exitCode,
    artifact_path: artifactPath,
    stdout_log_path: stdoutLogPath,
    stderr_log_path: stderrLogPath,
    run_dir: runDir,
    last_known_babel_run_dir: runDir ?? extractLastKnownRunDir(raw.stdout, raw.stderr),
    pass: validation.pass,
    error: raw.error ?? null,
    timeout_reason: timedOut
      ? `Case exceeded timeoutMs=${timeoutMs}.`
      : null,
    notes: [
      ...validation.notes,
      ...(raw.parseError ? [`stdout JSON parse error: ${raw.parseError}`] : []),
      ...(raw.stderr.trim() ? [`stderr: ${excerpt(raw.stderr)}`] : []),
      ...(raw.error ? [`error: ${raw.error}`] : []),
    ],
    ...(prepared.details ? { details: prepared.details } : {}),
    ...(prepared.repairAttempts ? { repair_attempts: prepared.repairAttempts } : {}),
  };
  writeFileSync(artifactPath, `${JSON.stringify({ result, stdout: raw.stdout, stderr: raw.stderr }, null, 2)}\n`, 'utf8');
  return result;
}

function runCommand(ctx: MatrixContext, args: string[], timeoutMs: number): RawRunResult {
  return runCommandWithEnv(ctx, args, timeoutMs, {});
}

function runCommandWithEnv(
  ctx: MatrixContext,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string>,
): RawRunResult {
  const command = [process.execPath, '--env-file=.env', ctx.distIndex, ...args].map(quoteArg).join(' ');
  const env = { ...process.env, ...extraEnv };
  delete env['BABEL_DRY_RUN'];
  const result = spawnSync(process.execPath, ['--env-file=.env', ctx.distIndex, ...args], {
    cwd: ctx.babelCliRoot,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const { parsed, parseError } = parseJsonObjectStdout(stdout);
  const error = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = error?.code === 'ETIMEDOUT';
  return {
    command,
    stdout,
    stderr,
    exitCode: result.status,
    parsed,
    parseError,
    timedOut,
    error: error
      ? `${error.code ?? error.name}: ${error.message}`
      : null,
    signal: result.signal,
  };
}

function buildMatrixCases(): MatrixCase[] {
  return [
    requiredVerifierAllPassCompleteCase(),
    requiredVerifierMissingBlocksCompleteCase(),
    requiredVerifierFailedBlocksCompleteCase(),
    requiredVerifierSkippedAfterPriorFailureBlocksCompleteCase(),
    optionalVerifierSkippedDoesNotBlockCompleteCase(),
    requiredVerifierJsonCleanlinessCase(),
    appEvalFalseCompleteRegressionCase(),
    exactCreateCase(),
    exactUpdateCase(),
    paraphraseRejectCase(),
    inspectOnlyReadOnlyCase(),
    directWriteRequestCase(),
    parallelSwarmWriteRequestCase(),
    failingUnitTestRepairCase(),
    autonomousNpmTestRepairCase(),
    autonomousNpmTypecheckRepairCase(),
    autonomousMissingVerifierHonestHaltCase(),
    autonomousSameFailureRepeatedHaltCase(),
    autonomousDirtyTreePreservedAfterFailedRepairCase(),
    jsonProtocolCleanlinessRepairFailureCase(),
    forcedFailThenPassRepairCase(),
    autonomousLiveFailThenPassRepairCase(),
    impossibleContradictoryCase(),
    ambiguousLiteralBindingCase(),
    jsonProtocolCleanlinessCase(),
    wrongWorkingDirectoryCase(),
    missingTestCommandCase(),
    dirtyGitTreeCase(),
    multipleSimilarFilenamesCase(),
    conflictingExactLiteralsCase(),
    readOnlyToolsWriteRequestCase(),
    testPassesExactFailsCase(),
    exactPassesTestFailsCase(),
    shellCommandDeniedSpecificStatusCase(),
    shellCommandFailedSpecificStatusCase(),
    rollbackOrSnapshotOnFailedRepairCase(),
    rollbackAppliedAfterFailedRepairCase(),
    rollbackPreservesUnrelatedDirtyFileCase(),
    dirtyTargetFileRefusesWithoutOverrideCase(),
    rollbackFailedSpecificStatusCase(),
    worktreeSafetyJsonCleanlinessCase(),
    jsonProtocolCleanlinessAllNonCompleteStatusesCase(),
    jsonProtocolNonCompleteCleanlinessCase(),
    repairMaxLoopsHonestCase(),
  ];
}

function requiredVerifierAllPassCompleteCase(): MatrixCase {
  return verifierContractHarnessCase({
    id: 'required_verifier_all_pass_complete',
    expectedStatus: 'COMPLETE',
    task: 'Verifier commands: npm run typecheck && npm test',
    toolCalls: [
      verifierToolCall(1, 'npm run typecheck', 0),
      verifierToolCall(2, 'npm test', 0),
    ],
    expectedComplete: true,
  });
}

function requiredVerifierMissingBlocksCompleteCase(): MatrixCase {
  return verifierContractHarnessCase({
    id: 'required_verifier_missing_blocks_complete',
    expectedStatus: 'REQUIRED_VERIFIER_MISSING',
    task: 'Verifier commands: npm run typecheck && npm test',
    toolCalls: [
      verifierToolCall(1, 'npm run typecheck', 0),
    ],
    expectedComplete: false,
  });
}

function requiredVerifierFailedBlocksCompleteCase(): MatrixCase {
  return verifierContractHarnessCase({
    id: 'required_verifier_failed_blocks_complete',
    expectedStatus: 'REQUIRED_VERIFIER_FAILED',
    task: 'Run npm test before completing.',
    toolCalls: [
      verifierToolCall(1, 'npm test', 1),
    ],
    expectedComplete: false,
  });
}

function requiredVerifierSkippedAfterPriorFailureBlocksCompleteCase(): MatrixCase {
  return verifierContractHarnessCase({
    id: 'required_verifier_skipped_after_prior_failure_blocks_complete',
    expectedStatus: 'REQUIRED_VERIFIER_SKIPPED',
    task: 'Verifier commands: npm run typecheck && npm test && npm run build',
    toolCalls: [
      verifierToolCall(1, 'npm run typecheck', 1),
    ],
    expectedComplete: false,
  });
}

function optionalVerifierSkippedDoesNotBlockCompleteCase(): MatrixCase {
  return verifierContractHarnessCase({
    id: 'optional_verifier_skipped_does_not_block_complete',
    expectedStatus: 'COMPLETE',
    task: 'Run npm test before completing. Run npm run lint if possible.',
    toolCalls: [
      verifierToolCall(1, 'npm test', 0),
    ],
    expectedComplete: true,
  });
}

function requiredVerifierJsonCleanlinessCase(): MatrixCase {
  return verifierContractHarnessCase({
    id: 'required_verifier_json_cleanliness',
    expectedStatus: 'REQUIRED_VERIFIER_MISSING',
    task: 'Verifier commands: npm run typecheck && npm test',
    toolCalls: [],
    expectedComplete: false,
    requireSingleJson: true,
  });
}

function appEvalFalseCompleteRegressionCase(): MatrixCase {
  return verifierContractHarnessCase({
    id: 'app_eval_false_complete_regression',
    expectedStatus: 'REQUIRED_VERIFIER_MISSING',
    task: 'App Worker Evaluation Harness task AWEH-009. Verifier commands: npm run typecheck && npm test -- --run && npm run build. Expected outcome: StatCard imports a new StatCardValue component and behavior remains unchanged.',
    toolCalls: [
      verifierToolCall(1, 'npm test -- --run', 0),
      verifierToolCall(2, 'npm run build', 0),
    ],
    expectedComplete: false,
  });
}

function verifierContractHarnessCase(input: {
  id: string;
  expectedStatus: string;
  task: string;
  toolCalls: ToolCallLog[];
  expectedComplete: boolean;
  requireSingleJson?: boolean;
}): MatrixCase {
  return {
    id: input.id,
    name: input.id.replace(/_/g, ' '),
    expectedStatus: input.expectedStatus,
    prepare: ctx => ({
      root: caseRoot(ctx, input.id),
      expectedStatus: input.expectedStatus,
      args: [],
    }),
    execute: ctx => {
      const root = caseRoot(ctx, input.id);
      mkdirSync(root, { recursive: true });
      const plan = buildVerifierPlan(input.task);
      const verifiers = reconcileVerifierPlan(plan, input.toolCalls);
      const summary = summarizeVerifierContract(verifiers);
      const status = summary.verifierCompletionSatisfied
        ? 'COMPLETE'
        : summary.completionBlockingStatus ?? 'VERIFIER_CONTRACT_UNSATISFIED';
      writeFileSync(join(root, 'verifier_plan.json'), `${JSON.stringify({ schema_version: 1, artifact_type: 'babel_verifier_plan', verifiers: plan }, null, 2)}\n`, 'utf8');
      writeFileSync(join(root, 'verifier_execution_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      const parsed = {
        status,
        requiredVerifierCount: summary.requiredVerifierCount,
        requiredVerifierPassedCount: summary.requiredVerifierPassedCount,
        requiredVerifierFailedCount: summary.requiredVerifierFailedCount,
        requiredVerifierSkippedCount: summary.requiredVerifierSkippedCount,
        verifierCompletionSatisfied: summary.verifierCompletionSatisfied,
        missingRequiredVerifiers: summary.missingRequiredVerifiers,
        skippedRequiredVerifiers: summary.skippedRequiredVerifiers,
        failedRequiredVerifiers: summary.failedRequiredVerifiers,
      };
      const raw: RawRunResult = {
        command: `matrix-harness --${input.id}`,
        stdout: `${JSON.stringify(parsed, null, 2)}\n`,
        stderr: '',
        exitCode: status === 'COMPLETE' ? 0 : 1,
        parsed,
        parseError: null,
      };
      return {
        prepared: {
          root,
          args: [],
          expectedStatus: input.expectedStatus,
          details: {
            verifier_plan: join(root, 'verifier_plan.json'),
            verifier_execution_summary: join(root, 'verifier_execution_summary.json'),
          },
        },
        raw,
      };
    },
    validate: result => {
      const status = stringValue(result.parsed?.['status']);
      const singleJson = result.parseError === null &&
        result.stdout.trim().startsWith('{') &&
        result.stdout.trim().endsWith('}');
      const satisfied = result.parsed?.['verifierCompletionSatisfied'] === true;
      return combineChecks([
        { pass: result.parseError === null, notes: ['stdout parsed as JSON'] },
        { pass: status === input.expectedStatus, notes: [`status=${status ?? '(none)'}`] },
        { pass: input.expectedComplete ? result.exitCode === 0 : result.exitCode !== 0, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        { pass: satisfied === input.expectedComplete, notes: [`verifierCompletionSatisfied=${String(result.parsed?.['verifierCompletionSatisfied'])}`] },
        ...(input.requireSingleJson ? [{ pass: singleJson, notes: ['stdout is exactly one JSON object'] }] : []),
      ]);
    },
  };
}

function verifierToolCall(step: number, command: string, exitCode: number): ToolCallLog {
  return {
    step,
    tool: 'test_run',
    target: command,
    exit_code: exitCode,
    stdout: exitCode === 0 ? 'verifier passed' : 'verifier failed',
    stderr: exitCode === 0 ? '' : 'AssertionError',
    verified: exitCode === 0,
  };
}

function exactCreateCase(): MatrixCase {
  return {
    id: 'autonomous_exact_file_create',
    name: 'autonomous exact file create',
    expectedStatus: 'COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'autonomous-exact-create');
      return {
        root,
        expectedStatus: 'COMPLETE',
        args: runArgs('autonomous', root, 'Create exact-status.txt containing the exact string "autonomous exact ok". The final file name must be exactly exact-status.txt.'),
      };
    },
    validate: (result, prepared) => expectStatus(result, 'COMPLETE', 0, [
      fileContentEquals(prepared.root, 'exact-status.txt', 'autonomous exact ok'),
    ]),
  };
}

function exactUpdateCase(): MatrixCase {
  return {
    id: 'autonomous_exact_file_update',
    name: 'autonomous exact file update',
    expectedStatus: 'COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'autonomous-exact-update');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'exact-status.txt'), 'old value', 'utf8');
      return {
        root,
        expectedStatus: 'COMPLETE',
        args: runArgs('autonomous', root, 'Update exact-status.txt so its entire contents are the exact string autonomous exact ok. The final file name must remain exactly exact-status.txt.'),
      };
    },
    validate: (result, prepared) => expectStatus(result, 'COMPLETE', 0, [
      fileContentEquals(prepared.root, 'exact-status.txt', 'autonomous exact ok'),
    ]),
  };
}

function paraphraseRejectCase(): MatrixCase {
  return {
    id: 'verified_paraphrase_rejection',
    name: 'verified paraphrase rejection',
    expectedStatus: 'EXACT_INSTRUCTION_DRIFT',
    prepare: ctx => {
      const root = caseRoot(ctx, 'verified-paraphrase');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'verifiedMode.js'), 'export function getStatus() { return "System operating in verified mode"; }', 'utf8');
      return {
        root,
        expectedStatus: 'EXACT_INSTRUCTION_DRIFT',
        args: runArgs(
          'verified',
          root,
          'Read src/verifiedMode.js. The implementation must return the exact string verified live ok. Do not modify files; inspect only.',
          ['--allowed-tools', 'directory_list,file_read'],
        ),
      };
    },
    validate: result => expectStatus(result, 'EXACT_INSTRUCTION_DRIFT', 1, [
      noteWhen(result.exitCode !== 0, 'nonzero exit confirmed'),
    ]),
  };
}

function inspectOnlyReadOnlyCase(): MatrixCase {
  return {
    id: 'inspect_only_read_only_returns_complete_no_modification',
    name: 'inspect-only read-only returns no-modification status',
    expectedStatus: 'COMPLETE_NO_MODIFICATION_OR_READ_ONLY_NO_MODIFICATION',
    prepare: ctx => {
      const root = caseRoot(ctx, 'inspect-only');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'info.txt'), 'ready\n', 'utf8');
      return {
        root,
        expectedStatus: 'COMPLETE_NO_MODIFICATION_OR_READ_ONLY_NO_MODIFICATION',
        beforeFiles: { 'src/info.txt': fingerprint(join(root, 'src', 'info.txt')) },
        args: runArgs(
          'verified',
          root,
          'Inspect src/info.txt and determine whether it mentions ready. Do not modify files.',
          ['--allowed-tools', 'directory_list,file_read'],
        ),
      };
    },
    validate: (result, prepared) => {
      const status = stringValue(result.parsed?.['status']);
      const unchanged = sameFingerprint(prepared.beforeFiles?.['src/info.txt'] ?? null, fingerprint(join(prepared.root, 'src', 'info.txt')));
      return combineChecks([
        {
          pass: status === 'COMPLETE_NO_MODIFICATION' || status === 'READ_ONLY_NO_MODIFICATION',
          notes: [`status=${status ?? '(none)'}`],
        },
        { pass: result.exitCode === 0, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        { pass: unchanged, notes: [unchanged ? 'read-only fixture unchanged' : 'read-only fixture changed'] },
        { pass: status !== 'RUN_FAILED', notes: ['read-only task did not return generic RUN_FAILED'] },
      ]);
    },
  };
}

function directWriteRequestCase(): MatrixCase {
  return {
    id: 'direct_mode_file_write_request',
    name: 'direct mode file-writing request',
    expectedStatus: 'DIRECT_MODE_NO_EXECUTOR',
    prepare: ctx => {
      const root = caseRoot(ctx, 'direct-write');
      return {
        root,
        expectedStatus: 'DIRECT_MODE_NO_EXECUTOR',
        args: runArgs('direct', root, 'Create direct-status.txt containing the exact string "direct exact ok".'),
      };
    },
    validate: (result, prepared) => expectStatus(result, 'DIRECT_MODE_NO_EXECUTOR', 1, [
      missingFile(prepared.root, 'direct-status.txt'),
    ]),
  };
}

function parallelSwarmWriteRequestCase(): MatrixCase {
  return {
    id: 'parallel_swarm_file_write_request',
    name: 'parallel_swarm file-writing request',
    expectedStatus: 'NON_COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'parallel-swarm-write');
      return {
        root,
        expectedStatus: 'NON_COMPLETE',
        args: runArgs('parallel_swarm', root, 'Create swarm-status.txt containing the exact string "swarm exact ok".'),
      };
    },
    validate: (result, prepared) => expectNonComplete(result, [
      missingFile(prepared.root, 'swarm-status.txt'),
    ]),
  };
}

function failingUnitTestRepairCase(): MatrixCase {
  return {
    id: 'failing_unit_test_repair',
    name: 'failing unit test repair on a small fixture',
    expectedStatus: 'COMPLETE',
    timeoutMs: 420_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'unit-test-repair');
      prepareMathRepairFixture(root);
      return {
        root,
        expectedStatus: 'COMPLETE',
        args: runArgs(
          'autonomous',
          root,
          'Fix the failing Node test in this project. Only edit src/math.js. Run node --test before completing. The final src/math.js implementation must contain the exact string "return a + b;". Do not use literal <target_project_path> as a working directory.',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const testResult = spawnSync(process.execPath, ['--test'], {
        cwd: prepared.root,
        encoding: 'utf8',
        timeout: 60_000,
      });
      return expectStatus(result, 'COMPLETE', 0, [
        {
          pass: testResult.status === 0,
          notes: [testResult.status === 0 ? 'node --test passes' : `node --test failed: ${excerpt(testResult.stderr ?? testResult.stdout ?? '')}`],
        },
      ]);
    },
  };
}

function autonomousNpmTestRepairCase(): MatrixCase {
  return {
    id: 'autonomous_npm_test_repair',
    name: 'autonomous npm test verifier-driven retry',
    expectedStatus: 'COMPLETE',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'autonomous-npm-test-repair');
      prepareFlakyNpmTestRepairFixture(root);
      return {
        root,
        expectedStatus: 'COMPLETE',
        args: runArgs(
          'autonomous',
          root,
          'Fix the failing npm test in this project. Only edit src/math.js. Run npm test before completing. The final src/math.js implementation must contain the exact string "return a + b;".',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const timeline = readRepairTimelineFromRun(result);
      const safety = readAttemptSafetySummaryFromRun(result);
      const finalTest = spawnSync('npm', ['test', '--silent'], {
        cwd: prepared.root,
        encoding: 'utf8',
        timeout: 60_000,
        shell: process.platform === 'win32',
      });
      return combineChecks([
        expectStatus(result, 'COMPLETE', 0, []),
        validateGenericVerifierRetryTimeline(timeline, {
          expectedFinalStatus: 'COMPLETE',
          expectedCommand: 'npm test',
          expectedProofKind: 'fully_autonomous',
        }),
        validateAttemptSafetySummary(safety),
        {
          pass: finalTest.status === 0,
          notes: [finalTest.status === 0 ? 'npm test passes after retry' : `npm test failed after run: ${excerpt(finalTest.stderr ?? finalTest.stdout ?? '')}`],
        },
      ]);
    },
  };
}

function autonomousNpmTypecheckRepairCase(): MatrixCase {
  return {
    id: 'autonomous_npm_typecheck_repair',
    name: 'autonomous npm typecheck verifier-driven retry',
    expectedStatus: 'COMPLETE',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'autonomous-npm-typecheck-repair');
      prepareFlakyNpmTypecheckRepairFixture(root);
      return {
        root,
        expectedStatus: 'COMPLETE',
        args: runArgs(
          'autonomous',
          root,
          'Fix the TypeScript type error in src/index.ts. Only edit src/index.ts. Run npm run typecheck before completing. The final src/index.ts implementation must contain the exact string "export const answer: number = 42;".',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const timeline = readRepairTimelineFromRun(result);
      const safety = readAttemptSafetySummaryFromRun(result);
      const finalTypecheck = spawnSync('npm', ['run', 'typecheck', '--silent'], {
        cwd: prepared.root,
        encoding: 'utf8',
        timeout: 60_000,
        shell: process.platform === 'win32',
      });
      return combineChecks([
        expectStatus(result, 'COMPLETE', 0, []),
        validateGenericVerifierRetryTimeline(timeline, {
          expectedFinalStatus: 'COMPLETE',
          expectedCommand: 'npm run typecheck',
          expectedProofKind: 'fully_autonomous',
        }),
        validateAttemptSafetySummary(safety),
        {
          pass: finalTypecheck.status === 0,
          notes: [finalTypecheck.status === 0 ? 'npm run typecheck passes after retry' : `typecheck failed after run: ${excerpt(finalTypecheck.stderr ?? finalTypecheck.stdout ?? '')}`],
        },
      ]);
    },
  };
}

function autonomousMissingVerifierHonestHaltCase(): MatrixCase {
  return {
    id: 'autonomous_missing_verifier_honest_halt',
    name: 'autonomous missing verifier honest halt',
    expectedStatus: 'VERIFIER_NOT_FOUND_OR_ROLLBACK_APPLIED',
    timeoutMs: 420_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'autonomous-missing-verifier');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
      writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
      return {
        root,
        expectedStatus: 'VERIFIER_NOT_FOUND_OR_ROLLBACK_APPLIED',
        args: runArgs(
          'autonomous',
          root,
          'Fix src/math.js so add returns a + b. Only edit src/math.js. Run npm test before completing.',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: result => {
      const timeline = readRepairTimelineFromRun(result);
      const safety = readAttemptSafetySummaryFromRun(result);
      const status = stringValue(result.parsed?.['status']);
      return combineChecks([
        {
          pass: status === 'VERIFIER_NOT_FOUND' || status === 'ROLLBACK_APPLIED',
          notes: [`status=${status ?? '(none)'}`],
        },
        { pass: result.exitCode === 1, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        validateVerifierFailureTimeline(timeline, status ?? 'VERIFIER_NOT_FOUND'),
        validateAttemptSafetySummary(safety),
      ]);
    },
  };
}

function autonomousSameFailureRepeatedHaltCase(): MatrixCase {
  return {
    id: 'autonomous_same_failure_repeated_halt',
    name: 'autonomous repeated same verifier failure halt',
    expectedStatus: 'REPAIR_REPEATED_FAILURE',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'autonomous-same-failure-repeated');
      prepareAlwaysFailingNpmTestFixture(root);
      return {
        root,
        expectedStatus: 'REPAIR_REPEATED_FAILURE',
        args: runArgs(
          'autonomous',
          root,
          'Fix the failing npm test in this project. Only edit src/math.js. Run npm test before completing.',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: result => {
      const timeline = readRepairTimelineFromRun(result);
      const safety = readAttemptSafetySummaryFromRun(result);
      const status = stringValue(result.parsed?.['status']);
      return combineChecks([
        {
          pass: status === 'REPAIR_REPEATED_FAILURE' ||
            status === 'REPAIR_MAX_ATTEMPTS_REACHED' ||
            status === 'ROLLBACK_APPLIED' ||
            status === 'ROLLBACK_FAILED',
          notes: [`status=${status ?? '(none)'}`],
        },
        { pass: result.exitCode === 1, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        validateVerifierFailureTimeline(timeline, status ?? 'REPAIR_REPEATED_FAILURE'),
        validateAttemptSafetySummary(safety),
        {
          pass: (timeline?.attempts ?? []).some(attempt => Boolean(attempt.repeated_failure_signature)),
          notes: [(timeline?.attempts ?? []).some(attempt => Boolean(attempt.repeated_failure_signature)) ? 'repeated failure signature recorded' : 'repeated failure signature missing'],
        },
      ]);
    },
  };
}

function autonomousDirtyTreePreservedAfterFailedRepairCase(): MatrixCase {
  return {
    id: 'autonomous_dirty_tree_preserved_after_failed_repair',
    name: 'autonomous failed repair preserves unrelated dirty file',
    expectedStatus: 'NON_COMPLETE',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'autonomous-dirty-preserved-failed-repair');
      prepareAlwaysFailingNpmTestFixture(root);
      writeFileSync(join(root, 'src', 'dirty.txt'), 'keep this exact dirty content\n', 'utf8');
      return {
        root,
        expectedStatus: 'NON_COMPLETE',
        beforeFiles: {
          'rollback-target.txt': fingerprint(join(root, 'rollback-target.txt')),
          'src/dirty.txt': fingerprint(join(root, 'src', 'dirty.txt')),
        },
        args: runArgs(
          'autonomous',
          root,
          `${rollbackCreateFileTask()} Do not modify src/dirty.txt.`,
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const timeline = readRepairTimelineFromRun(result);
      const safety = readAttemptSafetySummaryFromRun(result);
      return combineChecks([
        expectNonComplete(result, []),
        validateVerifierFailureTimeline(timeline, stringValue(result.parsed?.['status']) ?? 'NON_COMPLETE'),
        validateAttemptSafetySummary(safety, { expectUserPreserved: true }),
        {
          pass: sameFingerprint(prepared.beforeFiles?.['src/dirty.txt'] ?? null, fingerprint(join(prepared.root, 'src', 'dirty.txt'))),
          notes: ['unrelated dirty file preserved after failed repair'],
        },
        {
          pass: !existsSync(join(prepared.root, 'rollback-target.txt')),
          notes: ['created rollback target removed after failed repair'],
        },
      ]);
    },
  };
}

function jsonProtocolCleanlinessRepairFailureCase(): MatrixCase {
  return {
    id: 'json_protocol_cleanliness_repair_failure',
    name: '--json protocol cleanliness on repair failure',
    expectedStatus: 'NON_COMPLETE_JSON_ONLY',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'json-cleanliness-repair-failure');
      prepareAlwaysFailingNpmTestFixture(root);
      return {
        root,
        expectedStatus: 'NON_COMPLETE_JSON_ONLY',
        args: runArgs(
          'autonomous',
          root,
          'Fix the failing npm test in this project. Only edit src/math.js. Run npm test before completing.',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: result => {
      const trimmed = result.stdout.trim();
      const status = stringValue(result.parsed?.['status']);
      const safety = readAttemptSafetySummaryFromRun(result);
      const cleanJson = result.parseError === null && trimmed.startsWith('{') && trimmed.endsWith('}');
      return combineChecks([
        { pass: cleanJson, notes: [cleanJson ? 'repair failure stdout is exactly one JSON object' : 'repair failure stdout is not clean JSON'] },
        { pass: status !== null && status !== 'COMPLETE', notes: [`status=${status ?? '(none)'}`] },
        { pass: result.exitCode === 1, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        validateAttemptSafetySummary(safety),
      ]);
    },
  };
}

function forcedFailThenPassRepairCase(): MatrixCase {
  return {
    id: 'forced_fail_then_pass_repair',
    name: 'forced fail-then-pass repair validation',
    expectedStatus: 'COMPLETE',
    timeoutMs: 480_000,
    prepare: ctx => ({
      root: caseRoot(ctx, 'forced-fail-then-pass'),
      expectedStatus: 'COMPLETE',
      args: [],
    }),
    execute: ctx => runForcedFailThenPassRepair(ctx),
    validate: (result, prepared) => {
      const attempts = prepared.repairAttempts ?? [];
      const first = attempts[0];
      const second = attempts[1];
      const statusCheck = expectStatus(result, 'COMPLETE', 0, []);
      const finalTest = spawnSync(process.execPath, ['--test'], {
        cwd: prepared.root,
        encoding: 'utf8',
        timeout: 60_000,
      });
      return combineChecks([
        { pass: attempts.length >= 2, notes: [`attempt_count=${attempts.length}`] },
        { pass: first?.failure_capsule?.retryable === true, notes: [`attempt_1_capsule=${first?.failure_capsule?.failure_code ?? '(none)'}`] },
        { pass: first?.rollback.status === 'rolled_back', notes: [`attempt_1_rollback=${first?.rollback.status ?? '(none)'}`] },
        { pass: second?.kind === 'live_cli', notes: [`attempt_2_kind=${second?.kind ?? '(none)'}`] },
        statusCheck,
        {
          pass: finalTest.status === 0,
          notes: [finalTest.status === 0 ? 'final verifier node --test passes' : `final verifier failed: ${excerpt(finalTest.stderr ?? finalTest.stdout ?? '')}`],
        },
        {
          pass: second?.changed_files.length === 1 && second.changed_files[0] === 'src/math.js',
          notes: [`attempt_2_changed_files=${second?.changed_files.join(',') ?? '(none)'}`],
        },
      ]);
    },
  };
}

function autonomousLiveFailThenPassRepairCase(): MatrixCase {
  return {
    id: 'autonomous_live_fail_then_pass_repair',
    name: 'true autonomous live fail-then-pass repair proof',
    expectedStatus: 'COMPLETE',
    timeoutMs: 540_000,
    prepare: ctx => ({
      root: caseRoot(ctx, 'autonomous-live-fail-then-pass'),
      expectedStatus: 'COMPLETE',
      args: [],
    }),
    execute: ctx => runAutonomousLiveFailThenPassRepair(ctx),
    validate: (result, prepared) => {
      const timeline = prepared.details?.['repair_timeline'] as AutonomousRepairProofTimeline | undefined;
      const timelineValidation = timeline
        ? validateAutonomousLiveFailThenPassTimeline(timeline)
        : { pass: false, notes: ['repair timeline missing'] };
      const finalTest = spawnSync(process.execPath, ['--test'], {
        cwd: prepared.root,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const finalContent = existsSync(join(prepared.root, 'src', 'math.js'))
        ? readFileSync(join(prepared.root, 'src', 'math.js'), 'utf8')
        : '';
      return combineChecks([
        expectStatus(result, 'COMPLETE', 0, []),
        timelineValidation,
        {
          pass: finalTest.status === 0,
          notes: [finalTest.status === 0 ? 'final verifier node --test passes' : `final verifier failed: ${excerpt(finalTest.stderr ?? finalTest.stdout ?? '')}`],
        },
        {
          pass: /return a \+ b;/.test(finalContent),
          notes: [/return a \+ b;/.test(finalContent) ? 'final content corrected' : 'final content missing return a + b'],
        },
        {
          pass: sameFingerprint(prepared.beforeFiles?.['src/dirty.txt'] ?? null, fingerprint(join(prepared.root, 'src', 'dirty.txt'))),
          notes: ['unrelated dirty file preserved'],
        },
        {
          pass: Array.isArray(prepared.details?.['unrelated_changed_files']) &&
            (prepared.details?.['unrelated_changed_files'] as unknown[]).length === 0,
          notes: [`unrelated_changed_files=${String((prepared.details?.['unrelated_changed_files'] as unknown[] | undefined)?.join(',') ?? '') || '(none)'}`],
        },
      ]);
    },
  };
}

function impossibleContradictoryCase(): MatrixCase {
  return {
    id: 'impossible_contradictory_task',
    name: 'impossible or contradictory task',
    expectedStatus: 'NON_COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'impossible-contradictory');
      return {
        root,
        expectedStatus: 'NON_COMPLETE',
        args: runArgs(
          'autonomous',
          root,
          'Create impossible.txt containing the exact string "impossible ok". Also do not modify files; inspect only.',
          ['--allowed-tools', 'directory_list,file_read'],
        ),
      };
    },
    validate: (result, prepared) => expectNonComplete(result, [
      missingFile(prepared.root, 'impossible.txt'),
    ]),
  };
}

function ambiguousLiteralBindingCase(): MatrixCase {
  return {
    id: 'ambiguous_multi_file_literal_binding',
    name: 'ambiguous multi-file/multi-literal binding',
    expectedStatus: 'AMBIGUOUS_LITERAL_BINDING',
    prepare: ctx => {
      const root = caseRoot(ctx, 'ambiguous-literal-binding');
      return {
        root,
        expectedStatus: 'AMBIGUOUS_LITERAL_BINDING',
        args: runArgs('autonomous', root, 'Create a.txt and b.txt containing the exact strings alpha and beta.'),
      };
    },
    validate: result => {
      const status = stringValue(result.parsed?.['status']);
      return combineChecks([
        { pass: status === 'AMBIGUOUS_LITERAL_BINDING', notes: [`status=${status ?? '(none)'}`] },
        { pass: result.exitCode !== 0, notes: [result.exitCode !== 0 ? 'nonzero exit confirmed' : 'unexpected zero exit'] },
      ]);
    },
  };
}

function jsonProtocolCleanlinessCase(): MatrixCase {
  return {
    id: 'json_protocol_cleanliness',
    name: '--json protocol cleanliness',
    expectedStatus: 'VALID_JSON_ONLY',
    prepare: ctx => {
      const root = caseRoot(ctx, 'json-cleanliness');
      return {
        root,
        expectedStatus: 'VALID_JSON_ONLY',
        args: runArgs('autonomous', root, 'Create json-clean.txt containing the exact string "json clean ok".'),
      };
    },
    validate: result => {
      const trimmed = result.stdout.trim();
      const cleanJson = result.parseError === null && trimmed.startsWith('{') && trimmed.endsWith('}');
      return combineChecks([
        { pass: cleanJson, notes: [cleanJson ? 'stdout is exactly one JSON object' : 'stdout is not clean JSON'] },
        { pass: stringValue(result.parsed?.['status']) === 'COMPLETE', notes: [`status=${stringValue(result.parsed?.['status']) ?? '(none)'}`] },
      ]);
    },
  };
}

function wrongWorkingDirectoryCase(): MatrixCase {
  return {
    id: 'wrong_working_directory',
    name: 'wrong working directory nested test repair',
    expectedStatus: 'COMPLETE',
    timeoutMs: 480_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'wrong-working-directory');
      const appRoot = join(root, 'app');
      mkdirSync(join(appRoot, 'src'), { recursive: true });
      mkdirSync(join(appRoot, 'test'), { recursive: true });
      writeNodeTestPackage(appRoot);
      writeFileSync(join(appRoot, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
      writeMathTest(appRoot);
      return {
        root,
        expectedStatus: 'COMPLETE',
        args: runArgs(
          'autonomous',
          root,
          'The Node project is in the app subdirectory. Fix the failing test by editing only app/src/math.js. Run npm test from app before completing.',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const testResult = spawnSync(process.execPath, ['--test'], {
        cwd: join(prepared.root, 'app'),
        encoding: 'utf8',
        timeout: 60_000,
      });
      return expectStatus(result, 'COMPLETE', 0, [
        {
          pass: testResult.status === 0,
          notes: [testResult.status === 0 ? 'nested app node --test passes' : `nested app test failed: ${excerpt(testResult.stderr ?? testResult.stdout ?? '')}`],
        },
      ]);
    },
  };
}

function missingTestCommandCase(): MatrixCase {
  return {
    id: 'missing_test_command',
    name: 'missing test command',
    expectedStatus: 'NON_COMPLETE',
    timeoutMs: 360_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'missing-test-command');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
      return {
        root,
        expectedStatus: 'NON_COMPLETE',
        args: runArgs(
          'autonomous',
          root,
          'Create missing-test.txt containing the exact string "missing test ok". Run npm test before completing.',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: result => expectNonComplete(result, [
      {
        pass: stringValue(result.parsed?.['status']) !== 'COMPLETE',
        notes: ['missing test command did not produce final COMPLETE'],
      },
    ]),
  };
}

function dirtyGitTreeCase(): MatrixCase {
  return {
    id: 'dirty_git_tree',
    name: 'dirty git tree preservation',
    expectedStatus: 'COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'dirty-git-tree');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'dirty.txt'), 'keep me dirty\n', 'utf8');
      spawnSync('git', ['init'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
      return {
        root,
        expectedStatus: 'COMPLETE',
        beforeFiles: { 'src/dirty.txt': fingerprint(join(root, 'src', 'dirty.txt')) },
        args: runArgs('autonomous', root, 'Create git-status.txt containing the exact string "dirty tree ok". Do not modify src/dirty.txt.'),
      };
    },
    validate: (result, prepared) => expectStatus(result, 'COMPLETE', 0, [
      fileContentEquals(prepared.root, 'git-status.txt', 'dirty tree ok'),
      {
        pass: sameFingerprint(prepared.beforeFiles?.['src/dirty.txt'] ?? null, fingerprint(join(prepared.root, 'src', 'dirty.txt'))),
        notes: ['dirty tree file preserved'],
      },
    ]),
  };
}

function multipleSimilarFilenamesCase(): MatrixCase {
  return {
    id: 'multiple_similar_filenames',
    name: 'multiple similar filenames',
    expectedStatus: 'COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'multiple-similar-filenames');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'status.txt'), 'do not touch', 'utf8');
      writeFileSync(join(root, 'status-final.txt'), 'old', 'utf8');
      return {
        root,
        expectedStatus: 'COMPLETE',
        beforeFiles: { 'status.txt': fingerprint(join(root, 'status.txt')) },
        args: runArgs('autonomous', root, 'Update status-final.txt so its entire contents are the exact string final exact ok. Do not modify status.txt.'),
      };
    },
    validate: (result, prepared) => expectStatus(result, 'COMPLETE', 0, [
      fileContentEquals(prepared.root, 'status-final.txt', 'final exact ok'),
      {
        pass: sameFingerprint(prepared.beforeFiles?.['status.txt'] ?? null, fingerprint(join(prepared.root, 'status.txt'))),
        notes: ['similar filename status.txt preserved'],
      },
    ]),
  };
}

function conflictingExactLiteralsCase(): MatrixCase {
  return {
    id: 'conflicting_exact_literals',
    name: 'conflicting exact literals',
    expectedStatus: 'NON_COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'conflicting-exact-literals');
      return {
        root,
        expectedStatus: 'NON_COMPLETE',
        args: runArgs('autonomous', root, 'Create conflict.txt so its entire contents are the exact string alpha. Also its entire contents must be the exact string beta.'),
      };
    },
    validate: result => expectNonComplete(result, [
      { pass: stringValue(result.parsed?.['status']) !== 'COMPLETE', notes: ['conflicting exact literals did not complete'] },
    ]),
  };
}

function readOnlyToolsWriteRequestCase(): MatrixCase {
  return {
    id: 'read_only_tools_write_request',
    name: 'read-only tools with write request',
    expectedStatus: 'NON_COMPLETE',
    prepare: ctx => {
      const root = caseRoot(ctx, 'read-only-write-request');
      return {
        root,
        expectedStatus: 'NON_COMPLETE',
        args: runArgs(
          'autonomous',
          root,
          'Create readonly-blocked.txt containing the exact string "blocked ok".',
          ['--allowed-tools', 'directory_list,file_read'],
        ),
      };
    },
    validate: (result, prepared) => expectNonComplete(result, [
      missingFile(prepared.root, 'readonly-blocked.txt'),
    ]),
  };
}

function testPassesExactFailsCase(): MatrixCase {
  return {
    id: 'test_passes_but_exact_invariant_fails',
    name: 'test passes but exact invariant fails',
    expectedStatus: 'EXACT_INSTRUCTION_DRIFT',
    prepare: ctx => {
      const root = caseRoot(ctx, 'test-passes-exact-fails');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'test'), { recursive: true });
      writeNodeTestPackage(root);
      writeFileSync(join(root, 'src', 'status.js'), 'export function status() { return "almost exact"; }\n', 'utf8');
      writeFileSync(join(root, 'test', 'status.test.js'), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { status } from '../src/status.js';",
        "test('status is a string', () => assert.equal(typeof status(), 'string'));",
        '',
      ].join('\n'), 'utf8');
      return {
        root,
        expectedStatus: 'EXACT_INSTRUCTION_DRIFT',
        args: runArgs(
          'verified',
          root,
          'Inspect src/status.js. The implementation must return the exact string exact live ok. Run npm test if possible. Do not modify files.',
          ['--allowed-tools', 'directory_list,file_read'],
        ),
      };
    },
    validate: result => expectStatus(result, 'EXACT_INSTRUCTION_DRIFT', 1, [
      { pass: true, notes: ['passing tests did not override exact invariant failure'] },
    ]),
  };
}

function exactPassesTestFailsCase(): MatrixCase {
  return {
    id: 'exact_invariant_passes_but_test_fails_specific_status',
    name: 'exact invariant passes but test fails with specific status',
    expectedStatus: 'VERIFIER_FAILED',
    timeoutMs: 360_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'exact-passes-test-fails');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'test'), { recursive: true });
      writeNodeTestPackage(root);
      writeFileSync(join(root, 'exact-status.txt'), 'exact already ok', 'utf8');
      writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
      writeMathTest(root);
      return {
        root,
        expectedStatus: 'VERIFIER_FAILED',
        args: runArgs(
          'autonomous',
          root,
          'Run npm test before completing. Do not modify files. exact-status.txt is already correct and must remain unchanged.',
          ['--execution-profile', 'dev_local', '--allowed-tools', 'directory_list,file_read,shell_exec'],
        ),
      };
    },
    validate: (result, prepared) => expectStatus(result, 'VERIFIER_FAILED', 1, [
      fileContentEquals(prepared.root, 'exact-status.txt', 'exact already ok'),
      {
        pass: readTerminalStatusSummaryFromRun(result)?.status === 'VERIFIER_FAILED',
        notes: [`terminal_summary=${readTerminalStatusSummaryFromRun(result)?.status ?? '(none)'}`],
      },
    ]),
  };
}

function shellCommandDeniedSpecificStatusCase(): MatrixCase {
  return {
    id: 'shell_command_denied_specific_status',
    name: 'shell command denied returns specific status',
    expectedStatus: 'SHELL_COMMAND_DENIED',
    timeoutMs: 360_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'shell-command-denied-specific');
      mkdirSync(root, { recursive: true });
      writeNodeTestPackage(root);
      return {
        root,
        expectedStatus: 'SHELL_COMMAND_DENIED',
        args: runArgs(
          'autonomous',
          root,
          'Run npm test before completing. Do not modify files.',
          ['--execution-profile', 'dev_local', '--allowed-tools', 'directory_list,file_read,shell_exec', '--disallowed-tools', 'shell_exec'],
        ),
      };
    },
    validate: result => {
      const status = stringValue(result.parsed?.['status']);
      const summary = readTerminalStatusSummaryFromRun(result);
      return combineChecks([
        { pass: status === 'SHELL_COMMAND_DENIED', notes: [`status=${status ?? '(none)'}`] },
        { pass: result.exitCode === 1, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        { pass: summary?.status === 'SHELL_COMMAND_DENIED', notes: [`terminal_summary=${summary?.status ?? '(none)'}`] },
      ]);
    },
  };
}

function shellCommandFailedSpecificStatusCase(): MatrixCase {
  return {
    id: 'shell_command_failed_specific_status',
    name: 'allowed shell command failure returns specific status',
    expectedStatus: 'SHELL_COMMAND_FAILED',
    timeoutMs: 360_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'shell-command-failed-specific');
      mkdirSync(root, { recursive: true });
      return {
        root,
        expectedStatus: 'SHELL_COMMAND_FAILED',
        args: runArgs(
          'autonomous',
          root,
          'Run node missing-script.js and report the exit status. Do not edit files.',
          ['--execution-profile', 'dev_local', '--allowed-tools', 'directory_list,file_read,shell_exec'],
        ),
      };
    },
    validate: result => {
      const status = stringValue(result.parsed?.['status']);
      const summary = readTerminalStatusSummaryFromRun(result);
      return combineChecks([
        { pass: status === 'SHELL_COMMAND_FAILED', notes: [`status=${status ?? '(none)'}`] },
        { pass: result.exitCode === 1, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        { pass: summary?.failed_command !== null && summary?.failed_command !== undefined, notes: [`failed_command=${summary?.failed_command ?? '(none)'}`] },
      ]);
    },
  };
}

function rollbackOrSnapshotOnFailedRepairCase(): MatrixCase {
  return {
    id: 'rollback_or_snapshot_on_failed_repair',
    name: 'failed repair records rollback or snapshot safety',
    expectedStatus: 'NON_COMPLETE_WITH_SAFETY_SUMMARY',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'rollback-or-snapshot-failed-repair');
      prepareAlwaysFailingNpmTestFixture(root);
      writeFileSync(join(root, 'src', 'dirty.txt'), 'preserve unrelated dirty data\n', 'utf8');
      return {
        root,
        expectedStatus: 'NON_COMPLETE_WITH_SAFETY_SUMMARY',
        beforeFiles: { 'src/dirty.txt': fingerprint(join(root, 'src', 'dirty.txt')) },
        args: runArgs(
          'autonomous',
          root,
          'Fix the failing npm test in this project. The verifier is npm test, which runs test/run-tests.mjs and always remains red for this fixture. Only edit src/math.js. Do not inspect other test filenames. Do not modify src/dirty.txt. Run npm test before completing.',
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const safety = readAttemptSafetySummaryFromRun(result);
      const summary = readTerminalStatusSummaryFromRun(result);
      return combineChecks([
        expectNonComplete(result, []),
        {
          pass: safety?.rollback_mode === 'snapshot_only' ||
            safety?.rollback_mode === 'rollback_applied' ||
            safety?.rollback_mode === 'rollback_not_needed' ||
            safety?.rollback_mode === 'rollback_skipped_user_dirty_target' ||
            safety?.rollback_mode === 'rollback_failed',
          notes: [`rollback_mode=${safety?.rollback_mode ?? '(none)'}`],
        },
        {
          pass: safety?.user_change_preservation_summary.status === 'preserved',
          notes: [`user_change_preservation=${safety?.user_change_preservation_summary.status ?? '(none)'}`],
        },
        {
          pass: sameFingerprint(prepared.beforeFiles?.['src/dirty.txt'] ?? null, fingerprint(join(prepared.root, 'src', 'dirty.txt'))),
          notes: ['unrelated dirty file preserved'],
        },
        {
          pass: summary?.attempt_safety_summary_path !== null && summary?.attempt_safety_summary_path !== undefined,
          notes: [`attempt_safety_summary_path=${summary?.attempt_safety_summary_path ?? '(none)'}`],
        },
      ]);
    },
  };
}

function rollbackAppliedAfterFailedRepairCase(): MatrixCase {
  return {
    id: 'rollback_applied_after_failed_repair',
    name: 'rollback applied after failed repair',
    expectedStatus: 'ROLLBACK_APPLIED',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'rollback-applied-after-failed-repair');
      prepareAlwaysFailingNpmTestFixture(root);
      return {
        root,
        expectedStatus: 'ROLLBACK_APPLIED',
        beforeFiles: { 'rollback-target.txt': fingerprint(join(root, 'rollback-target.txt')) },
        args: runArgs(
          'autonomous',
          root,
          rollbackCreateFileTask(),
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const rollback = readRollbackSummaryFromRun(result);
      const safety = readAttemptSafetySummaryFromRun(result);
      const worktree = readWorktreeSafetySummaryFromRun(result);
      return combineChecks([
        expectStatus(result, 'ROLLBACK_APPLIED', 1, []),
        {
          pass: rollback?.status === 'rollback_applied',
          notes: [`rollback_status=${rollback?.status ?? '(none)'}`],
        },
        {
          pass: rollback?.removed_files.includes('rollback-target.txt') === true,
          notes: [`removed_files=${rollback?.removed_files.join(',') ?? '(none)'}`],
        },
        {
          pass: !existsSync(join(prepared.root, 'rollback-target.txt')),
          notes: ['created rollback target removed'],
        },
        {
          pass: safety?.rollback_mode === 'rollback_applied',
          notes: [`attempt_safety_rollback_mode=${safety?.rollback_mode ?? '(none)'}`],
        },
        {
          pass: worktree?.snapshot_count !== undefined && worktree.snapshot_count > 0,
          notes: [`worktree_snapshot_count=${worktree?.snapshot_count ?? 0}`],
        },
      ]);
    },
  };
}

function rollbackPreservesUnrelatedDirtyFileCase(): MatrixCase {
  return {
    id: 'rollback_preserves_unrelated_dirty_file',
    name: 'rollback preserves unrelated dirty file',
    expectedStatus: 'NON_COMPLETE_WITH_ROLLBACK_APPLIED',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'rollback-preserves-unrelated-dirty-file');
      prepareAlwaysFailingNpmTestFixture(root);
      writeFileSync(join(root, 'src', 'dirty.txt'), 'preserve this unrelated dirty file\n', 'utf8');
      return {
        root,
        expectedStatus: 'NON_COMPLETE_WITH_ROLLBACK_APPLIED',
        beforeFiles: {
          'rollback-target.txt': fingerprint(join(root, 'rollback-target.txt')),
          'src/dirty.txt': fingerprint(join(root, 'src', 'dirty.txt')),
        },
        args: runArgs(
          'autonomous',
          root,
          `${rollbackCreateFileTask()} Do not modify src/dirty.txt.`,
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const rollback = readRollbackSummaryFromRun(result);
      const status = stringValue(result.parsed?.['status']);
      return combineChecks([
        {
          pass: status !== null && status !== 'COMPLETE' && status !== 'RUN_FAILED',
          notes: [`status=${status ?? '(none)'}`],
        },
        { pass: result.exitCode === 1, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        {
          pass: rollback?.status === 'rollback_applied' || rollback?.status === 'rollback_not_needed',
          notes: [`rollback_status=${rollback?.status ?? '(none)'}`],
        },
        {
          pass: sameFingerprint(prepared.beforeFiles?.['src/dirty.txt'] ?? null, fingerprint(join(prepared.root, 'src', 'dirty.txt'))),
          notes: ['unrelated dirty file preserved byte-for-byte'],
        },
        {
          pass: !existsSync(join(prepared.root, 'rollback-target.txt')),
          notes: ['created rollback target removed'],
        },
      ]);
    },
  };
}

function dirtyTargetFileRefusesWithoutOverrideCase(): MatrixCase {
  return {
    id: 'dirty_target_file_refuses_without_override',
    name: 'dirty target file refuses without override',
    expectedStatus: 'WORKTREE_DIRTY_UNSAFE',
    timeoutMs: 420_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'dirty-target-refuses-without-override');
      prepareAlwaysFailingNpmTestFixture(root);
      initializeGitBaseline(root);
      writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return 1234;\n}\n', 'utf8');
      return {
        root,
        expectedStatus: 'WORKTREE_DIRTY_UNSAFE',
        beforeFiles: { 'src/math.js': fingerprint(join(root, 'src', 'math.js')) },
        args: runArgs(
          'autonomous',
          root,
          rollbackExactMathTask(),
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    validate: (result, prepared) => {
      const worktree = readWorktreeSafetySummaryFromRun(result);
      return combineChecks([
        expectStatus(result, 'WORKTREE_DIRTY_UNSAFE', 1, []),
        {
          pass: worktree?.target_dirty_conflicts.includes('src/math.js') === true,
          notes: [`target_dirty_conflicts=${worktree?.target_dirty_conflicts.join(',') ?? '(none)'}`],
        },
        {
          pass: sameFingerprint(prepared.beforeFiles?.['src/math.js'] ?? null, fingerprint(join(prepared.root, 'src', 'math.js'))),
          notes: ['dirty target file was not overwritten'],
        },
      ]);
    },
  };
}

function rollbackFailedSpecificStatusCase(): MatrixCase {
  return {
    id: 'rollback_failed_specific_status',
    name: 'rollback failed returns specific status',
    expectedStatus: 'ROLLBACK_FAILED',
    timeoutMs: 540_000,
    prepare: ctx => {
      const root = caseRoot(ctx, 'rollback-failed-specific-status');
      prepareAlwaysFailingNpmTestFixture(root);
      return {
        root,
        expectedStatus: 'ROLLBACK_FAILED',
        beforeFiles: { 'src/math.js': fingerprint(join(root, 'src', 'math.js')) },
        args: runArgs(
          'autonomous',
          root,
          rollbackExactMathTask(),
          ['--execution-profile', 'dev_local'],
        ),
      };
    },
    execute: ctx => {
      const prepared = rollbackFailedSpecificStatusCase().prepare(ctx);
      mkdirSync(prepared.root, { recursive: true });
      return {
        prepared,
        raw: runCommandWithEnv(ctx, prepared.args, 540_000, {
          BABEL_SIMULATE_ROLLBACK_FAILURE_FOR: 'src/math.js',
        }),
      };
    },
    validate: result => {
      const rollback = readRollbackSummaryFromRun(result);
      const trimmed = result.stdout.trim();
      return combineChecks([
        expectStatus(result, 'ROLLBACK_FAILED', 1, []),
        {
          pass: result.parseError === null && trimmed.startsWith('{') && trimmed.endsWith('}'),
          notes: ['rollback failed stdout is exactly one JSON object'],
        },
        {
          pass: rollback?.status === 'rollback_failed',
          notes: [`rollback_status=${rollback?.status ?? '(none)'}`],
        },
        {
          pass: (rollback?.failed_files.length ?? 0) > 0,
          notes: [`failed_files=${rollback?.failed_files.map(file => file.path).join(',') ?? '(none)'}`],
        },
      ]);
    },
  };
}

function worktreeSafetyJsonCleanlinessCase(): MatrixCase {
  return {
    id: 'worktree_safety_json_cleanliness',
    name: 'worktree safety JSON cleanliness',
    expectedStatus: 'WORKTREE_SAFETY_JSON_CLEAN',
    timeoutMs: 1_200_000,
    prepare: ctx => ({
      root: caseRoot(ctx, 'worktree-safety-json-cleanliness'),
      expectedStatus: 'WORKTREE_SAFETY_JSON_CLEAN',
      args: [],
    }),
    execute: ctx => {
      const root = caseRoot(ctx, 'worktree-safety-json-cleanliness');
      mkdirSync(root, { recursive: true });
      const samples: Array<{ id: string; raw: RawRunResult }> = [];

      const rollbackAppliedRoot = join(root, 'rollback-applied');
      prepareAlwaysFailingNpmTestFixture(rollbackAppliedRoot);
      samples.push({
        id: 'ROLLBACK_APPLIED',
        raw: runCommand(ctx, runArgs(
          'autonomous',
          rollbackAppliedRoot,
          rollbackCreateFileTask(),
          ['--execution-profile', 'dev_local'],
        ), 540_000),
      });

      const rollbackFailedRoot = join(root, 'rollback-failed');
      prepareAlwaysFailingNpmTestFixture(rollbackFailedRoot);
      samples.push({
        id: 'ROLLBACK_FAILED',
        raw: runCommandWithEnv(ctx, runArgs(
          'autonomous',
          rollbackFailedRoot,
          rollbackExactMathTask(),
          ['--execution-profile', 'dev_local'],
        ), 540_000, {
          BABEL_SIMULATE_ROLLBACK_FAILURE_FOR: 'src/math.js',
        }),
      });

      const dirtyTargetRoot = join(root, 'dirty-target');
      prepareAlwaysFailingNpmTestFixture(dirtyTargetRoot);
      initializeGitBaseline(dirtyTargetRoot);
      writeFileSync(join(dirtyTargetRoot, 'src', 'math.js'), 'export function add(a, b) {\n  return 1234;\n}\n', 'utf8');
      samples.push({
        id: 'WORKTREE_DIRTY_UNSAFE',
        raw: runCommand(ctx, runArgs(
          'autonomous',
          dirtyTargetRoot,
          rollbackExactMathTask(),
          ['--execution-profile', 'dev_local'],
        ), 420_000),
      });

      const parsedSamples = samples.map(sample => {
        const runDir = stringValue(sample.raw.parsed?.['run_dir']);
        return {
          id: sample.id,
          status: stringValue(sample.raw.parsed?.['status']),
          exit_code: sample.raw.exitCode,
          parse_error: sample.raw.parseError,
          stdout_is_single_json: sample.raw.parseError === null &&
            sample.raw.stdout.trim().startsWith('{') &&
            sample.raw.stdout.trim().endsWith('}'),
          worktree_safety_summary_exists: runDir ? existsSync(join(runDir, 'worktree_safety_summary.json')) : false,
          rollback_summary_exists: runDir ? existsSync(join(runDir, 'rollback_summary.json')) : false,
        };
      });

      const raw: RawRunResult = {
        command: 'matrix-harness --sample-worktree-safety-json-cleanliness',
        stdout: `${JSON.stringify({
          status: 'WORKTREE_SAFETY_JSON_CLEAN',
          samples: parsedSamples,
        }, null, 2)}\n`,
        stderr: '',
        exitCode: parsedSamples.every(sample =>
          sample.parse_error === null &&
          sample.stdout_is_single_json &&
          sample.status === sample.id &&
          sample.worktree_safety_summary_exists &&
          sample.rollback_summary_exists
        ) ? 0 : 1,
        parsed: {
          status: 'WORKTREE_SAFETY_JSON_CLEAN',
          samples: parsedSamples,
        },
        parseError: null,
      };
      return {
        prepared: {
          root,
          args: [],
          expectedStatus: 'WORKTREE_SAFETY_JSON_CLEAN',
          details: { samples: parsedSamples },
        },
        raw,
      };
    },
    validate: result => {
      const samples = Array.isArray(result.parsed?.['samples'])
        ? result.parsed['samples'] as Array<Record<string, unknown>>
        : [];
      return combineChecks([
        { pass: result.exitCode === 0, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        { pass: samples.length === 3, notes: [`sample_count=${samples.length}`] },
        {
          pass: samples.every(sample => sample['parse_error'] === null && sample['stdout_is_single_json'] === true),
          notes: ['all worktree safety samples emitted single parseable JSON objects'],
        },
        {
          pass: samples.every(sample => sample['worktree_safety_summary_exists'] === true && sample['rollback_summary_exists'] === true),
          notes: ['summary paths exist for all rollback/unsafe samples'],
        },
      ]);
    },
  };
}

function jsonProtocolCleanlinessAllNonCompleteStatusesCase(): MatrixCase {
  return {
    id: 'json_protocol_cleanliness_all_non_complete_statuses',
    name: '--json protocol cleanliness across sampled non-complete statuses',
    expectedStatus: 'SAMPLED_NON_COMPLETE_JSON_ONLY',
    timeoutMs: 900_000,
    prepare: ctx => ({
      root: caseRoot(ctx, 'json-cleanliness-all-non-complete'),
      expectedStatus: 'SAMPLED_NON_COMPLETE_JSON_ONLY',
      args: [],
    }),
    execute: ctx => {
      const root = caseRoot(ctx, 'json-cleanliness-all-non-complete');
      mkdirSync(root, { recursive: true });
      const samples: Array<{ id: string; raw: RawRunResult }> = [];

      const directRoot = join(root, 'direct');
      mkdirSync(directRoot, { recursive: true });
      samples.push({
        id: 'DIRECT_MODE_NO_EXECUTOR',
        raw: runCommand(ctx, runArgs('direct', directRoot, 'Create denied.txt containing the exact string "no".'), 240_000),
      });

      const ambiguousRoot = join(root, 'ambiguous');
      mkdirSync(ambiguousRoot, { recursive: true });
      samples.push({
        id: 'AMBIGUOUS_LITERAL_BINDING',
        raw: runCommand(ctx, runArgs('autonomous', ambiguousRoot, 'Create a.txt and b.txt containing the exact strings alpha and beta.'), 240_000),
      });

      const readOnlyRoot = join(root, 'readonly');
      mkdirSync(join(readOnlyRoot, 'src'), { recursive: true });
      writeFileSync(join(readOnlyRoot, 'src', 'info.txt'), 'ready\n', 'utf8');
      samples.push({
        id: 'READ_ONLY_NO_MODIFICATION',
        raw: runCommand(ctx, runArgs(
          'verified',
          readOnlyRoot,
          'Inspect src/info.txt and determine whether it mentions ready. Do not modify files.',
          ['--allowed-tools', 'directory_list,file_read'],
        ), 300_000),
      });

      const missingVerifierRoot = join(root, 'missing-verifier');
      mkdirSync(join(missingVerifierRoot, 'src'), { recursive: true });
      writeFileSync(join(missingVerifierRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
      writeFileSync(join(missingVerifierRoot, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
      samples.push({
        id: 'VERIFIER_NOT_FOUND',
        raw: runCommand(ctx, runArgs(
          'autonomous',
          missingVerifierRoot,
          'Fix src/math.js so add returns a + b. Only edit src/math.js. Run npm test before completing.',
          ['--execution-profile', 'dev_local'],
        ), 420_000),
      });

      const parsedSamples = samples.map(sample => ({
        id: sample.id,
        status: stringValue(sample.raw.parsed?.['status']),
        exit_code: sample.raw.exitCode,
        parse_error: sample.raw.parseError,
        stdout_is_single_json: sample.raw.parseError === null &&
          sample.raw.stdout.trim().startsWith('{') &&
          sample.raw.stdout.trim().endsWith('}'),
      }));

      const raw: RawRunResult = {
        command: 'matrix-harness --sample-json-cleanliness-non-complete-statuses',
        stdout: `${JSON.stringify({
          status: 'SAMPLED_NON_COMPLETE_JSON_ONLY',
          samples: parsedSamples,
        }, null, 2)}\n`,
        stderr: '',
        exitCode: parsedSamples.every(sample =>
          sample.parse_error === null &&
          sample.stdout_is_single_json &&
          sample.status !== null &&
          sample.status !== 'RUN_FAILED' &&
          sample.status !== 'COMPLETE'
        ) ? 0 : 1,
        parsed: {
          status: 'SAMPLED_NON_COMPLETE_JSON_ONLY',
          samples: parsedSamples,
        },
        parseError: null,
      };
      return {
        prepared: {
          root,
          args: [],
          expectedStatus: 'SAMPLED_NON_COMPLETE_JSON_ONLY',
          details: { samples: parsedSamples },
        },
        raw,
      };
    },
    validate: result => {
      const samples = Array.isArray(result.parsed?.['samples'])
        ? result.parsed['samples'] as Array<Record<string, unknown>>
        : [];
      return combineChecks([
        { pass: result.exitCode === 0, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        { pass: samples.length >= 4, notes: [`sample_count=${samples.length}`] },
        {
          pass: samples.every(sample => sample['parse_error'] === null && sample['stdout_is_single_json'] === true),
          notes: ['all sampled non-complete stdout payloads parsed as single JSON objects'],
        },
        {
          pass: samples.every(sample => sample['status'] !== 'RUN_FAILED' && sample['status'] !== 'COMPLETE'),
          notes: [`statuses=${samples.map(sample => String(sample['status'] ?? '(none)')).join(',')}`],
        },
      ]);
    },
  };
}

function jsonProtocolNonCompleteCleanlinessCase(): MatrixCase {
  return {
    id: 'json_protocol_cleanliness_non_complete',
    name: '--json protocol cleanliness on non-complete failure',
    expectedStatus: 'DIRECT_MODE_NO_EXECUTOR',
    prepare: ctx => {
      const root = caseRoot(ctx, 'json-cleanliness-non-complete');
      return {
        root,
        expectedStatus: 'DIRECT_MODE_NO_EXECUTOR',
        args: runArgs('direct', root, 'Create json-fail.txt containing the exact string "json fail clean".'),
      };
    },
    validate: result => {
      const trimmed = result.stdout.trim();
      const cleanJson = result.parseError === null && trimmed.startsWith('{') && trimmed.endsWith('}');
      return combineChecks([
        { pass: cleanJson, notes: [cleanJson ? 'non-complete stdout is exactly one JSON object' : 'non-complete stdout is not clean JSON'] },
        { pass: stringValue(result.parsed?.['status']) === 'DIRECT_MODE_NO_EXECUTOR', notes: [`status=${stringValue(result.parsed?.['status']) ?? '(none)'}`] },
        { pass: result.exitCode !== 0, notes: [`exit=${result.exitCode ?? '(null)'}`] },
      ]);
    },
  };
}

function repairMaxLoopsHonestCase(): MatrixCase {
  return {
    id: 'repair_max_loops_honest_failure',
    name: 'repair attempt reaches max loops honestly',
    expectedStatus: 'REPAIR_MAX_ATTEMPTS_REACHED',
    prepare: ctx => ({
      root: caseRoot(ctx, 'repair-max-loops'),
      expectedStatus: 'REPAIR_MAX_ATTEMPTS_REACHED',
      args: [],
    }),
    execute: ctx => runRepairMaxLoopsHarness(ctx),
    validate: (result, prepared) => {
      const attempts = prepared.repairAttempts ?? [];
      return combineChecks([
        { pass: stringValue(result.parsed?.['status']) === 'REPAIR_MAX_ATTEMPTS_REACHED', notes: [`status=${stringValue(result.parsed?.['status']) ?? '(none)'}`] },
        { pass: result.exitCode === 1, notes: [`exit=${result.exitCode ?? '(null)'}`] },
        { pass: attempts.length === 1, notes: [`attempt_count=${attempts.length}`] },
        { pass: attempts[0]?.failure_capsule?.retryable === true, notes: [`last_failure=${attempts[0]?.failure_capsule?.failure_code ?? '(none)'}`] },
      ]);
    },
  };
}

interface MatrixSnapshotState {
  content: string;
}

type MatrixSnapshot = Map<string, MatrixSnapshotState>;

function runForcedFailThenPassRepair(ctx: MatrixContext): ExecutedCase {
  const root = caseRoot(ctx, 'forced-fail-then-pass');
  prepareMathRepairFixture(root);
  const beforeAttempt1 = snapshotMatrixFiles(root);
  writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return a * b;\n}\n', 'utf8');
  const afterAttempt1 = snapshotMatrixFiles(root);
  const changed1 = diffMatrixSnapshots(beforeAttempt1, afterAttempt1);
  const verifier1 = runNodeTest(root);
  const capsule1 = buildFailureCapsule({
    attempt: 1,
    verifierStatus: verifier1.exitCode === 0 ? 'pass' : 'fail',
    failedCommand: verifier1.command,
    stdout: verifier1.stdout,
    stderr: verifier1.stderr,
    changedFiles: changed1,
  });
  const rollback1 = restoreMatrixSnapshot(root, beforeAttempt1, afterAttempt1);

  const beforeAttempt2 = snapshotMatrixFiles(root);
  const repairPrompt = [
    'Repair attempt 2 for the same project.',
    'Original task: Fix the failing Node test in this project. Only edit src/math.js. Run node --test before completing.',
    'Required patch: src/math.js must export add(a, b) and return a + b.',
    'Previous failure capsule:',
    JSON.stringify(capsule1, null, 2),
    'Do not repeat the multiplication patch from attempt 1. Make the smallest source patch that satisfies the test.',
  ].join('\n');
  const args = runArgs(
    'autonomous',
    root,
    repairPrompt,
    ['--execution-profile', 'dev_local'],
  );
  const raw = runCommand(ctx, args, ctx.defaultTimeoutMs);
  const afterAttempt2 = snapshotMatrixFiles(root);
  const changed2 = diffMatrixSnapshots(beforeAttempt2, afterAttempt2);
  const verifier2 = runNodeTest(root);

  const prepared: PreparedCase = {
    root,
    args,
    expectedStatus: 'COMPLETE',
    details: {
      proof_type: 'harness_injected',
      deterministic_test_double: false,
      harness_injected: true,
      attempt_count: 2,
      final_passing_command: verifier2.command,
      attempt_1_failed_command: verifier1.command,
      attempt_1_failure_summary: capsule1.concise_failure_summary,
      final_status: stringValue(raw.parsed?.['status']),
    },
    repairAttempts: [
      {
        attempt: 1,
        kind: 'injected_failure',
        command: 'matrix-harness --inject-first-attempt-failure',
        status: 'REPAIR_ATTEMPT_FAILED',
        exit_code: 1,
        changed_files: changed1,
        failed_command: verifier1.command,
        verifier_command: verifier1.command,
        verifier_exit_code: verifier1.exitCode,
        failure_capsule: capsule1,
        rollback: rollback1,
      },
      {
        attempt: 2,
        kind: 'live_cli',
        command: raw.command,
        status: stringValue(raw.parsed?.['status']) ?? 'UNKNOWN',
        exit_code: raw.exitCode,
        changed_files: changed2,
        failed_command: verifier2.exitCode === 0 ? null : verifier2.command,
        verifier_command: verifier2.command,
        verifier_exit_code: verifier2.exitCode,
        failure_capsule: null,
        rollback: {
          status: 'not_needed',
          reason: 'The live CLI repair attempt passed verification.',
          files_restored: [],
          files_removed: [],
        },
      },
    ],
  };
  return { prepared, raw };
}

function runAutonomousLiveFailThenPassRepair(ctx: MatrixContext): ExecutedCase {
  const root = caseRoot(ctx, 'autonomous-live-fail-then-pass');
  prepareMathRepairProofFixture(root);
  const before = snapshotMatrixFiles(root);
  const beforeDirty = fingerprint(join(root, 'src', 'dirty.txt'));
  const task = [
    '[BABEL_RELIABILITY_AUTONOMOUS_LIVE_FAIL_THEN_PASS]',
    'Fix the failing Node test in this project.',
    'Only edit src/math.js.',
    'Run node --test before completing.',
    'The final src/math.js implementation must contain the exact string "return a + b;".',
    'Do not modify src/dirty.txt.',
  ].join(' ');
  const args = runArgs(
    'autonomous',
    root,
    task,
    ['--execution-profile', 'dev_local'],
  );
  const raw = runCommandWithEnv(ctx, args, 540_000, {
    BABEL_RELIABILITY_REPAIR_PROOF: 'true',
  });
  const after = snapshotMatrixFiles(root);
  const changed = diffMatrixSnapshots(before, after);
  const unrelatedChanged = changed.filter(path => path !== 'src/math.js');
  const runDir = stringValue(raw.parsed?.['run_dir']);
  const timelinePath = runDir ? join(runDir, '12_repair_attempt_timeline.json') : null;
  const timeline = readJsonFile<AutonomousRepairProofTimeline>(timelinePath);
  const repairAttempts = timeline
    ? timeline.attempts.map((attempt): LiveCliReliabilityRepairAttempt => ({
        attempt: attempt.attempt,
        kind: attempt.kind,
        command: raw.command,
        status: attempt.status,
        exit_code: attempt.verifier_exit_code,
        changed_files: attempt.changed_files,
        failed_command: attempt.status === 'REPAIR_ATTEMPT_FAILED' ? attempt.verifier_command : null,
        verifier_command: attempt.verifier_command,
        verifier_cwd: attempt.verifier_cwd,
        verifier_exit_code: attempt.verifier_exit_code,
        verifier_stdout_summary: attempt.verifier_stdout_summary,
        verifier_stderr_summary: attempt.verifier_stderr_summary,
        failure_capsule_id: attempt.failure_capsule_id,
        failure_capsule_path: attempt.failure_capsule_path,
        input_capsule_id: attempt.input_capsule_id,
        input_capsule_path: attempt.input_capsule_path,
        input_capsule_consumed: attempt.input_capsule_consumed,
        next_attempt_consumed_capsule: attempt.next_attempt_consumed_capsule,
        repeated_failure_signature: attempt.repeated_failure_signature,
        meaningful_diff_since_previous_attempt: attempt.meaningful_diff_since_previous_attempt,
        failure_capsule: attempt.failure_capsule,
        rollback: {
          status: attempt.status === 'REPAIR_ATTEMPT_FAILED' ? 'carried_forward' : 'not_needed',
          reason: attempt.status === 'REPAIR_ATTEMPT_FAILED'
            ? 'Failed attempt was preserved until the retry patched forward through the live executor loop.'
            : 'The live retry passed verification.',
          files_restored: [],
          files_removed: [],
        },
      }))
    : [];

  return {
    raw,
    prepared: {
      root,
      args,
      expectedStatus: 'COMPLETE',
      beforeFiles: {
        'src/dirty.txt': beforeDirty,
      },
      details: {
        proof_type: 'deterministic_model_boundary_assisted',
        deterministic_test_double: true,
        harness_injected: false,
        repair_timeline_path: timelinePath,
        repair_timeline: timeline ?? null,
        unrelated_changed_files: unrelatedChanged,
      },
      repairAttempts,
    },
  };
}

function runRepairMaxLoopsHarness(ctx: MatrixContext): ExecutedCase {
  const root = caseRoot(ctx, 'repair-max-loops');
  prepareMathRepairFixture(root);
  const before = snapshotMatrixFiles(root);
  writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return a * b;\n}\n', 'utf8');
  const after = snapshotMatrixFiles(root);
  const changed = diffMatrixSnapshots(before, after);
  const verifier = runNodeTest(root);
  const capsule = buildFailureCapsule({
    attempt: 1,
    verifierStatus: 'fail',
    failedCommand: verifier.command,
    stdout: verifier.stdout,
    stderr: verifier.stderr,
    changedFiles: changed,
  });
  const rollback = restoreMatrixSnapshot(root, before, after);
  const raw: RawRunResult = {
    command: 'matrix-harness --inject-first-attempt-failure --max-attempts 1',
    stdout: JSON.stringify({
      status: 'REPAIR_MAX_ATTEMPTS_REACHED',
      attempt_count: 1,
      last_failure_capsule: capsule,
      artifact_path: join(root, 'case-result.json'),
    }, null, 2),
    stderr: '',
    exitCode: 1,
    parsed: {
      status: 'REPAIR_MAX_ATTEMPTS_REACHED',
      attempt_count: 1,
      last_failure_capsule: capsule,
      artifact_path: join(root, 'case-result.json'),
    },
    parseError: null,
  };
  return {
    raw,
    prepared: {
      root,
      args: [],
      expectedStatus: 'REPAIR_MAX_ATTEMPTS_REACHED',
      details: {
        attempt_count: 1,
        max_attempts: 1,
        last_failure_summary: capsule.concise_failure_summary,
      },
      repairAttempts: [{
        attempt: 1,
        kind: 'injected_failure',
        command: raw.command,
        status: 'REPAIR_ATTEMPT_FAILED',
        exit_code: 1,
        changed_files: changed,
        failed_command: verifier.command,
        verifier_command: verifier.command,
        verifier_exit_code: verifier.exitCode,
        failure_capsule: capsule,
        rollback,
      }],
    },
  };
}

function prepareMathRepairFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeNodeTestPackage(root);
  writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
  writeMathTest(root);
}

function prepareMathRepairProofFixture(root: string): void {
  prepareMathRepairFixture(root);
  writeFileSync(join(root, 'src', 'dirty.txt'), 'preserve me\n', 'utf8');
}

function prepareFlakyNpmTestRepairFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node test/run-tests.mjs' },
  }, null, 2), 'utf8');
  writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
  writeFileSync(join(root, 'test', 'run-tests.mjs'), [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const source = readFileSync(new URL('../src/math.js', import.meta.url), 'utf8');",
    "if (!source.includes('return a + b;')) {",
    "  console.error('FAILED test/math.test.js::add_sums_two_numbers AssertionError: expected add(2, 3) to equal 5');",
    '  process.exit(1);',
    '}',
    "const marker = new URL('../.verifier-first-run', import.meta.url);",
    'if (!existsSync(marker)) {',
    "  writeFileSync(marker, 'seen\\n');",
    "  console.error('FAILED test/math.test.js::add_sums_two_numbers AssertionError: first verifier run intentionally fails for retry evidence');",
    '  process.exit(1);',
    '}',
    "console.log('PASS test/math.test.js::add_sums_two_numbers');",
    '',
  ].join('\n'), 'utf8');
}

function prepareFlakyNpmTypecheckRepairFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { typecheck: 'node scripts/typecheck.mjs' },
  }, null, 2), 'utf8');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const answer: number = "42";\n', 'utf8');
  writeFileSync(join(root, 'scripts', 'typecheck.mjs'), [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');",
    "if (!source.includes('export const answer: number = 42;')) {",
    "  console.error('src/index.ts(1,14): error TS2322: Type string is not assignable to type number.');",
    '  process.exit(1);',
    '}',
    "const marker = new URL('../.typecheck-first-run', import.meta.url);",
    'if (!existsSync(marker)) {',
    "  writeFileSync(marker, 'seen\\n');",
    "  console.error('src/index.ts(1,14): error TS2322: first typecheck run intentionally fails for retry evidence.');",
    '  process.exit(1);',
    '}',
    "console.log('typecheck passed');",
    '',
  ].join('\n'), 'utf8');
}

function prepareAlwaysFailingNpmTestFixture(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node test/run-tests.mjs' },
  }, null, 2), 'utf8');
  writeFileSync(join(root, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
  writeFileSync(join(root, 'test', 'run-tests.mjs'), [
    "console.error('FAILED test/repeated.test.js::stable_failure AssertionError: verifier remains red until external fixture is changed');",
    'process.exit(1);',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(root, 'test', 'math.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.js';",
    '',
    "test('stable_failure', () => {",
    '  assert.equal(add(2, 3), 999);',
    '});',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(root, 'test', 'repeated.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.js';",
    '',
    "test('stable_failure', () => {",
    "  assert.equal(add(2, 3), 999, 'verifier remains red until external fixture is changed');",
    '});',
    '',
  ].join('\n'), 'utf8');
}

function writeNodeTestPackage(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2), 'utf8');
}

function writeMathTest(root: string): void {
  writeFileSync(join(root, 'test', 'math.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/math.js';",
    '',
    "test('add sums two numbers', () => {",
    '  assert.equal(add(2, 3), 5);',
    '});',
    '',
  ].join('\n'), 'utf8');
}

function runNodeTest(root: string): {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['--test'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    command: `${quoteArg(process.execPath)} --test`,
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readJsonFile<T>(path: string | null): T | null {
  if (!path || !existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readRepairTimelineFromRun(result: RawRunResult): AutonomousRepairProofTimeline | null {
  const runDir = stringValue(result.parsed?.['run_dir']);
  if (!runDir) {
    return null;
  }
  return readJsonFile<AutonomousRepairProofTimeline>(join(runDir, 'repair_attempt_timeline.json')) ??
    readJsonFile<AutonomousRepairProofTimeline>(join(runDir, '12_repair_attempt_timeline.json'));
}

function readAttemptSafetySummaryFromRun(result: RawRunResult): AttemptSafetySummary | null {
  const runDir = stringValue(result.parsed?.['run_dir']);
  if (!runDir) {
    return null;
  }
  return readJsonFile<AttemptSafetySummary>(join(runDir, 'attempt_safety_summary.json'));
}

function readTerminalStatusSummaryFromRun(result: RawRunResult): TerminalStatusSummary | null {
  const runDir = stringValue(result.parsed?.['run_dir']);
  if (!runDir) {
    const embedded = result.parsed?.['terminal_status'];
    return typeof embedded === 'object' && embedded !== null
      ? embedded as TerminalStatusSummary
      : null;
  }
  return readJsonFile<TerminalStatusSummary>(join(runDir, 'terminal_status_summary.json')) ??
    (
      typeof result.parsed?.['terminal_status'] === 'object' && result.parsed?.['terminal_status'] !== null
        ? result.parsed['terminal_status'] as TerminalStatusSummary
        : null
    );
}

function readRollbackSummaryFromRun(result: RawRunResult): WorktreeRollbackSummary | null {
  const runDir = stringValue(result.parsed?.['run_dir']);
  if (!runDir) {
    return null;
  }
  return readJsonFile<WorktreeRollbackSummary>(join(runDir, 'rollback_summary.json'));
}

function readWorktreeSafetySummaryFromRun(result: RawRunResult): WorktreeSafetySummary | null {
  const runDir = stringValue(result.parsed?.['run_dir']);
  if (!runDir) {
    return null;
  }
  return readJsonFile<WorktreeSafetySummary>(join(runDir, 'worktree_safety_summary.json'));
}

function rollbackExactMathTask(): string {
  return [
    'Update src/math.js so add returns a + b.',
    'Only edit src/math.js.',
    'The final src/math.js implementation must contain the exact string "return a + b;".',
    'Run npm test before completing.',
    'The verifier is intentionally red in this fixture, so Babel must halt honestly and apply rollback.',
  ].join(' ');
}

function rollbackCreateFileTask(): string {
  return [
    'Create rollback-target.txt containing the exact string "rollback temporary".',
    'Run npm test before completing.',
    'The verifier is intentionally red in this fixture, so Babel must halt honestly and apply rollback.',
  ].join(' ');
}

function initializeGitBaseline(root: string): void {
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  spawnSync('git', ['config', 'user.email', 'matrix@example.com'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  spawnSync('git', ['config', 'user.name', 'Matrix'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  spawnSync('git', ['commit', '-m', 'baseline'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
}

function validateGenericVerifierRetryTimeline(
  timeline: AutonomousRepairProofTimeline | null,
  options: {
    expectedFinalStatus: string;
    expectedCommand: string;
    expectedProofKind: string;
  },
): { pass: boolean; notes: string[] } {
  const attempts = timeline?.attempts ?? [];
  const failed = attempts.find(attempt => attempt.status === 'REPAIR_ATTEMPT_FAILED');
  const passed = attempts.find(attempt => attempt.status === 'REPAIR_ATTEMPT_PASSED');
  const sameVerifier = failed?.verifier_command &&
    passed?.verifier_command &&
    normalizeCommandForMatrix(failed.verifier_command) === normalizeCommandForMatrix(passed.verifier_command);
  const expectedCommandSeen = attempts.some(attempt =>
    normalizeCommandForMatrix(attempt.verifier_command ?? '').includes(normalizeCommandForMatrix(options.expectedCommand))
  );
  return combineChecks([
    { pass: timeline !== null, notes: [timeline ? 'repair timeline present' : 'repair timeline missing'] },
    { pass: timeline?.proof_kind === options.expectedProofKind, notes: [`proof_kind=${timeline?.proof_kind ?? '(none)'}`] },
    { pass: timeline?.deterministic_test_double === false, notes: [`deterministic_test_double=${String(timeline?.deterministic_test_double)}`] },
    { pass: timeline?.final_status === options.expectedFinalStatus, notes: [`timeline_final_status=${timeline?.final_status ?? '(none)'}`] },
    { pass: attempts.length >= 2, notes: [`attempt_count=${attempts.length}`] },
    { pass: failed?.failure_capsule?.retryable === true, notes: [`failure_capsule=${failed?.failure_capsule?.failure_code ?? '(none)'}`] },
    { pass: Boolean(failed?.failure_capsule_path), notes: [`failure_capsule_path=${failed?.failure_capsule_path ?? '(none)'}`] },
    { pass: passed?.input_capsule_consumed === true, notes: [`retry_consumed_capsule=${String(passed?.input_capsule_consumed)}`] },
    { pass: sameVerifier === true, notes: [sameVerifier ? 'same verifier rerun' : 'same verifier rerun missing'] },
    { pass: expectedCommandSeen, notes: [expectedCommandSeen ? `expected verifier seen: ${options.expectedCommand}` : `expected verifier missing: ${options.expectedCommand}`] },
    { pass: timeline?.final_completion_guard_result.status === 'pass', notes: [`completion_guard=${timeline?.final_completion_guard_result.status ?? '(none)'}`] },
  ]);
}

function validateVerifierFailureTimeline(
  timeline: AutonomousRepairProofTimeline | null,
  expectedFinalStatus: string,
): { pass: boolean; notes: string[] } {
  const attempts = timeline?.attempts ?? [];
  const failed = attempts.filter(attempt => attempt.status === 'REPAIR_ATTEMPT_FAILED');
  return combineChecks([
    { pass: timeline !== null, notes: [timeline ? 'repair timeline present' : 'repair timeline missing'] },
    { pass: timeline?.proof_kind === 'fully_autonomous', notes: [`proof_kind=${timeline?.proof_kind ?? '(none)'}`] },
    { pass: timeline?.deterministic_test_double === false, notes: [`deterministic_test_double=${String(timeline?.deterministic_test_double)}`] },
    { pass: timeline?.final_status === expectedFinalStatus, notes: [`timeline_final_status=${timeline?.final_status ?? '(none)'}`] },
    { pass: failed.length >= 1, notes: [`failed_attempt_count=${failed.length}`] },
    { pass: failed.every(attempt => Boolean(attempt.failure_capsule_path)), notes: [failed.every(attempt => Boolean(attempt.failure_capsule_path)) ? 'failure capsule paths recorded' : 'failure capsule path missing'] },
  ]);
}

function validateAttemptSafetySummary(
  safety: AttemptSafetySummary | null,
  options: { expectUserPreserved?: boolean } = {},
): { pass: boolean; notes: string[] } {
  return combineChecks([
    {
      pass: safety !== null,
      notes: [safety ? 'attempt safety summary present' : 'attempt safety summary missing'],
    },
    {
      pass: safety?.rollback_mode === 'snapshot_only' ||
        safety?.rollback_mode === 'rollback_applied' ||
        safety?.rollback_mode === 'rollback_not_needed' ||
        safety?.rollback_mode === 'rollback_skipped_user_dirty_target' ||
        safety?.rollback_mode === 'rollback_failed',
      notes: [`rollback_mode=${safety?.rollback_mode ?? '(none)'}`],
    },
    {
      pass: Array.isArray(safety?.changed_files_by_attempt) && safety.changed_files_by_attempt.length > 0,
      notes: [`changed_files_by_attempt=${safety?.changed_files_by_attempt.length ?? 0}`],
    },
    ...(options.expectUserPreserved
      ? [{
          pass: safety?.user_change_preservation_summary.status === 'preserved',
          notes: [`user_change_preservation=${safety?.user_change_preservation_summary.status ?? '(none)'}`],
        }]
      : []),
  ]);
}

function normalizeCommandForMatrix(command: string): string {
  return command.replace(/\s+/g, ' ').trim().toLowerCase();
}

function snapshotMatrixFiles(root: string): MatrixSnapshot {
  const snapshot: MatrixSnapshot = new Map();
  const visit = (directory: string, prefix = ''): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSyncSafe(directory)) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        snapshot.set(relativePath.replace(/\\/g, '/'), {
          content: readFileSync(fullPath, 'utf8'),
        });
      }
    }
  };
  visit(root);
  return snapshot;
}

function readdirSyncSafe(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function diffMatrixSnapshots(before: MatrixSnapshot, after: MatrixSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, state] of after.entries()) {
    if (before.get(path)?.content !== state.content) {
      changed.add(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      changed.add(path);
    }
  }
  return [...changed].sort();
}

function restoreMatrixSnapshot(
  root: string,
  before: MatrixSnapshot,
  after: MatrixSnapshot,
): LiveCliReliabilityRepairAttempt['rollback'] {
  const filesRestored: string[] = [];
  const filesRemoved: string[] = [];
  const resolvedRoot = resolve(root);
  for (const path of after.keys()) {
    if (!before.has(path)) {
      const fullPath = resolve(root, path);
      if (isWithinMatrixRoot(resolvedRoot, fullPath)) {
        try {
          unlinkSync(fullPath);
          filesRemoved.push(path);
        } catch {
          // Evidence-only harness cleanup; leave the file visible if removal fails.
        }
      }
    }
  }
  for (const [path, state] of before.entries()) {
    const current = after.get(path);
    if (current?.content === state.content) {
      continue;
    }
    const fullPath = resolve(root, path);
    if (isWithinMatrixRoot(resolvedRoot, fullPath)) {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, state.content, 'utf8');
      filesRestored.push(path);
    }
  }
  return {
    status: filesRestored.length > 0 || filesRemoved.length > 0 ? 'rolled_back' : 'not_needed',
    reason: filesRestored.length > 0 || filesRemoved.length > 0
      ? 'Injected failed patch was rolled back before the next attempt.'
      : 'Workspace already matched the pre-attempt snapshot.',
    files_restored: filesRestored,
    files_removed: filesRemoved,
  };
}

function isWithinMatrixRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`) || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function runArgs(mode: string, root: string, task: string, extraOptions: readonly string[] = []): string[] {
  return [
    'run',
    '--mode',
    mode,
    '--project',
    'example_mobile_finance',
    '--project-root',
    root,
    ...extraOptions,
    '--json',
    task,
  ];
}

function caseRoot(ctx: MatrixContext, slug: string): string {
  return join(ctx.matrixRoot, slug);
}

function expectStatus(
  result: RawRunResult,
  expectedStatus: string,
  expectedExit: number,
  checks: Array<{ pass: boolean; notes: string[] }>,
): { pass: boolean; notes: string[] } {
  const status = stringValue(result.parsed?.['status']);
  return combineChecks([
    { pass: result.parseError === null, notes: ['stdout parsed as JSON'] },
    { pass: status === expectedStatus, notes: [`status=${status ?? '(none)'}`] },
    { pass: result.exitCode === expectedExit, notes: [`exit=${result.exitCode ?? '(null)'}`] },
    ...checks,
  ]);
}

function expectNonComplete(
  result: RawRunResult,
  checks: Array<{ pass: boolean; notes: string[] }>,
): { pass: boolean; notes: string[] } {
  const status = stringValue(result.parsed?.['status']);
  return combineChecks([
    { pass: result.parseError === null, notes: ['stdout parsed as JSON'] },
    { pass: status !== 'COMPLETE', notes: [`status=${status ?? '(none)'}`] },
    { pass: result.exitCode !== 0, notes: [`exit=${result.exitCode ?? '(null)'}`] },
    ...checks,
  ]);
}

function combineChecks(checks: Array<{ pass: boolean; notes: string[] }>): { pass: boolean; notes: string[] } {
  return {
    pass: checks.every(check => check.pass),
    notes: checks.flatMap(check => check.notes),
  };
}

function fileContentEquals(root: string, relativePath: string, expected: string): { pass: boolean; notes: string[] } {
  const path = join(root, relativePath);
  if (!existsSync(path)) {
    return { pass: false, notes: [`${relativePath} missing`] };
  }
  const content = readFileSync(path, 'utf8');
  return {
    pass: content === expected,
    notes: [content === expected ? `${relativePath} content exact` : `${relativePath} content mismatch: ${JSON.stringify(content)}`],
  };
}

function missingFile(root: string, relativePath: string): { pass: boolean; notes: string[] } {
  const missing = !existsSync(join(root, relativePath));
  return {
    pass: missing,
    notes: [missing ? `${relativePath} not created` : `${relativePath} was unexpectedly created`],
  };
}

function noteWhen(pass: boolean, note: string): { pass: boolean; notes: string[] } {
  return { pass, notes: [note] };
}

function fingerprint(path: string): FileFingerprint | null {
  if (!existsSync(path)) {
    return null;
  }
  const stats = statSync(path);
  return {
    exists: true,
    size: stats.size,
    mtimeMs: Math.round(stats.mtimeMs),
    content: readFileSync(path, 'utf8'),
  };
}

function sameFingerprint(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.exists === right.exists &&
    left.size === right.size &&
    left.content === right.content;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoteArg(arg: string): string {
  if (!/[\s"']/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function excerpt(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function extractLastKnownRunDir(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const jsonRunDir = combined.match(/"run_dir"\s*:\s*"([^"]+)"/);
  if (jsonRunDir?.[1]) {
    return jsonRunDir[1].replace(/\\\\/g, '\\');
  }
  const textRunDir = combined.match(/Run directory:\s*([^\r\n]+)/i);
  return textRunDir?.[1]?.trim() ?? null;
}

function formatTimestampForFile(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
