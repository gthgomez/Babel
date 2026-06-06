import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_ROOT } from '../cli/constants.js';
import { getSafeEnv } from '../utils/safeEnv.js';
import { analyzeTerminalBenchRun, type BenchmarkFailureClass, type BenchmarkRunAnalysis } from './benchmarkAnalysis.js';

export type BenchmarkLoopLocalStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type BenchmarkLoopGateStatus = 'pass' | 'fail';
export type BenchmarkLoopNextAction =
  | 'fix_local_readiness'
  | 'wait_for_budget'
  | 'run_full_benchmark'
  | 'fix_target_task'
  | 'run_targeted_benchmark'
  | 'promote';
export type BenchmarkLoopReadinessProfile = 'fast' | 'full' | 'release';

export interface BenchmarkLoopCheck {
  id: string;
  title: string;
  status: BenchmarkLoopLocalStatus;
  command: string | null;
  duration_ms: number | null;
  exit_code: number | null;
  message: string;
}

export interface TerminalBenchRunSummary {
  path: string;
  job_name: string;
  suite: string | null;
  generated_at: string | null;
  trials: number;
  passed: number;
  failed: number;
  mean_reward: number | null;
  babel_completed: number | null;
  babel_timeouts: number | null;
  verifier_errors: number | null;
  false_completes: number | null;
  failed_tasks: string[];
  passed_tasks: string[];
}

export interface BenchmarkImprovementLoopReport {
  schema_version: 1;
  report_type: 'babel_benchmark_improvement_loop';
  generated_at: string;
  artifact_path: string;
  thresholds: {
    suite: string;
    max_tasks: number;
    min_full_passes: number;
    model_tier: string;
    deepinfra_timeout_ms: number;
    waterfall_timeout_ms: number;
    readiness_profile: BenchmarkLoopReadinessProfile;
    deadline_at: string | null;
    min_remaining_ms: number;
  };
  local_readiness: {
    status: BenchmarkLoopGateStatus;
    checks: BenchmarkLoopCheck[];
  };
  terminal_bench: {
    benchmarks_root: string;
    runner_path: string;
    runner_exists: boolean;
    latest_full: TerminalBenchRunSummary | null;
    latest_targeted: TerminalBenchRunSummary | null;
    selected_task: string | null;
    latest_full_analysis: BenchmarkRunAnalysis | null;
    selected_task_score: BenchmarkLoopTargetScore | null;
  };
  readiness_gate: {
    status: BenchmarkLoopGateStatus;
    reason: string;
    promotion_ready: boolean;
  };
  next_action: {
    kind: BenchmarkLoopNextAction;
    command: string | null;
    rationale: string;
  };
  loop_plan: string[];
  commands: {
    local_gate: string;
    analyze_latest: string | null;
    targeted_benchmark: string | null;
    full_benchmark: string;
  };
  loop_state: BenchmarkLoopState;
}

export interface BenchmarkImprovementLoopOptions {
  babelRoot?: string;
  benchmarksRoot?: string;
  suite?: string;
  maxTasks?: number;
  minFullPasses?: number;
  modelTier?: string;
  deepInfraTimeoutMs?: number;
  waterfallTimeoutMs?: number;
  targetTask?: string;
  jobSlug?: string;
  outputDir?: string;
  runLocalChecks?: boolean;
  readinessProfile?: BenchmarkLoopReadinessProfile;
  deadlineAt?: string | Date;
  minRemainingMs?: number;
  now?: Date;
}

export interface BenchmarkLoopTargetScore {
  task: string;
  score: number;
  failure_class: BenchmarkFailureClass | null;
  stale_targeted_pass: boolean;
  recent_targeted_failures: number;
  rationale: string[];
}

export interface BenchmarkLoopState {
  schema_version: 1;
  state_path: string;
  event_log_path: string;
  updated_at: string;
  iteration: number;
  latest_full_path: string | null;
  latest_targeted_path: string | null;
  selected_task: string | null;
  next_action: BenchmarkLoopNextAction;
  readiness_profile: BenchmarkLoopReadinessProfile;
  score: {
    passed: number | null;
    trials: number | null;
    mean_reward: number | null;
  };
  last_artifact_path: string;
}

interface CommandResult {
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  error?: string;
}

const DEFAULT_SUITE = 'pilot10';
const DEFAULT_MAX_TASKS = 10;
const DEFAULT_MIN_FULL_PASSES = 5;
const DEFAULT_MODEL_TIER = 'cheap';
const DEFAULT_DEEPINFRA_TIMEOUT_MS = 240_000;
const DEFAULT_WATERFALL_TIMEOUT_MS = 720_000;
const DEFAULT_JOB_SLUG = 'improvement-loop';
const COMMAND_OUTPUT_LIMIT = 1200;

const CHECK_DEFINITIONS: Record<string, {
  id: string;
  title: string;
  command: string[];
  timeoutMs: number;
}> = {
  source_typecheck: {
    id: 'source_typecheck',
    title: 'Source typecheck',
    command: npmRunCommand('typecheck'),
    timeoutMs: 120_000,
  },
  unit_tests: {
    id: 'unit_tests',
    title: 'Unit test suite',
    command: npmRunCommand('test:unit'),
    timeoutMs: 240_000,
  },
  build: {
    id: 'build',
    title: 'Build compiled CLI',
    command: npmRunCommand('build'),
    timeoutMs: 120_000,
  },
  dist_check: {
    id: 'dist_check',
    title: 'Dist/source drift check',
    command: npmRunCommand('check:dist'),
    timeoutMs: 180_000,
  },
  cli_doctor: {
    id: 'cli_doctor',
    title: 'CLI doctor health check',
    command: [process.execPath, 'dist/index.js', 'doctor', '--scope', 'all', '--json'],
    timeoutMs: 120_000,
  },
  terminal_bench_docker: {
    id: 'terminal_bench_docker',
    title: 'Terminal-Bench Docker daemon',
    command: ['docker', 'info', '--format', '{{json .ServerVersion}}'],
    timeoutMs: 30_000,
  },
  product_benchmark: {
    id: 'product_benchmark',
    title: 'Product benchmark with readiness gate',
    command: npmRunCommand('benchmark:product'),
    timeoutMs: 180_000,
  },
  source_provenance: {
    id: 'source_provenance',
    title: 'Source provenance check',
    command: npmRunCommand('check:source-provenance'),
    timeoutMs: 120_000,
  },
};

const READINESS_PROFILES: Record<BenchmarkLoopReadinessProfile, string[]> = {
  fast: ['source_typecheck', 'unit_tests', 'build'],
  full: ['source_typecheck', 'unit_tests', 'build', 'dist_check', 'cli_doctor', 'terminal_bench_docker', 'product_benchmark'],
  release: ['source_typecheck', 'unit_tests', 'build', 'dist_check', 'source_provenance', 'cli_doctor', 'terminal_bench_docker', 'product_benchmark'],
};

export function buildBenchmarkImprovementLoopReport(
  options: BenchmarkImprovementLoopOptions = {},
): BenchmarkImprovementLoopReport {
  const babelRoot = resolve(options.babelRoot ?? BABEL_ROOT);
  const cliRoot = join(babelRoot, 'babel-cli');
  const workspaceRoot = dirname(babelRoot);
  const benchmarksRoot = resolve(options.benchmarksRoot ?? join(workspaceRoot, 'benchmarks'));
  const suite = options.suite ?? DEFAULT_SUITE;
  const maxTasks = positiveInt(options.maxTasks, DEFAULT_MAX_TASKS);
  const minFullPasses = positiveInt(options.minFullPasses, DEFAULT_MIN_FULL_PASSES);
  const modelTier = options.modelTier ?? DEFAULT_MODEL_TIER;
  const deepInfraTimeoutMs = positiveInt(options.deepInfraTimeoutMs, DEFAULT_DEEPINFRA_TIMEOUT_MS);
  const waterfallTimeoutMs = positiveInt(options.waterfallTimeoutMs, Math.max(DEFAULT_WATERFALL_TIMEOUT_MS, deepInfraTimeoutMs * 3));
  const readinessProfile = normalizeReadinessProfile(options.readinessProfile);
  const deadlineAt = normalizeDeadlineAt(options.deadlineAt);
  const minRemainingMs = positiveInt(options.minRemainingMs, 0);
  const jobSlug = sanitizeSlug(options.jobSlug ?? DEFAULT_JOB_SLUG);
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const outputDir = resolve(options.outputDir ?? join(babelRoot, 'runs', 'benchmarks'));
  mkdirSync(outputDir, { recursive: true });

  const localChecks = options.runLocalChecks === false
    ? readinessChecksForProfile(readinessProfile).map((check): BenchmarkLoopCheck => ({
      id: check.id,
      title: check.title,
      status: 'skip',
      command: check.command.join(' '),
      duration_ms: null,
      exit_code: null,
      message: `Skipped by --skip-local-checks for ${readinessProfile} readiness.`,
    }))
    : runLocalReadinessChecks(cliRoot, readinessProfile);

  const localStatus: BenchmarkLoopGateStatus = localChecks.some((check) => check.status === 'fail') ? 'fail' : 'pass';
  const runnerPath = join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
  const resultRoot = join(benchmarksRoot, 'runs', 'terminal-bench-2');
  const runSummaries = listTerminalBenchRuns(resultRoot, suite);
  const latestFull = runSummaries.find((run) => run.trials >= maxTasks) ?? null;
  const recentTargeted = runSummaries.filter((run) => run.trials === 1);
  const latestTargeted = recentTargeted[0] ?? null;
  const latestFullAnalysis = latestFull ? safeAnalyzeRun(latestFull.path, now) : null;
  const targetSelection = scoreTargetTasks(latestFull, recentTargeted, latestFullAnalysis);
  const selectedTask = options.targetTask ?? targetSelection.selected?.task ?? null;
  const selectedTaskScore = selectedTask
    ? targetSelection.scores.find((score) => score.task === selectedTask) ?? null
    : null;
  const commands = buildLoopCommands({
    runnerPath,
    suite,
    maxTasks,
    modelTier,
    deepInfraTimeoutMs,
    waterfallTimeoutMs,
    jobSlug,
    selectedTask,
    deadlineAt,
    minRemainingMs,
    now,
  });

  const nextAction = chooseNextAction({
    localStatus,
    runnerExists: existsSync(runnerPath),
    latestFull,
    latestTargeted,
    selectedTask,
    minFullPasses,
    deadlineAt,
    minRemainingMs,
    now,
    commands,
  });

  const readinessGate = {
    status: nextAction.kind === 'promote' ? 'pass' as const : 'fail' as const,
    reason: nextAction.rationale,
    promotion_ready: nextAction.kind === 'promote',
  };

  const artifactPath = join(outputDir, `benchmark-loop-${formatTimestampForFile(now)}.json`);
  const loopState = writeLoopState({
    outputDir,
    now,
    artifactPath,
    readinessProfile,
    latestFull,
    latestTargeted,
    selectedTask,
    nextActionKind: nextAction.kind,
  });
  const report: BenchmarkImprovementLoopReport = {
    schema_version: 1,
    report_type: 'babel_benchmark_improvement_loop',
    generated_at: generatedAt,
    artifact_path: artifactPath,
    thresholds: {
      suite,
      max_tasks: maxTasks,
      min_full_passes: minFullPasses,
      model_tier: modelTier,
      deepinfra_timeout_ms: deepInfraTimeoutMs,
      waterfall_timeout_ms: waterfallTimeoutMs,
      readiness_profile: readinessProfile,
      deadline_at: deadlineAt,
      min_remaining_ms: minRemainingMs,
    },
    local_readiness: {
      status: localStatus,
      checks: localChecks,
    },
    terminal_bench: {
      benchmarks_root: benchmarksRoot,
      runner_path: runnerPath,
      runner_exists: existsSync(runnerPath),
      latest_full: latestFull,
      latest_targeted: latestTargeted,
      selected_task: selectedTask,
      latest_full_analysis: latestFullAnalysis,
      selected_task_score: selectedTaskScore,
    },
    readiness_gate: readinessGate,
    next_action: nextAction,
    loop_plan: [
      'Run benchmark loop gate; stop immediately if local readiness fails.',
      'Use the latest full Terminal-Bench result to select one failing task.',
      'Implement one focused reliability fix for that task class.',
      'Run typecheck/unit/build/dist/product checks through this loop gate.',
      'Run the targeted Terminal-Bench command for the selected task.',
      'Run the full pilot only after the targeted task passes or clearly exercises the fix.',
      `Repeat until the full ${suite} pilot reaches at least ${minFullPasses}/${maxTasks} with no avoidable false COMPLETE pattern.`,
    ],
    commands,
    loop_state: loopState,
  };

  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function formatBenchmarkImprovementLoopHuman(report: BenchmarkImprovementLoopReport): string {
  const latestFull = report.terminal_bench.latest_full;
  const latestTargeted = report.terminal_bench.latest_targeted;
  const lines = [
    'Babel Benchmark Improvement Loop',
    '',
    `Gate: ${report.readiness_gate.status.toUpperCase()} - ${report.readiness_gate.reason}`,
    `Artifact: ${report.artifact_path}`,
    `State: ${report.loop_state.state_path}`,
    `Readiness profile: ${report.thresholds.readiness_profile}`,
    '',
    `Local readiness: ${report.local_readiness.status.toUpperCase()}`,
    ...report.local_readiness.checks.map((check) => {
      const suffix = check.exit_code === null ? '' : ` (exit ${check.exit_code})`;
      return `- ${check.id}: ${check.status}${suffix}`;
    }),
    '',
    'Terminal-Bench evidence:',
    latestFull
      ? `- latest full: ${latestFull.passed}/${latestFull.trials} passed, mean reward ${latestFull.mean_reward ?? 'unknown'} (${latestFull.path})`
      : '- latest full: none found',
    latestTargeted
      ? `- latest targeted: ${latestTargeted.passed}/${latestTargeted.trials} passed (${latestTargeted.path})`
      : '- latest targeted: none found',
    `- selected task: ${report.terminal_bench.selected_task ?? 'none'}`,
    report.terminal_bench.selected_task_score
      ? `- selected score: ${report.terminal_bench.selected_task_score.score} (${report.terminal_bench.selected_task_score.rationale.join('; ')})`
      : '- selected score: none',
    report.terminal_bench.latest_full_analysis
      ? `- analysis: false completes ${report.terminal_bench.latest_full_analysis.summary.false_completes}, countable ${report.terminal_bench.latest_full_analysis.countable ? 'yes' : 'no'}`
      : '- analysis: none',
    '',
    `Next action: ${report.next_action.kind}`,
    report.next_action.command ? `Command: ${report.next_action.command}` : 'Command: none',
    '',
    'Loop:',
    ...report.loop_plan.map((step, index) => `${index + 1}. ${step}`),
  ];
  return lines.join('\n');
}

function runLocalReadinessChecks(cliRoot: string, profile: BenchmarkLoopReadinessProfile): BenchmarkLoopCheck[] {
  return readinessChecksForProfile(profile).map((check) => {
    const result = runCommand(check.command, cliRoot, check.timeoutMs);
    const status: BenchmarkLoopLocalStatus = result.exitCode === 0 ? 'pass' : 'fail';
    return {
      id: check.id,
      title: check.title,
      status,
      command: check.command.join(' '),
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      message: status === 'pass'
        ? `${check.title} passed.`
        : summarizeCommandFailure(result),
    };
  });
}

function readinessChecksForProfile(profile: BenchmarkLoopReadinessProfile): Array<{
  id: string;
  title: string;
  command: string[];
  timeoutMs: number;
}> {
  return READINESS_PROFILES[profile].map((id) => CHECK_DEFINITIONS[id]!);
}

function runCommand(command: string[], cwd: string, timeoutMs: number): CommandResult {
  const started = performance.now();
  const invocation = buildSpawnInvocation(command);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd,
    encoding: 'utf8',
    env: getSafeEnv(process.env),
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    exitCode: result.status,
    durationMs: Math.round(performance.now() - started),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function listTerminalBenchRuns(resultRoot: string, suite: string): TerminalBenchRunSummary[] {
  if (!existsSync(resultRoot)) return [];
  const resultPaths = collectResultJsonFiles(resultRoot)
    .filter((file) => dirname(file) !== resultRoot);
  const summaries = resultPaths
    .map((file) => readTerminalBenchRun(file, suite))
    .filter((summary): summary is TerminalBenchRunSummary => summary !== null);
  return summaries.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
}

function collectResultJsonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectResultJsonFiles(fullPath, out);
    } else if (entry.name === 'result.json') {
      out.push(fullPath);
    }
  }
  return out;
}

function readTerminalBenchRun(file: string, suite: string): TerminalBenchRunSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const summary = isRecord(parsed.summary) ? parsed.summary : {};
  const trials = Array.isArray(parsed.trials)
    ? parsed.trials.filter(isRecord)
    : Array.isArray(parsed.results)
      ? parsed.results.filter(isRecord)
      : [];
  const trialCount = numberValue(summary.trials) ?? trials.length;
  if (trialCount <= 0) return null;

  const configSuite = typeof parsed.suite === 'string' ? parsed.suite : null;
  if (configSuite && configSuite !== suite) return null;

  const passedTasks = trials
    .filter((trial) => trialPassed(trial))
    .map((trial) => taskName(trial))
    .filter((task): task is string => task !== null);
  const failedTasks = trials
    .filter((trial) => !trialPassed(trial))
    .map((trial) => taskName(trial))
    .filter((task): task is string => task !== null);
  const passed = numberValue(summary.passed) ?? passedTasks.length;
  const failed = numberValue(summary.failed) ?? Math.max(0, trialCount - passed);
  const babelCompleted = numberValue(summary.babel_completed);
  return {
    path: file,
    job_name: typeof parsed.job_name === 'string' ? parsed.job_name : dirname(file).split(/[\\/]/).pop() ?? 'unknown',
    suite: configSuite,
    generated_at: typeof parsed.finished_at === 'string'
      ? parsed.finished_at
      : typeof parsed.started_at === 'string'
        ? parsed.started_at
        : null,
    trials: trialCount,
    passed,
    failed,
    mean_reward: numberValue(summary.mean_reward),
    babel_completed: babelCompleted,
    babel_timeouts: numberValue(summary.babel_timeouts),
    verifier_errors: numberValue(summary.verifier_errors),
    false_completes: babelCompleted === null ? null : Math.max(0, babelCompleted - passed),
    failed_tasks: failedTasks,
    passed_tasks: passedTasks,
  };
}

function chooseNextAction(options: {
  localStatus: BenchmarkLoopGateStatus;
  runnerExists: boolean;
  latestFull: TerminalBenchRunSummary | null;
  latestTargeted: TerminalBenchRunSummary | null;
  selectedTask: string | null;
  minFullPasses: number;
  deadlineAt: string | null;
  minRemainingMs: number;
  now: Date;
  commands: BenchmarkImprovementLoopReport['commands'];
}): BenchmarkImprovementLoopReport['next_action'] {
  if (options.localStatus === 'fail') {
    return {
      kind: 'fix_local_readiness',
      command: options.commands.local_gate,
      rationale: 'Local source/readiness checks must pass before benchmark iteration is meaningful.',
    };
  }
  if (!options.runnerExists) {
    return {
      kind: 'fix_local_readiness',
      command: null,
      rationale: 'Terminal-Bench runner script is missing, so the loop cannot run.',
    };
  }
  if (!hasEnoughBudget(options.deadlineAt, options.minRemainingMs, options.now)) {
    return {
      kind: 'wait_for_budget',
      command: options.commands.local_gate,
      rationale: `Remaining deadline budget is below ${options.minRemainingMs}ms; stop before starting another benchmark run.`,
    };
  }
  if (!options.latestFull) {
    return {
      kind: 'run_full_benchmark',
      command: options.commands.full_benchmark,
      rationale: 'No full Terminal-Bench pilot result was found; establish a broad baseline first.',
    };
  }
  if (
    options.latestFull.passed >= options.minFullPasses &&
    (options.latestFull.false_completes === null || options.latestFull.false_completes === 0)
  ) {
    return {
      kind: 'promote',
      command: null,
      rationale: `Latest full pilot reached ${options.latestFull.passed}/${options.latestFull.trials} without recorded false completes.`,
    };
  }
  if (!options.selectedTask) {
    return {
      kind: 'fix_target_task',
      command: null,
      rationale: 'Full pilot is below target, but no failed task could be selected from the latest result.',
    };
  }
  if (
    options.latestTargeted &&
    isRunNewerThan(options.latestTargeted, options.latestFull) &&
    options.latestTargeted.passed === options.latestTargeted.trials &&
    options.latestTargeted.passed_tasks.includes(options.selectedTask)
  ) {
    return {
      kind: 'run_full_benchmark',
      command: options.commands.full_benchmark,
      rationale: `Targeted canary passed for ${options.selectedTask}; run the full pilot to measure broad reward.`,
    };
  }
  return {
    kind: 'run_targeted_benchmark',
    command: options.commands.targeted_benchmark,
    rationale: `Full pilot is below ${options.minFullPasses} passes; test the selected failing task ${options.selectedTask} before another full run.`,
  };
}

function buildLoopCommands(options: {
  runnerPath: string;
  suite: string;
  maxTasks: number;
  modelTier: string;
  deepInfraTimeoutMs: number;
  waterfallTimeoutMs: number;
  jobSlug: string;
  selectedTask: string | null;
  deadlineAt: string | null;
  minRemainingMs: number;
  now: Date;
}): BenchmarkImprovementLoopReport['commands'] {
  const stamp = formatTimestampForJob(options.now);
  const base = [
    process.execPath,
    options.runnerPath,
    '--suite',
    options.suite,
    '--model-tier',
    options.modelTier,
    '--deepinfra-timeout-ms',
    String(options.deepInfraTimeoutMs),
    '--waterfall-timeout-ms',
    String(options.waterfallTimeoutMs),
    '--continue-on-fail',
    'true',
  ];
  if (options.deadlineAt) {
    base.push('--deadline', options.deadlineAt);
  }
  if (options.minRemainingMs > 0) {
    base.push('--min-remaining-ms', String(options.minRemainingMs));
  }
  const full = [
    ...base,
    '--max-tasks',
    String(options.maxTasks),
    '--job',
    `babel-autonomous-${options.suite}-${stamp}-${options.jobSlug}-full`,
  ].map(quoteArg).join(' ');
  const targeted = options.selectedTask
    ? [
      ...base,
      '--max-tasks',
      '1',
      '--tasks',
      options.selectedTask,
      '--job',
      `babel-autonomous-${options.suite}-${stamp}-${options.jobSlug}-${sanitizeSlug(options.selectedTask)}`,
    ].map(quoteArg).join(' ')
    : null;
  return {
    local_gate: 'node .\\dist\\index.js benchmark loop --json',
    analyze_latest: 'node .\\dist\\index.js benchmark analyze latest --json',
    targeted_benchmark: targeted,
    full_benchmark: full,
  };
}

function scoreTargetTasks(
  latestFull: TerminalBenchRunSummary | null,
  recentTargeted: readonly TerminalBenchRunSummary[],
  latestFullAnalysis: BenchmarkRunAnalysis | null,
): { selected: BenchmarkLoopTargetScore | null; scores: BenchmarkLoopTargetScore[] } {
  const candidates = latestFull?.failed_tasks.length
    ? latestFull.failed_tasks
    : recentTargeted[0]?.failed_tasks ?? [];
  const latestTargeted = recentTargeted[0] ?? null;
  const analysisByTask = new Map<string, BenchmarkFailureClass>();
  if (latestFullAnalysis) {
    for (const trial of latestFullAnalysis.trials) {
      analysisByTask.set(trial.task_name, trial.failure_class);
    }
  }
  const uniqueCandidates = [...new Set(candidates)];
  const scores = uniqueCandidates.map((task): BenchmarkLoopTargetScore => {
    const failureClass = analysisByTask.get(task) ?? null;
    const recentFailures = recentTargeted
      .filter((run) => run.passed === 0 && run.failed_tasks.includes(task))
      .length;
    const staleTargetedPass = recentTargeted.some((run) =>
      run.passed === run.trials &&
      run.passed_tasks.includes(task) &&
      latestFull !== null &&
      !isRunNewerThan(run, latestFull));
    const rationale: string[] = [];
    let score = 100;
    score += failureClassWeight(failureClass);
    if (latestTargeted && isRunNewerThan(latestTargeted, latestFull) && latestTargeted.failed_tasks.includes(task)) {
      score -= 20;
      rationale.push('latest targeted canary already failed this task');
    }
    if (recentFailures > 0) {
      score -= recentFailures * 12;
      rationale.push(`${recentFailures} recent targeted failure(s)`);
    }
    if (staleTargetedPass) {
      score -= 10;
      rationale.push('has a stale targeted pass before the latest full run');
    }
    if (failureClass) {
      rationale.push(`latest full failure class: ${failureClass}`);
    }
    if (rationale.length === 0) {
      rationale.push('failed in latest broad run with no newer targeted evidence');
    }
    return {
      task,
      score,
      failure_class: failureClass,
      stale_targeted_pass: staleTargetedPass,
      recent_targeted_failures: recentFailures,
      rationale,
    };
  }).sort((left, right) => right.score - left.score || left.task.localeCompare(right.task));
  return {
    selected: scores[0] ?? null,
    scores,
  };
}

function failureClassWeight(failureClass: BenchmarkFailureClass | null): number {
  switch (failureClass) {
    case 'false_complete':
      return 40;
    case 'agent_failed':
      return 34;
    case 'agent_timeout':
      return 28;
    case 'missing_artifact':
      return 25;
    case 'verifier_failed':
      return 18;
    case 'verifier_timeout':
    case 'verifier_error':
      return 10;
    case 'environment_setup_failed':
      return -20;
    case 'interrupted':
      return -30;
    case 'unknown':
      return 0;
    case 'passed':
      return -100;
    case null:
      return 0;
  }
}

function selectTargetTask(
  latestFull: TerminalBenchRunSummary | null,
  recentTargeted: readonly TerminalBenchRunSummary[],
): string | null {
  const latestTargeted = recentTargeted[0] ?? null;
  if (
    latestTargeted &&
    isRunNewerThan(latestTargeted, latestFull) &&
    latestTargeted.passed === latestTargeted.trials &&
    latestTargeted.passed_tasks.length > 0
  ) {
    return latestTargeted.passed_tasks[0] ?? null;
  }

  const candidates = latestFull?.failed_tasks.length
    ? latestFull.failed_tasks
    : latestTargeted?.failed_tasks ?? [];
  if (candidates.length === 0) {
    return null;
  }

  const failureCounts = new Map<string, number>();
  for (const run of recentTargeted.slice(0, Math.max(10, candidates.length * 2))) {
    if (run.passed > 0) {
      continue;
    }
    for (const task of run.failed_tasks) {
      failureCounts.set(task, (failureCounts.get(task) ?? 0) + 1);
    }
  }

  let selected = candidates[0] ?? null;
  let selectedFailures = selected ? failureCounts.get(selected) ?? 0 : Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const failures = failureCounts.get(candidate) ?? 0;
    if (failures < selectedFailures) {
      selected = candidate;
      selectedFailures = failures;
    }
  }
  return selected;
}

function isRunNewerThan(candidate: TerminalBenchRunSummary, baseline: TerminalBenchRunSummary | null): boolean {
  if (!baseline) return true;
  const candidateMs = timestampMs(candidate.generated_at);
  const baselineMs = timestampMs(baseline.generated_at);
  if (candidateMs !== null && baselineMs !== null) {
    return candidateMs > baselineMs;
  }
  return candidate.generated_at === null || baseline.generated_at === null;
}

function safeAnalyzeRun(resultPath: string, now: Date): BenchmarkRunAnalysis | null {
  try {
    return analyzeTerminalBenchRun({ run: resultPath, now });
  } catch {
    return null;
  }
}

function writeLoopState(input: {
  outputDir: string;
  now: Date;
  artifactPath: string;
  readinessProfile: BenchmarkLoopReadinessProfile;
  latestFull: TerminalBenchRunSummary | null;
  latestTargeted: TerminalBenchRunSummary | null;
  selectedTask: string | null;
  nextActionKind: BenchmarkLoopNextAction;
}): BenchmarkLoopState {
  const statePath = join(input.outputDir, 'loop-state.json');
  const eventLogPath = join(input.outputDir, 'loop-events.jsonl');
  const previous = readLoopState(statePath);
  const iteration = (previous?.iteration ?? 0) + 1;
  const state: BenchmarkLoopState = {
    schema_version: 1,
    state_path: statePath,
    event_log_path: eventLogPath,
    updated_at: input.now.toISOString(),
    iteration,
    latest_full_path: input.latestFull?.path ?? null,
    latest_targeted_path: input.latestTargeted?.path ?? null,
    selected_task: input.selectedTask,
    next_action: input.nextActionKind,
    readiness_profile: input.readinessProfile,
    score: {
      passed: input.latestFull?.passed ?? null,
      trials: input.latestFull?.trials ?? null,
      mean_reward: input.latestFull?.mean_reward ?? null,
    },
    last_artifact_path: input.artifactPath,
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  appendFileSync(eventLogPath, `${JSON.stringify({
    type: 'benchmark_loop_iteration',
    iteration,
    generated_at: input.now.toISOString(),
    artifact_path: input.artifactPath,
    latest_full_path: input.latestFull?.path ?? null,
    latest_targeted_path: input.latestTargeted?.path ?? null,
    selected_task: input.selectedTask,
    next_action: input.nextActionKind,
    readiness_profile: input.readinessProfile,
  })}\n`, 'utf8');
  return state;
}

function readLoopState(path: string): BenchmarkLoopState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(parsed) && parsed.schema_version === 1 ? parsed as unknown as BenchmarkLoopState : null;
  } catch {
    return null;
  }
}

function hasEnoughBudget(deadlineAt: string | null, minRemainingMs: number, now: Date): boolean {
  if (!deadlineAt) return true;
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return true;
  return deadlineMs - now.getTime() > minRemainingMs;
}

function summarizeCommandFailure(result: CommandResult): string {
  const output = [result.error, result.stderr, result.stdout]
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .join('\n')
    .trim();
  const preview = output.length > COMMAND_OUTPUT_LIMIT
    ? `${output.slice(0, COMMAND_OUTPUT_LIMIT)}...`
    : output;
  return preview || 'Command failed without output.';
}

function trialPassed(trial: Record<string, unknown>): boolean {
  return trial.passed === true || trial.reward === 1 || trial.reward === 1.0;
}

function taskName(trial: Record<string, unknown>): string | null {
  for (const key of ['task', 'task_name', 'id']) {
    if (typeof trial[key] === 'string' && trial[key].trim().length > 0) {
      return trial[key].trim();
    }
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function normalizeReadinessProfile(value: unknown): BenchmarkLoopReadinessProfile {
  return value === 'fast' || value === 'release' || value === 'full' ? value : 'full';
}

function normalizeDeadlineAt(value: string | Date | undefined): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function npmRunCommand(script: string): string[] {
  const npmExecPath = process.env['npm_execpath'];
  if (npmExecPath && existsSync(npmExecPath)) {
    return [process.execPath, npmExecPath, 'run', script];
  }
  const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundledNpmCli)) {
    return [process.execPath, bundledNpmCli, 'run', script];
  }
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm', 'run', script];
}

function buildSpawnInvocation(command: string[]): { executable: string; args: string[] } {
  const executable = command[0]!;
  const args = command.slice(1);
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    return {
      executable: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', [executable, ...args].map(quoteCmdArg).join(' ')],
    };
  }
  return { executable, args };
}

function quoteCmdArg(arg: string): string {
  if (!/[\s"&<>|^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function sanitizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loop';
}

function formatTimestampForFile(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function formatTimestampForJob(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function quoteArg(arg: string): string {
  if (!/[\s"']/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}
