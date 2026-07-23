import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { BABEL_ROOT } from '../cli/constants.js';
import {
  normalizeExecutionProfile,
  type ExecutionProfileName,
} from '../config/executionProfiles.js';
import { runBabelPipeline, type PipelineResult } from '../pipeline.js';
import { findCheckpoint, type CheckpointRecord } from './checkpoints.js';
import { analyzeTerminalBenchRun, type BenchmarkPartialPassSummary } from './benchmarkAnalysis.js';
import { buildBenchmarkRepairReport, type BenchmarkRepairReport } from './benchmarkRepair.js';
import {
  DEFAULT_REPAIR_RUN_ATTEMPTS,
  buildFailureCapsule,
  formatFailureCapsuleForPrompt,
  type FailureCapsule,
} from './repairGovernance.js';

export type BenchmarkRepairLoopStatus =
  | 'planned'
  | 'passed_local'
  | 'targeted_passed'
  | 'targeted_failed'
  | 'local_verifier_failed'
  | 'blocked'
  | 'max_iterations_reached';

export interface BenchmarkRepairLoopOptions {
  run: string;
  outputDir?: string;
  benchmarksRoot?: string;
  suite?: string;
  maxTasks?: number;
  maxIterations?: number;
  model?: string;
  modelTier?: string;
  executionProfile?: string;
  deepInfraTimeoutMs?: number;
  waterfallTimeoutMs?: number;
  verifierTimeoutMs?: number;
  targetedTimeoutMs?: number;
  dryRun?: boolean;
  skipBabelRepair?: boolean;
  skipLocalVerifier?: boolean;
  skipTargeted?: boolean;
  now?: Date;
}

export interface BenchmarkRepairLoopReport {
  schema_version: 1;
  report_type: 'babel_benchmark_repair_loop';
  generated_at: string;
  artifact_path: string;
  status: BenchmarkRepairLoopStatus;
  dry_run: boolean;
  input_run: string;
  task_name: string | null;
  workspace_dir: string | null;
  thresholds: {
    suite: string;
    max_tasks: number;
    max_iterations: number;
    model: string | null;
    model_tier: string;
    execution_profile: string;
    deepinfra_timeout_ms: number;
    waterfall_timeout_ms: number;
    verifier_timeout_ms: number;
    targeted_timeout_ms: number;
  };
  baseline: {
    passed: number;
    trials: number;
    mean_reward: number | null;
    partial_pass: BenchmarkPartialPassSummary | null;
  };
  iterations: BenchmarkRepairLoopIteration[];
  final: {
    local_reward: number | null;
    targeted_reward: number | null;
    targeted_result_path: string | null;
    next_run: string | null;
    best_iteration: number | null;
    last_failure_capsule: FailureCapsule | null;
    manual_bridge_prompt_path: string | null;
    recommendation: string;
  };
}

export interface BenchmarkRepairLoopIteration {
  iteration: number;
  input_run: string;
  task_name: string | null;
  repair_report_path: string | null;
  prompt_path: string | null;
  workspace_dir: string | null;
  checkpoint_replay: CheckpointReplayResult | null;
  repair_execution: RepairExecutionResult;
  verifier: VerifierRunResult;
  targeted_benchmark: TargetedBenchmarkResult;
  changed_files: string[];
  snapshot: RepairSnapshotMetadata;
  failure_capsule: FailureCapsule | null;
  partial_pass_before: BenchmarkPartialPassSummary | null;
  partial_pass_after: BenchmarkPartialPassSummary | null;
  notes: string[];
}

export interface RepairSnapshotMetadata {
  before_file_count: number;
  after_file_count: number;
  changed_files: string[];
  rollback: RepairRollbackResult;
}

export interface RepairRollbackResult {
  status: 'not_needed' | 'rolled_back' | 'carried_forward' | 'skipped' | 'failed';
  reason: string;
  files_restored: string[];
  files_removed: string[];
  refused_files: Array<{
    path: string;
    reason: string;
  }>;
}

export interface CheckpointReplayResult {
  status: 'none' | 'restored' | 'partial' | 'refused' | 'error';
  checkpoint_id: string | null;
  source_run_dir: string | null;
  restored_files: string[];
  refused_files: Array<{
    path: string;
    reason: string;
  }>;
  notes: string[];
}

export interface RepairExecutionResult {
  status: 'planned' | 'skipped' | 'complete' | 'failed';
  run_dir: string | null;
  pipeline_status: string | null;
  duration_ms: number | null;
  log_path: string | null;
  error: string | null;
}

export interface VerifierRunResult {
  status: 'planned' | 'skipped' | 'pass' | 'fail' | 'error';
  command: string | null;
  reward: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  logs_dir: string | null;
  stdout_excerpt: string | null;
  stderr_excerpt: string | null;
  error: string | null;
}

export interface TargetedBenchmarkResult {
  status: 'planned' | 'skipped' | 'pass' | 'fail' | 'error';
  command: string | null;
  result_path: string | null;
  reward: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  stdout_excerpt: string | null;
  stderr_excerpt: string | null;
  error: string | null;
}

interface PreparedRepairWorkspace {
  source_app_dir: string;
  workspace_dir: string;
  checkpoint_replay: CheckpointReplayResult;
  docker_image: string | null;
  task_toml_path: string | null;
  tests_dir: string | null;
  instruction_path: string | null;
  trial_task_prompt_path: string | null;
}

interface TrialRuntimeInfo {
  source_app_dir: string | null;
  docker_image: string | null;
  task_toml_path: string | null;
  tests_dir: string | null;
  instruction_path: string | null;
  trial_task_prompt_path: string | null;
}

interface CommandResult {
  exit_code: number | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface WorkspaceFileState {
  size: number;
  mtimeMs: number;
  contentBase64: string | null;
}

export type WorkspaceSnapshot = Map<string, WorkspaceFileState>;

const DEFAULT_SUITE = 'pilot10';
const DEFAULT_MAX_TASKS = 10;
const DEFAULT_MAX_ITERATIONS = DEFAULT_REPAIR_RUN_ATTEMPTS;
const DEFAULT_MODEL_TIER = 'cheap';
const DEFAULT_EXECUTION_PROFILE = 'benchmark_container';
const DEFAULT_DEEPINFRA_TIMEOUT_MS = 240_000;
const DEFAULT_WATERFALL_TIMEOUT_MS = 720_000;
const DEFAULT_VERIFIER_TIMEOUT_MS = 1_200_000;
const DEFAULT_TARGETED_TIMEOUT_MS = 1_800_000;
const EXCERPT_LIMIT = 2000;
const SNAPSHOT_CONTENT_LIMIT_BYTES = 2 * 1024 * 1024;

export async function runBenchmarkRepairLoop(
  options: BenchmarkRepairLoopOptions,
): Promise<BenchmarkRepairLoopReport> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const suite = options.suite ?? DEFAULT_SUITE;
  const maxTasks = positiveInt(options.maxTasks, DEFAULT_MAX_TASKS);
  const maxIterations = positiveInt(options.maxIterations, DEFAULT_MAX_ITERATIONS);
  const modelTier = options.modelTier ?? DEFAULT_MODEL_TIER;
  const executionProfile = normalizeRepairExecutionProfile(options.executionProfile);
  const deepInfraTimeoutMs = positiveInt(options.deepInfraTimeoutMs, DEFAULT_DEEPINFRA_TIMEOUT_MS);
  const waterfallTimeoutMs = positiveInt(
    options.waterfallTimeoutMs,
    Math.max(DEFAULT_WATERFALL_TIMEOUT_MS, deepInfraTimeoutMs * 3),
  );
  const verifierTimeoutMs = positiveInt(options.verifierTimeoutMs, DEFAULT_VERIFIER_TIMEOUT_MS);
  const targetedTimeoutMs = positiveInt(options.targetedTimeoutMs, DEFAULT_TARGETED_TIMEOUT_MS);
  const dryRun = options.dryRun !== false;
  const workspaceRoot = dirname(BABEL_ROOT);
  const benchmarksRoot = resolve(options.benchmarksRoot ?? join(workspaceRoot, 'benchmarks'));
  const loopRoot = resolve(
    options.outputDir ?? join(BABEL_ROOT, 'runs', 'benchmarks', 'repair-loops'),
  );
  const loopDir = join(
    loopRoot,
    `benchmark-repair-loop-${formatTimestampForFile(now)}-${sanitizeSlug(resolve(options.run).split(/[\\/]/).pop() ?? 'run')}`,
  );
  const repairArtifactsDir = join(loopDir, 'packets');
  mkdirSync(repairArtifactsDir, { recursive: true });

  const baselineReport = buildBenchmarkRepairReport({
    run: options.run,
    outputDir: repairArtifactsDir,
    benchmarksRoot,
    suite,
    maxTasks,
    now,
  });

  const report: BenchmarkRepairLoopReport = {
    schema_version: 1,
    report_type: 'babel_benchmark_repair_loop',
    generated_at: generatedAt,
    artifact_path: join(loopDir, 'repair-loop.json'),
    status: dryRun ? 'planned' : 'blocked',
    dry_run: dryRun,
    input_run: baselineReport.result_path,
    task_name: baselineReport.task_name,
    workspace_dir: null,
    thresholds: {
      suite,
      max_tasks: maxTasks,
      max_iterations: maxIterations,
      model: options.model ?? null,
      model_tier: modelTier,
      execution_profile: executionProfile,
      deepinfra_timeout_ms: deepInfraTimeoutMs,
      waterfall_timeout_ms: waterfallTimeoutMs,
      verifier_timeout_ms: verifierTimeoutMs,
      targeted_timeout_ms: targetedTimeoutMs,
    },
    baseline: {
      passed: baselineReport.baseline_score.passed,
      trials: baselineReport.baseline_score.trials,
      mean_reward: baselineReport.baseline_score.mean_reward,
      partial_pass: baselineReport.partial_pass,
    },
    iterations: [],
    final: {
      local_reward: null,
      targeted_reward: null,
      targeted_result_path: null,
      next_run: baselineReport.result_path,
      best_iteration: null,
      last_failure_capsule: null,
      manual_bridge_prompt_path: null,
      recommendation: 'Repair loop did not start.',
    },
  };

  if (!baselineReport.task_name || !baselineReport.trial_dir) {
    report.status = dryRun ? 'planned' : 'blocked';
    report.final.recommendation =
      'No failing trial was selected; run benchmark analyze on a failed countable run first.';
    writeLoopReport(report);
    return report;
  }

  let currentRun = baselineReport.result_path;
  let currentReport = baselineReport;
  let prepared: PreparedRepairWorkspace | null = null;
  let preparedForRun: string | null = null;
  let previousVerifier: VerifierRunResult | null = null;
  let latestLocalReward: number | null = null;
  let latestTargetedReward: number | null = null;
  let latestTargetedResultPath: string | null = null;
  let latestFailureCapsule: FailureCapsule | null = null;
  let terminalStatus: BenchmarkRepairLoopStatus | null = dryRun ? 'planned' : null;

  for (let iterationNumber = 1; iterationNumber <= maxIterations; iterationNumber += 1) {
    if (iterationNumber > 1 && currentRun !== currentReport.result_path) {
      currentReport = buildBenchmarkRepairReport({
        run: currentRun,
        outputDir: repairArtifactsDir,
        benchmarksRoot,
        suite,
        maxTasks,
        now: new Date(now.getTime() + iterationNumber),
      });
    }

    const iterationDir = join(loopDir, `iteration-${String(iterationNumber).padStart(2, '0')}`);
    mkdirSync(iterationDir, { recursive: true });
    const notes: string[] = [];

    if (!prepared || preparedForRun !== currentReport.result_path) {
      try {
        prepared = prepareRepairWorkspace({
          repairReport: currentReport,
          loopDir,
          iterationNumber,
          benchmarksRoot,
        });
        preparedForRun = currentReport.result_path;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const iteration = makeBlockedIteration({
          iteration: iterationNumber,
          inputRun: currentReport.result_path,
          repairReport: currentReport,
          message,
        });
        report.iterations.push(iteration);
        terminalStatus = dryRun ? 'planned' : 'blocked';
        report.final.recommendation = message;
        break;
      }
    } else {
      notes.push(
        'Reused repair workspace to preserve partial work from the previous failed verifier attempt.',
      );
    }

    const iterationPrepared = prepared;
    if (!iterationPrepared) {
      throw new Error('Repair workspace preparation failed unexpectedly.');
    }

    report.workspace_dir = iterationPrepared.workspace_dir;
    const promptPath = join(iterationDir, 'repair-prompt.md');
    const repairPrompt = buildExecutableRepairPrompt({
      repairReport: currentReport,
      prepared: iterationPrepared,
      previousVerifier,
      previousFailureCapsule: latestFailureCapsule,
      iterationNumber,
    });
    writeFileSync(promptPath, `${repairPrompt}\n`, 'utf8');

    const beforeRepairSnapshot = snapshotWorkspaceFiles(iterationPrepared.workspace_dir);
    const repairExecution =
      dryRun || options.skipBabelRepair === true
        ? makeSkippedOrPlannedRepairExecution(dryRun, options.skipBabelRepair === true)
        : await executeRepairPrompt({
            prompt: repairPrompt,
            workspaceDir: iterationPrepared.workspace_dir,
            iterationDir,
            executionProfile,
            modelTier,
            model: options.model ?? null,
            dockerImage: iterationPrepared.docker_image,
            deepInfraTimeoutMs,
            waterfallTimeoutMs,
          });
    const afterRepairSnapshot = snapshotWorkspaceFiles(iterationPrepared.workspace_dir);
    const changedFiles =
      dryRun || options.skipBabelRepair === true
        ? []
        : diffWorkspaceSnapshots(beforeRepairSnapshot, afterRepairSnapshot);
    const snapshotMetadata: RepairSnapshotMetadata = {
      before_file_count: beforeRepairSnapshot.size,
      after_file_count: afterRepairSnapshot.size,
      changed_files: changedFiles,
      rollback: {
        status: dryRun ? 'skipped' : 'not_needed',
        reason: dryRun
          ? 'Dry run did not mutate the repair workspace.'
          : 'No failed retry decision has been made.',
        files_restored: [],
        files_removed: [],
        refused_files: [],
      },
    };

    const verifier = dryRun
      ? planVerifierRun(iterationPrepared, verifierTimeoutMs)
      : options.skipLocalVerifier === true
        ? makeSkippedVerifier('Skipped by --skip-local-verifier.')
        : runLocalVerifier(iterationPrepared, iterationDir, verifierTimeoutMs);
    latestLocalReward = verifier.reward;
    previousVerifier = verifier;

    let targeted = makeSkippedTargetedBenchmark(
      'Targeted benchmark waits for a local verifier pass.',
    );
    if (dryRun) {
      targeted = planTargetedBenchmark({
        benchmarksRoot,
        suite,
        taskName: currentReport.task_name,
        maxTasks,
        modelTier,
        model: options.model ?? null,
        executionProfile,
        deepInfraTimeoutMs,
        waterfallTimeoutMs,
        iterationDir,
      });
    } else if (options.skipTargeted === true) {
      targeted = makeSkippedTargetedBenchmark('Skipped by --skip-targeted.');
      if (verifier.status === 'pass' || options.skipLocalVerifier === true) {
        terminalStatus = 'passed_local';
      }
    } else if (verifier.status === 'pass' || options.skipLocalVerifier === true) {
      targeted = runTargetedBenchmark({
        benchmarksRoot,
        suite,
        taskName: currentReport.task_name,
        maxTasks,
        modelTier,
        model: options.model ?? null,
        executionProfile,
        deepInfraTimeoutMs,
        waterfallTimeoutMs,
        targetedTimeoutMs,
        iterationDir,
      });
      latestTargetedReward = targeted.reward;
      latestTargetedResultPath = targeted.result_path;
      if (targeted.status === 'pass') {
        terminalStatus = 'targeted_passed';
      } else if (targeted.result_path) {
        terminalStatus = 'targeted_failed';
        currentRun = targeted.result_path;
        prepared = null;
        preparedForRun = null;
      } else {
        terminalStatus = 'targeted_failed';
      }
    } else if (verifier.status === 'fail') {
      terminalStatus = 'local_verifier_failed';
    } else if (verifier.status === 'error') {
      terminalStatus = 'blocked';
    }

    const partialAfter =
      targeted.result_path && existsSync(targeted.result_path)
        ? safeAnalyzePartialPass(targeted.result_path)
        : null;

    const failureCapsule = buildIterationFailureCapsule({
      iterationNumber,
      repairExecution,
      verifier,
      targeted,
      changedFiles,
    });
    latestFailureCapsule = failureCapsule;

    const iteration: BenchmarkRepairLoopIteration = {
      iteration: iterationNumber,
      input_run: currentReport.result_path,
      task_name: currentReport.task_name,
      repair_report_path: currentReport.artifacts.report_path,
      prompt_path: promptPath,
      workspace_dir: iterationPrepared.workspace_dir,
      checkpoint_replay: iterationPrepared.checkpoint_replay,
      repair_execution: repairExecution,
      verifier,
      targeted_benchmark: targeted,
      changed_files: changedFiles,
      snapshot: snapshotMetadata,
      failure_capsule: failureCapsule,
      partial_pass_before: currentReport.partial_pass,
      partial_pass_after: partialAfter,
      notes,
    };
    report.iterations.push(iteration);

    report.status = terminalStatus ?? 'max_iterations_reached';
    report.final.local_reward = latestLocalReward;
    report.final.targeted_reward = latestTargetedReward;
    report.final.targeted_result_path = latestTargetedResultPath;
    report.final.next_run = currentRun;
    report.final.best_iteration = selectBestIteration(report.iterations);
    report.final.last_failure_capsule = failureCapsule;
    report.final.manual_bridge_prompt_path =
      failureCapsule && !failureCapsule.retryable ? promptPath : null;
    report.final.recommendation = recommendationForStatus(report.status, currentRun);

    const willRetry =
      !dryRun &&
      failureCapsule?.retryable === true &&
      iterationNumber < maxIterations &&
      report.status !== 'targeted_passed' &&
      report.status !== 'passed_local' &&
      report.status !== 'blocked';
    if (willRetry && report.status === 'local_verifier_failed') {
      iteration.snapshot.rollback = restoreWorkspaceSnapshot(
        iterationPrepared.workspace_dir,
        beforeRepairSnapshot,
        snapshotWorkspaceFiles(iterationPrepared.workspace_dir),
      );
      notes.push(
        iteration.snapshot.rollback.status === 'rolled_back'
          ? 'Rolled back failed repair changes before the next attempt.'
          : `Rollback did not fully complete: ${iteration.snapshot.rollback.reason}`,
      );
    } else if (willRetry) {
      iteration.snapshot.rollback = {
        status: 'carried_forward',
        reason:
          report.status === 'targeted_failed' && targeted.result_path
            ? 'Targeted rerun produced a new failed benchmark result; the next iteration re-prepares from that run instead of mutating this workspace.'
            : 'Retry will carry the failed diff forward because it may contain useful partial work and no local rollback point was selected.',
        files_restored: [],
        files_removed: [],
        refused_files: [],
      };
    } else if (!dryRun && failureCapsule) {
      iteration.snapshot.rollback = {
        status: 'carried_forward',
        reason: 'No retry will be attempted, so the failed workspace is preserved as evidence.',
        files_restored: [],
        files_removed: [],
        refused_files: [],
      };
    } else if (!dryRun) {
      iteration.snapshot.rollback = {
        status: 'not_needed',
        reason: 'Attempt passed or did not produce a retryable failure.',
        files_restored: [],
        files_removed: [],
        refused_files: [],
      };
    }

    writeLoopReport(report);

    if (!dryRun && failureCapsule && !failureCapsule.retryable) {
      report.status = 'blocked';
      report.final.recommendation = `Repair loop stopped: ${failureCapsule.failure_code} is not retryable. ${failureCapsule.next_repair_hypothesis}`;
      writeLoopReport(report);
      break;
    }

    if (
      dryRun ||
      terminalStatus === 'targeted_passed' ||
      terminalStatus === 'passed_local' ||
      terminalStatus === 'blocked'
    ) {
      break;
    }
  }

  if (
    !dryRun &&
    report.iterations.length >= maxIterations &&
    report.status !== 'targeted_passed' &&
    report.status !== 'passed_local' &&
    report.status !== 'blocked'
  ) {
    report.status = 'max_iterations_reached';
    report.final.recommendation = recommendationForStatus(report.status, currentRun);
  }

  writeLoopReport(report);
  return report;
}

export function formatBenchmarkRepairLoopHuman(report: BenchmarkRepairLoopReport): string {
  const lines = [
    'Babel Benchmark Repair Loop',
    `Status: ${report.status}`,
    `Task: ${report.task_name ?? '(none)'}`,
    `Baseline: ${report.baseline.passed}/${report.baseline.trials}`,
    `Workspace: ${report.workspace_dir ?? '(none)'}`,
    `Artifact: ${report.artifact_path}`,
    '',
    'Iterations:',
  ];
  for (const iteration of report.iterations) {
    lines.push(
      `- ${iteration.iteration}: repair=${iteration.repair_execution.status}, verifier=${iteration.verifier.status}, targeted=${iteration.targeted_benchmark.status}`,
    );
    if (iteration.verifier.reward !== null) {
      lines.push(`  local reward: ${iteration.verifier.reward}`);
    }
    if (iteration.targeted_benchmark.reward !== null) {
      lines.push(`  targeted reward: ${iteration.targeted_benchmark.reward}`);
    }
  }
  lines.push('', `Recommendation: ${report.final.recommendation}`);
  if (report.final.targeted_result_path) {
    lines.push(`Targeted result: ${report.final.targeted_result_path}`);
  }
  return lines.join('\n');
}

function prepareRepairWorkspace(input: {
  repairReport: BenchmarkRepairReport;
  loopDir: string;
  iterationNumber: number;
  benchmarksRoot: string;
}): PreparedRepairWorkspace {
  const runtime = resolveTrialRuntime(input.repairReport, input.benchmarksRoot);
  if (!runtime.source_app_dir || !existsSync(runtime.source_app_dir)) {
    throw new Error(
      `Falling trial app directory was not found: ${runtime.source_app_dir ?? '(unknown)'}`,
    );
  }

  const workspaceDir = join(
    input.loopDir,
    `workspace-${String(input.iterationNumber).padStart(2, '0')}`,
  );
  mkdirSync(dirname(workspaceDir), { recursive: true });
  cpSync(runtime.source_app_dir, workspaceDir, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });

  const checkpointReplay = replayCheckpointIntoWorkspace(input.repairReport, workspaceDir);
  return {
    source_app_dir: runtime.source_app_dir,
    workspace_dir: workspaceDir,
    checkpoint_replay: checkpointReplay,
    docker_image: runtime.docker_image,
    task_toml_path: runtime.task_toml_path,
    tests_dir: runtime.tests_dir,
    instruction_path: runtime.instruction_path,
    trial_task_prompt_path: runtime.trial_task_prompt_path,
  };
}

function resolveTrialRuntime(
  report: BenchmarkRepairReport,
  benchmarksRoot: string,
): TrialRuntimeInfo {
  const trialDir = report.trial_dir;
  const trialResult = trialDir ? readJsonRecordOrNull(join(trialDir, 'result.json')) : null;
  const taskName = report.task_name;
  const taskDir = taskName ? join(benchmarksRoot, 'terminal-bench-2', taskName) : null;
  const taskTomlPath =
    taskDir && existsSync(join(taskDir, 'task.toml')) ? join(taskDir, 'task.toml') : null;
  const taskToml = taskTomlPath ? readFileSync(taskTomlPath, 'utf8') : '';
  const dockerImage =
    stringValue(trialResult?.['docker_image']) ?? readTomlString(taskToml, 'docker_image');
  const sourceAppDir =
    stringValue(trialResult?.['app_dir']) ?? (trialDir ? join(trialDir, 'app') : null);
  const testsDir = taskDir && existsSync(join(taskDir, 'tests')) ? join(taskDir, 'tests') : null;
  const instructionPath =
    taskDir && existsSync(join(taskDir, 'instruction.md')) ? join(taskDir, 'instruction.md') : null;
  const trialTaskPromptPath =
    trialDir && existsSync(join(trialDir, 'babel-task.md'))
      ? join(trialDir, 'babel-task.md')
      : null;
  return {
    source_app_dir: sourceAppDir,
    docker_image: dockerImage,
    task_toml_path: taskTomlPath,
    tests_dir: testsDir,
    instruction_path: instructionPath,
    trial_task_prompt_path: trialTaskPromptPath,
  };
}

function replayCheckpointIntoWorkspace(
  report: BenchmarkRepairReport,
  workspaceDir: string,
): CheckpointReplayResult {
  const checkpointId = report.best_candidate_checkpoint;
  if (!checkpointId || !report.babel_run_dir) {
    return {
      status: 'none',
      checkpoint_id: null,
      source_run_dir: report.babel_run_dir,
      restored_files: [],
      refused_files: [],
      notes: ['No restorable candidate checkpoint was selected for this failed trial.'],
    };
  }

  let record: CheckpointRecord;
  try {
    record = findCheckpoint(checkpointId, { runDir: report.babel_run_dir }).record;
  } catch (error) {
    return {
      status: 'error',
      checkpoint_id: checkpointId,
      source_run_dir: report.babel_run_dir,
      restored_files: [],
      refused_files: [
        {
          path: checkpointId,
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
      notes: ['Candidate checkpoint metadata could not be read.'],
    };
  }

  if (record.restore_status !== 'available' || record.files.length === 0) {
    return {
      status: 'refused',
      checkpoint_id: checkpointId,
      source_run_dir: report.babel_run_dir,
      restored_files: [],
      refused_files: [
        {
          path: record.target,
          reason: 'Checkpoint has no restorable file snapshots.',
        },
      ],
      notes: record.notes,
    };
  }

  const restoredFiles: string[] = [];
  const refusedFiles: CheckpointReplayResult['refused_files'] = [];
  for (const file of record.files) {
    const relativePath = checkpointRelativePath(record, file.path, file.project_relative_path);
    if (!relativePath || !isSafeRelativePath(relativePath)) {
      refusedFiles.push({
        path: file.path,
        reason: 'Checkpoint file does not resolve to a safe workspace-relative path.',
      });
      continue;
    }

    const targetPath = resolve(workspaceDir, relativePath);
    if (!isWithinRoot(workspaceDir, targetPath)) {
      refusedFiles.push({
        path: file.path,
        reason: 'Checkpoint target would escape the repair workspace.',
      });
      continue;
    }

    if (file.existed) {
      if (file.content_base64 === null) {
        refusedFiles.push({
          path: file.path,
          reason: 'Checkpoint snapshot has metadata but no restorable file content.',
        });
        continue;
      }
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, Buffer.from(file.content_base64, 'base64'));
      restoredFiles.push(targetPath);
      continue;
    }

    if (existsSync(targetPath)) {
      const stats = statSync(targetPath);
      if (!stats.isFile()) {
        refusedFiles.push({
          path: file.path,
          reason: 'Checkpoint says path was absent, but workspace target is not a regular file.',
        });
        continue;
      }
      unlinkSync(targetPath);
    }
    restoredFiles.push(targetPath);
  }

  return {
    status:
      refusedFiles.length === 0 ? 'restored' : restoredFiles.length > 0 ? 'partial' : 'refused',
    checkpoint_id: checkpointId,
    source_run_dir: report.babel_run_dir,
    restored_files: restoredFiles,
    refused_files: refusedFiles,
    notes: record.notes,
  };
}

function buildExecutableRepairPrompt(input: {
  repairReport: BenchmarkRepairReport;
  prepared: PreparedRepairWorkspace;
  previousVerifier: VerifierRunResult | null;
  previousFailureCapsule: FailureCapsule | null;
  iterationNumber: number;
}): string {
  const instruction = readBoundedText(input.prepared.instruction_path, 12_000);
  const trialPrompt = readBoundedText(input.prepared.trial_task_prompt_path, 12_000);
  const workspaceSummary = summarizeWorkspace(input.prepared.workspace_dir);
  const previous = input.previousVerifier;
  return [
    '# Babel Executable Benchmark Repair',
    '',
    'REPAIR MODE: continue from the current repair workspace. Do not restart the task from scratch.',
    `Iteration: ${input.iterationNumber}`,
    `Task: ${input.repairReport.task_name ?? '(unknown)'}`,
    `Repair workspace: ${input.prepared.workspace_dir}`,
    `Original failed trial app: ${input.prepared.source_app_dir}`,
    'Treat the repair workspace as /app. Patch only this workspace.',
    '',
    'Checkpoint replay:',
    `- status: ${input.prepared.checkpoint_replay.status}`,
    `- checkpoint: ${input.prepared.checkpoint_replay.checkpoint_id ?? '(none)'}`,
    ...input.prepared.checkpoint_replay.restored_files
      .slice(0, 12)
      .map(
        (file) => `- restored: ${relative(input.prepared.workspace_dir, file).replace(/\\/g, '/')}`,
      ),
    ...input.prepared.checkpoint_replay.refused_files
      .slice(0, 8)
      .map((file) => `- refused: ${file.path} - ${file.reason}`),
    '',
    'Packet evidence:',
    input.repairReport.repair_prompt,
    '',
    'Current workspace summary:',
    ...workspaceSummary.map((line) => `- ${line}`),
    '',
    ...(previous
      ? [
          'Previous local verifier attempt:',
          `- status: ${previous.status}`,
          `- reward: ${previous.reward ?? '(unknown)'}`,
          `- exit code: ${previous.exit_code ?? '(unknown)'}`,
          `- stdout: ${previous.stdout_excerpt ?? '(none)'}`,
          `- stderr: ${previous.stderr_excerpt ?? '(none)'}`,
          '',
        ]
      : []),
    ...(input.previousFailureCapsule
      ? [
          'Previous failure capsule:',
          '```json',
          formatFailureCapsuleForPrompt(input.previousFailureCapsule),
          '```',
          '',
          'Repair-loop rule: do not repeat the same failed patch pattern described in the capsule.',
          ...(input.iterationNumber >= 2
            ? [
                '',
                '--- STRATEGY DIVERSIFICATION REQUIRED (iteration >= 2) ---',
                'You have already attempted at least one repair that did not resolve the failure.',
                'Before proposing another patch, explicitly identify:',
                '  1. What specific approach did the previous attempt(s) use?',
                '  2. Why did that approach fail to satisfy the verifier?',
                '  3. What DIFFERENT strategy will you use this time?',
                '',
                'Rules for strategy selection:',
                '  - If the previous approach was a targeted fix (editing the failing file),',
                '    consider a broader rewrite or a fundamentally different algorithm.',
                '  - If the previous approach was a broad rewrite, try the smallest possible',
                '    targeted fix that passes the verifier.',
                '  - If the verifier reports a test assertion failure, do NOT just tweak',
                '    the expected output — fix the underlying logic.',
                '  - If the verifier reports a timeout/performance failure, consider',
                '    algorithmic changes (caching, better complexity) not superficial tweaks.',
                '  - If you have tried the same class of fix twice, ABANDON that approach',
                '    and choose one from a different category.',
                '',
                'Repeated same-strategy failures cause QA_REJECTED_MAX_LOOPS termination.',
                '',
              ]
            : []),
          '',
        ]
      : []),
    ...(instruction
      ? [
          'Official task instruction:',
          '```text',
          normalizeAppPaths(instruction, input.prepared.workspace_dir),
          '```',
          '',
        ]
      : []),
    ...(!instruction && trialPrompt
      ? [
          'Original Babel task prompt:',
          '```text',
          normalizeAppPaths(trialPrompt, input.prepared.workspace_dir),
          '```',
          '',
        ]
      : []),
    'Verifier command:',
    input.prepared.docker_image && input.prepared.tests_dir
      ? `docker run --rm -v ${dockerPath(input.prepared.workspace_dir)}:/app -v ${dockerPath(input.prepared.tests_dir)}:/tests:ro -v <logs>:/logs -w /app ${input.prepared.docker_image} bash /tests/test.sh`
      : 'No local Docker verifier is available; use lightweight checks and preserve exact requested artifacts.',
    '',
    'Completion rule: before COMPLETE, make the exact required output artifacts exist, run the strongest available local check, and preserve any already-passing verifier behavior.',
  ].join('\n');
}

async function executeRepairPrompt(input: {
  prompt: string;
  workspaceDir: string;
  iterationDir: string;
  executionProfile: ExecutionProfileName;
  modelTier: string;
  model: string | null;
  dockerImage: string | null;
  deepInfraTimeoutMs: number;
  waterfallTimeoutMs: number;
}): Promise<RepairExecutionResult> {
  const logPath = join(input.iterationDir, 'babel-repair.log');
  const started = performance.now();
  const previousEnv = snapshotEnv([
    'BABEL_PROJECT_ROOT',
    'BABEL_ALLOWED_ROOTS',
    'BABEL_RUNTIME_MODE',
    'BABEL_EXECUTION_PROFILE',
    'BABEL_BENCHMARK_DOCKER_IMAGE',
    'BABEL_DRY_RUN_SOURCE',
    'BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS',
    'BABEL_WATERFALL_TIMEOUT_MS',
  ]);
  process.env['BABEL_PROJECT_ROOT'] = input.workspaceDir;
  process.env['BABEL_ALLOWED_ROOTS'] = input.workspaceDir;
  process.env['BABEL_RUNTIME_MODE'] = 'act';
  process.env['BABEL_EXECUTION_PROFILE'] = input.executionProfile;
  process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = input.dockerImage ?? '';
  process.env['BABEL_DRY_RUN_SOURCE'] = 'persisted';
  process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] = String(input.deepInfraTimeoutMs);
  process.env['BABEL_WATERFALL_TIMEOUT_MS'] = String(input.waterfallTimeoutMs);

  try {
    const result: PipelineResult = await runBabelPipeline(input.prompt, {
      mode: 'deep',
      executionProfile: input.executionProfile,
      modelTier: input.modelTier,
      ...(input.model ? { modelOverride: input.model } : {}),
      sessionStartPath: input.workspaceDir,
      writeLatestPointers: false,
      logFile: logPath,
    });
    return {
      status: result.status === 'COMPLETE' ? 'complete' : 'failed',
      run_dir: result.runDir,
      pipeline_status: result.status,
      duration_ms: Math.round(performance.now() - started),
      log_path: logPath,
      error: result.errors?.join('; ') ?? null,
    };
  } catch (error) {
    return {
      status: 'failed',
      run_dir: null,
      pipeline_status: null,
      duration_ms: Math.round(performance.now() - started),
      log_path: logPath,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    restoreEnv(previousEnv);
  }
}

function runLocalVerifier(
  prepared: PreparedRepairWorkspace,
  iterationDir: string,
  timeoutMs: number,
): VerifierRunResult {
  if (!prepared.docker_image) {
    return makeErrorVerifier('No docker_image was available for the failed task.');
  }
  if (!prepared.tests_dir || !existsSync(prepared.tests_dir)) {
    return makeErrorVerifier(
      `Verifier tests directory not found: ${prepared.tests_dir ?? '(unknown)'}`,
    );
  }
  const logsDir = join(iterationDir, 'verifier-logs');
  mkdirSync(join(logsDir, 'verifier'), { recursive: true });
  const command = buildVerifierCommand(prepared, logsDir);
  const started = performance.now();
  const result = spawnSync('docker', command.args, {
    cwd: prepared.workspace_dir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(join(logsDir, 'verifier', 'test-stdout.txt'), stdout, 'utf8');
  writeFileSync(join(logsDir, 'verifier', 'test-stderr.txt'), stderr, 'utf8');
  const reward = readReward(logsDir);
  return {
    status: reward === 1 ? 'pass' : result.error ? 'error' : 'fail',
    command: command.display,
    reward,
    exit_code: result.status,
    duration_ms: Math.round(performance.now() - started),
    logs_dir: logsDir,
    stdout_excerpt: excerpt(stdout),
    stderr_excerpt: excerpt(stderr),
    error: result.error ? result.error.message : null,
  };
}

function runTargetedBenchmark(input: {
  benchmarksRoot: string;
  suite: string;
  taskName: string | null;
  maxTasks: number;
  modelTier: string;
  model: string | null;
  executionProfile: ExecutionProfileName;
  deepInfraTimeoutMs: number;
  waterfallTimeoutMs: number;
  targetedTimeoutMs: number;
  iterationDir: string;
}): TargetedBenchmarkResult {
  if (!input.taskName) {
    return {
      status: 'error',
      command: null,
      result_path: null,
      reward: null,
      exit_code: null,
      duration_ms: null,
      stdout_excerpt: null,
      stderr_excerpt: null,
      error: 'No selected task was available for targeted benchmark.',
    };
  }
  const runnerPath = join(input.benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
  if (!existsSync(runnerPath)) {
    return {
      status: 'error',
      command: null,
      result_path: null,
      reward: null,
      exit_code: null,
      duration_ms: null,
      stdout_excerpt: null,
      stderr_excerpt: null,
      error: `Terminal-Bench runner not found: ${runnerPath}`,
    };
  }
  const outputDir = join(input.iterationDir, `targeted-${sanitizeSlug(input.taskName)}`);
  const args = buildTargetedBenchmarkArgs({
    runnerPath,
    suite: input.suite,
    taskName: input.taskName,
    maxTasks: input.maxTasks,
    modelTier: input.modelTier,
    model: input.model,
    executionProfile: input.executionProfile,
    deepInfraTimeoutMs: input.deepInfraTimeoutMs,
    waterfallTimeoutMs: input.waterfallTimeoutMs,
    outputDir,
  });
  const started = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: input.benchmarksRoot,
    encoding: 'utf8',
    env: process.env,
    timeout: input.targetedTimeoutMs,
    maxBuffer: 30 * 1024 * 1024,
  });
  const resultPath = join(outputDir, 'result.json');
  const reward = readTargetedReward(resultPath);
  return {
    status: reward === 1 ? 'pass' : result.error ? 'error' : 'fail',
    command: [process.execPath, ...args].map(quoteArg).join(' '),
    result_path: existsSync(resultPath) ? resultPath : null,
    reward,
    exit_code: result.status,
    duration_ms: Math.round(performance.now() - started),
    stdout_excerpt: excerpt(result.stdout ?? ''),
    stderr_excerpt: excerpt(result.stderr ?? ''),
    error: result.error ? result.error.message : null,
  };
}

function buildVerifierCommand(
  prepared: PreparedRepairWorkspace,
  logsDir: string,
): { args: string[]; display: string } {
  const args = [
    'run',
    '--rm',
    '-v',
    `${dockerPath(prepared.workspace_dir)}:/app`,
    '-v',
    `${dockerPath(prepared.tests_dir ?? '')}:/tests:ro`,
    '-v',
    `${dockerPath(logsDir)}:/logs`,
    '-w',
    '/app',
  ];
  const taskToml =
    prepared.task_toml_path && existsSync(prepared.task_toml_path)
      ? readFileSync(prepared.task_toml_path, 'utf8')
      : '';
  const cpus = readTomlNumber(taskToml, 'cpus');
  const memory = readTomlMemory(taskToml);
  if (cpus !== null) args.push('--cpus', String(cpus));
  if (memory) args.push('--memory', memory);
  args.push(prepared.docker_image ?? '', 'bash', '/tests/test.sh');
  return {
    args,
    display: ['docker', ...args].map(quoteArg).join(' '),
  };
}

function buildTargetedBenchmarkArgs(input: {
  runnerPath: string;
  suite: string;
  taskName: string;
  maxTasks: number;
  modelTier: string;
  model: string | null;
  executionProfile: ExecutionProfileName;
  deepInfraTimeoutMs: number;
  waterfallTimeoutMs: number;
  outputDir: string;
}): string[] {
  const args = [
    input.runnerPath,
    '--suite',
    input.suite,
    '--max-tasks',
    '1',
    '--tasks',
    input.taskName,
    '--model-tier',
    input.modelTier,
    '--execution-profile',
    input.executionProfile,
    '--deepinfra-timeout-ms',
    String(input.deepInfraTimeoutMs),
    '--waterfall-timeout-ms',
    String(input.waterfallTimeoutMs),
    '--continue-on-fail',
    'true',
    '--output-dir',
    input.outputDir,
    '--job',
    `babel-repair-loop-${sanitizeSlug(input.taskName)}`,
  ];
  if (input.model) {
    args.push('--model', input.model);
  }
  return args;
}

function planVerifierRun(prepared: PreparedRepairWorkspace, timeoutMs: number): VerifierRunResult {
  if (!prepared.docker_image || !prepared.tests_dir) {
    return {
      status: 'planned',
      command: null,
      reward: null,
      exit_code: null,
      duration_ms: null,
      logs_dir: null,
      stdout_excerpt: null,
      stderr_excerpt: null,
      error: 'Dry run: local verifier would be unavailable without docker_image and tests.',
    };
  }
  const plannedLogs = join(prepared.workspace_dir, '..', 'planned-verifier-logs');
  return {
    status: 'planned',
    command: `${buildVerifierCommand(prepared, plannedLogs).display} # timeout ${timeoutMs}ms`,
    reward: null,
    exit_code: null,
    duration_ms: null,
    logs_dir: plannedLogs,
    stdout_excerpt: null,
    stderr_excerpt: null,
    error: null,
  };
}

function planTargetedBenchmark(input: {
  benchmarksRoot: string;
  suite: string;
  taskName: string | null;
  maxTasks: number;
  modelTier: string;
  model: string | null;
  executionProfile: ExecutionProfileName;
  deepInfraTimeoutMs: number;
  waterfallTimeoutMs: number;
  iterationDir: string;
}): TargetedBenchmarkResult {
  if (!input.taskName) {
    return makeSkippedTargetedBenchmark('Dry run: no selected task.');
  }
  const runnerPath = join(input.benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
  const outputDir = join(input.iterationDir, `targeted-${sanitizeSlug(input.taskName)}`);
  const args = buildTargetedBenchmarkArgs({
    runnerPath,
    suite: input.suite,
    taskName: input.taskName,
    maxTasks: input.maxTasks,
    modelTier: input.modelTier,
    model: input.model,
    executionProfile: input.executionProfile,
    deepInfraTimeoutMs: input.deepInfraTimeoutMs,
    waterfallTimeoutMs: input.waterfallTimeoutMs,
    outputDir,
  });
  return {
    status: 'planned',
    command: [process.execPath, ...args].map(quoteArg).join(' '),
    result_path: join(outputDir, 'result.json'),
    reward: null,
    exit_code: null,
    duration_ms: null,
    stdout_excerpt: null,
    stderr_excerpt: null,
    error: null,
  };
}

function makeSkippedOrPlannedRepairExecution(
  dryRun: boolean,
  skipped: boolean,
): RepairExecutionResult {
  return {
    status: dryRun ? 'planned' : 'skipped',
    run_dir: null,
    pipeline_status: null,
    duration_ms: null,
    log_path: null,
    error: skipped ? 'Skipped by --skip-babel-repair.' : null,
  };
}

function makeSkippedVerifier(reason: string): VerifierRunResult {
  return {
    status: 'skipped',
    command: null,
    reward: null,
    exit_code: null,
    duration_ms: null,
    logs_dir: null,
    stdout_excerpt: null,
    stderr_excerpt: null,
    error: reason,
  };
}

function makeErrorVerifier(error: string): VerifierRunResult {
  return {
    status: 'error',
    command: null,
    reward: null,
    exit_code: null,
    duration_ms: null,
    logs_dir: null,
    stdout_excerpt: null,
    stderr_excerpt: null,
    error,
  };
}

function makeSkippedTargetedBenchmark(reason: string): TargetedBenchmarkResult {
  return {
    status: 'skipped',
    command: null,
    result_path: null,
    reward: null,
    exit_code: null,
    duration_ms: null,
    stdout_excerpt: null,
    stderr_excerpt: null,
    error: reason,
  };
}

function makeBlockedIteration(input: {
  iteration: number;
  inputRun: string;
  repairReport: BenchmarkRepairReport;
  message: string;
}): BenchmarkRepairLoopIteration {
  return {
    iteration: input.iteration,
    input_run: input.inputRun,
    task_name: input.repairReport.task_name,
    repair_report_path: input.repairReport.artifacts.report_path,
    prompt_path: null,
    workspace_dir: null,
    checkpoint_replay: null,
    repair_execution: {
      status: 'failed',
      run_dir: null,
      pipeline_status: null,
      duration_ms: null,
      log_path: null,
      error: input.message,
    },
    verifier: makeSkippedVerifier('Repair workspace preparation failed.'),
    targeted_benchmark: makeSkippedTargetedBenchmark('Repair workspace preparation failed.'),
    changed_files: [],
    snapshot: {
      before_file_count: 0,
      after_file_count: 0,
      changed_files: [],
      rollback: {
        status: 'skipped',
        reason: 'No repair workspace snapshot was available because preparation failed.',
        files_restored: [],
        files_removed: [],
        refused_files: [],
      },
    },
    failure_capsule: buildFailureCapsule({
      attempt: input.iteration,
      pipelineStatus: 'blocked',
      error: input.message,
      changedFiles: [],
      exactInvariantStatus: 'unknown',
    }),
    partial_pass_before: input.repairReport.partial_pass,
    partial_pass_after: null,
    notes: [input.message],
  };
}

function buildIterationFailureCapsule(input: {
  iterationNumber: number;
  repairExecution: RepairExecutionResult;
  verifier: VerifierRunResult;
  targeted: TargetedBenchmarkResult;
  changedFiles: readonly string[];
}): FailureCapsule | null {
  const successful =
    input.targeted.status === 'pass' ||
    (input.verifier.status === 'pass' && input.targeted.status === 'skipped') ||
    input.repairExecution.status === 'planned';
  if (successful) {
    return null;
  }

  const failedCommand =
    input.targeted.status === 'fail' || input.targeted.status === 'error'
      ? input.targeted.command
      : input.verifier.command;
  return buildFailureCapsule({
    attempt: input.iterationNumber,
    pipelineStatus: input.repairExecution.pipeline_status,
    verifierStatus:
      input.targeted.status !== 'skipped' ? input.targeted.status : input.verifier.status,
    failedCommand,
    stdout: input.targeted.stdout_excerpt ?? input.verifier.stdout_excerpt,
    stderr: input.targeted.stderr_excerpt ?? input.verifier.stderr_excerpt,
    error: input.targeted.error ?? input.verifier.error ?? input.repairExecution.error,
    changedFiles: input.changedFiles,
    exactInvariantStatus:
      input.repairExecution.pipeline_status === 'EXACT_INSTRUCTION_DRIFT' ||
      input.repairExecution.pipeline_status === 'AMBIGUOUS_LITERAL_BINDING'
        ? 'fail'
        : 'unknown',
  });
}

function selectBestIteration(iterations: readonly BenchmarkRepairLoopIteration[]): number | null {
  let best: { iteration: number; score: number } | null = null;
  for (const iteration of iterations) {
    const score =
      (iteration.targeted_benchmark.reward ?? -1) * 100 +
      (iteration.verifier.reward ?? -1) * 10 +
      (iteration.repair_execution.status === 'complete' ? 1 : 0);
    if (!best || score > best.score) {
      best = { iteration: iteration.iteration, score };
    }
  }
  return best?.iteration ?? null;
}

function snapshotWorkspaceFiles(root: string): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map();
  const visit = (directory: string, relativePrefix = ''): void => {
    if (!existsSync(directory)) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const stats = statSync(fullPath);
        snapshot.set(relativePath.replace(/\\/g, '/'), {
          size: stats.size,
          mtimeMs: Math.round(stats.mtimeMs),
          contentBase64:
            stats.size <= SNAPSHOT_CONTENT_LIMIT_BYTES
              ? readFileSync(fullPath).toString('base64')
              : null,
        });
      } catch {
        // Ignore files that disappear while an external verifier is writing.
      }
    }
  };
  visit(root);
  return snapshot;
}

function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const changed = new Set<string>();
  for (const [path, afterState] of after.entries()) {
    const beforeState = before.get(path);
    const contentChanged =
      beforeState?.contentBase64 !== null &&
      afterState.contentBase64 !== null &&
      beforeState?.contentBase64 !== afterState.contentBase64;
    if (
      !beforeState ||
      beforeState.size !== afterState.size ||
      beforeState.mtimeMs !== afterState.mtimeMs ||
      contentChanged
    ) {
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

export function restoreWorkspaceSnapshot(
  root: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot = snapshotWorkspaceFiles(root),
): RepairRollbackResult {
  const filesRestored: string[] = [];
  const filesRemoved: string[] = [];
  const refusedFiles: RepairRollbackResult['refused_files'] = [];

  for (const path of after.keys()) {
    if (before.has(path)) {
      continue;
    }
    const target = resolve(root, path);
    if (!isWithinRoot(root, target)) {
      refusedFiles.push({ path, reason: 'New file path would escape the repair workspace.' });
      continue;
    }
    try {
      unlinkSync(target);
      filesRemoved.push(path);
    } catch (error) {
      refusedFiles.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [path, state] of before.entries()) {
    const current = after.get(path);
    const contentChanged =
      current?.contentBase64 !== null &&
      state.contentBase64 !== null &&
      current?.contentBase64 !== state.contentBase64;
    if (
      current &&
      current.size === state.size &&
      current.mtimeMs === state.mtimeMs &&
      !contentChanged
    ) {
      continue;
    }
    if (state.contentBase64 === null) {
      refusedFiles.push({
        path,
        reason: `Snapshot content omitted because file exceeded ${SNAPSHOT_CONTENT_LIMIT_BYTES} bytes.`,
      });
      continue;
    }
    const target = resolve(root, path);
    if (!isWithinRoot(root, target)) {
      refusedFiles.push({ path, reason: 'Snapshot path would escape the repair workspace.' });
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(state.contentBase64, 'base64'));
      filesRestored.push(path);
    } catch (error) {
      refusedFiles.push({
        path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (refusedFiles.length > 0) {
    return {
      status: 'failed',
      reason: 'One or more files could not be restored from the repair snapshot.',
      files_restored: filesRestored,
      files_removed: filesRemoved,
      refused_files: refusedFiles,
    };
  }

  return {
    status: filesRestored.length > 0 || filesRemoved.length > 0 ? 'rolled_back' : 'not_needed',
    reason:
      filesRestored.length > 0 || filesRemoved.length > 0
        ? 'Failed repair changes were rolled back before the next attempt.'
        : 'Workspace already matched the pre-attempt snapshot.',
    files_restored: filesRestored,
    files_removed: filesRemoved,
    refused_files: [],
  };
}

export function snapshotWorkspaceFilesForRepairTest(root: string): WorkspaceSnapshot {
  return snapshotWorkspaceFiles(root);
}

export function diffWorkspaceSnapshotsForRepairTest(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string[] {
  return diffWorkspaceSnapshots(before, after);
}

function safeAnalyzePartialPass(run: string): BenchmarkPartialPassSummary | null {
  try {
    return analyzeTerminalBenchRun({ run }).selected_failure?.partial_pass ?? null;
  } catch {
    return null;
  }
}

function readTargetedReward(resultPath: string): number | null {
  const parsed = readJsonRecordOrNull(resultPath);
  if (!parsed) return null;
  const summary = asRecord(parsed['summary']);
  const passed = numberValue(summary['passed']);
  const trials = numberValue(summary['trials']);
  if (trials !== null && trials > 0 && passed === trials) return 1;
  const rows = Array.isArray(parsed['results'])
    ? parsed['results'].filter(isRecord)
    : Array.isArray(parsed['trials'])
      ? parsed['trials'].filter(isRecord)
      : [];
  const reward = rows.length === 1 ? numberValue(rows[0]?.['reward']) : null;
  return reward === 1 ? 1 : reward === 0 ? 0 : passed === 0 ? 0 : null;
}

function readReward(logsDir: string): number | null {
  const rewardPath = join(logsDir, 'verifier', 'reward.txt');
  if (!existsSync(rewardPath)) return null;
  const text = readFileSync(rewardPath, 'utf8').trim();
  return text === '1' ? 1 : text === '0' ? 0 : null;
}

function checkpointRelativePath(
  record: CheckpointRecord,
  path: string,
  relativePath: string | null,
): string | null {
  if (relativePath && relativePath.trim().length > 0) {
    return relativePath.replace(/\\/g, '/');
  }
  if (record.project_root && isWithinRoot(record.project_root, path)) {
    return relative(record.project_root, path).replace(/\\/g, '/');
  }
  return null;
}

function summarizeWorkspace(workspaceDir: string): string[] {
  if (!existsSync(workspaceDir)) {
    return ['workspace does not exist'];
  }
  const entries = readdirSync(workspaceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 30)
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`);
  return entries.length > 0 ? entries : ['workspace is empty'];
}

function readBoundedText(path: string | null, limit: number): string | null {
  if (!path || !existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return text.length > limit
    ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`
    : text;
}

function normalizeAppPaths(text: string, workspaceDir: string): string {
  return text
    .replaceAll('/app/', '')
    .replaceAll('/app', workspaceDir)
    .replace(/Target project root: .+/g, `Target project root: ${workspaceDir}`);
}

function recommendationForStatus(
  status: BenchmarkRepairLoopStatus,
  nextRun: string | null,
): string {
  switch (status) {
    case 'planned':
      return 'Dry run complete. Re-run without --dry-run to execute repair mode.';
    case 'targeted_passed':
      return 'Targeted benchmark passed. Promote to the benchmark loop gate and then a full pilot.';
    case 'passed_local':
      return 'Local verifier passed. Run the targeted benchmark unless it was intentionally skipped.';
    case 'targeted_failed':
      return `Targeted benchmark failed. Continue repair from the new run: ${nextRun ?? '(unknown)'}.`;
    case 'local_verifier_failed':
      return 'Local verifier still fails. Continue another repair iteration from the preserved workspace.';
    case 'blocked':
      return 'Repair loop is blocked by missing evidence, verifier assets, or an execution error.';
    case 'max_iterations_reached':
      return `Iteration limit reached. Analyze the latest run before another loop: ${nextRun ?? '(unknown)'}.`;
  }
}

function writeLoopReport(report: BenchmarkRepairLoopReport): void {
  mkdirSync(dirname(report.artifact_path), { recursive: true });
  writeFileSync(report.artifact_path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function normalizeRepairExecutionProfile(value: string | undefined): ExecutionProfileName {
  const normalized = normalizeExecutionProfile(value ?? DEFAULT_EXECUTION_PROFILE);
  if (!normalized) {
    throw new Error(`Invalid execution profile "${value}".`);
  }
  return normalized;
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  if (process.platform === 'win32') {
    const normalizedRoot = root.toLowerCase();
    const normalizedCandidate = candidate.toLowerCase();
    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}\\`)
    );
  }
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isSafeRelativePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:/.test(normalized) &&
    !normalized.split('/').includes('..')
  );
}

function readTomlString(toml: string, key: string): string | null {
  const match = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'));
  return match?.[1] ?? null;
}

function readTomlNumber(toml: string, key: string): number | null {
  const matches = [...toml.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*([0-9.]+)`, 'gm'))];
  if (matches.length === 0) return null;
  const raw = matches.at(-1)?.[1];
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}

function readTomlMemory(toml: string): string | null {
  const mb = readTomlNumber(toml, 'memory_mb');
  if (mb) return `${mb}m`;
  const raw = readTomlString(toml, 'memory');
  return raw ? raw.toLowerCase() : null;
}

function dockerPath(path: string): string {
  return resolve(path).replace(/\\/g, '/');
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function sanitizeSlug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repair'
  );
}

function formatTimestampForFile(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function quoteArg(arg: string): string {
  if (!/[\s"']/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function excerpt(text: string): string | null {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  return normalized.length > EXCERPT_LIMIT
    ? `${normalized.slice(0, EXCERPT_LIMIT)}...`
    : normalized;
}

function readJsonRecordOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
