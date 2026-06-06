import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { classifyBenchmarkTaskRisk, type BenchmarkRiskLabel } from '../stages/benchmarkTaskRisk.js';

export type BenchmarkFailureClass =
  | 'passed'
  | 'agent_timeout'
  | 'agent_failed'
  | 'false_complete'
  | 'verifier_failed'
  | 'verifier_timeout'
  | 'verifier_error'
  | 'environment_setup_failed'
  | 'interrupted'
  | 'missing_artifact'
  | 'unknown';

export interface BenchmarkTrialAnalysis {
  task_name: string;
  trial_name: string;
  trial_dir: string | null;
  passed: boolean;
  reward: number | null;
  failure_class: BenchmarkFailureClass;
  babel_status: string | null;
  babel_result_status: string | null;
  babel_run_dir: string | null;
  verifier_status: string | number | null;
  verifier_exit_code: number | null;
  key_artifacts: string[];
  notes: string[];
  risk_labels: BenchmarkRiskLabel[];
  failure_fingerprint: string | null;
  partial_pass: BenchmarkPartialPassSummary | null;
  repair_loop: {
    status: string | null;
    failure_count: number | null;
    repeated: boolean;
  };
}

export interface BenchmarkFailedTestSummary {
  name: string;
  status: string;
  category: string;
  message: string | null;
  trace_excerpt: string | null;
}

export interface BenchmarkPartialPassSummary {
  total: number;
  passed: number;
  failed: number;
  pass_rate: number | null;
  failed_tests: BenchmarkFailedTestSummary[];
  failure_categories: Record<string, number>;
  blocking_category: string | null;
}

export interface BenchmarkCandidateCheckpoint {
  checkpoint_id: string;
  step: number | null;
  command: string | null;
  exit_code: number | null;
  total_tests: number | null;
  passed_tests: number | null;
  failed_tests: number | null;
  failure_classes: string[];
  runtime_seconds: number | null;
  reason: string;
}

export interface BenchmarkRunAnalysis {
  schema_version: 1;
  report_type: 'babel_benchmark_analysis';
  generated_at: string;
  run_dir: string;
  result_path: string;
  job_name: string;
  suite: string | null;
  countable: boolean;
  interrupted: boolean;
  summary: {
    trials: number;
    passed: number;
    failed: number;
    mean_reward: number | null;
    babel_completed: number | null;
    babel_timeouts: number | null;
    verifier_errors: number | null;
    false_completes: number;
  };
  failure_counts: Record<BenchmarkFailureClass, number>;
  trials: BenchmarkTrialAnalysis[];
  selected_failure: BenchmarkTrialAnalysis | null;
  work_packet: {
    headline: string;
    focus_task: string | null;
    likely_owner: string;
    risk_labels: BenchmarkRiskLabel[];
    failure_fingerprint: string | null;
    partial_pass: BenchmarkPartialPassSummary | null;
    best_candidate_checkpoint: string | null;
    best_candidate: BenchmarkCandidateCheckpoint | null;
    evidence_paths: string[];
    suggested_commands: string[];
    notes: string[];
  };
}

export function analyzeTerminalBenchRun(input: {
  run: string;
  now?: Date;
}): BenchmarkRunAnalysis {
  const resultPath = resolveResultPath(input.run);
  const runDir = dirname(resultPath);
  const parsed = readJsonRecord(resultPath);
  const summary = asRecord(parsed['summary']);
  const jobInterrupted = parsed['interrupted'] === true;
  const rows = resultRows(parsed);
  const trials = rows.map((row) => analyzeTrial(row, runDir, jobInterrupted));
  const failureCounts = emptyFailureCounts();
  for (const trial of trials) {
    failureCounts[trial.failure_class] += 1;
  }
  if (jobInterrupted && trials.length === 0) {
    failureCounts.interrupted += 1;
  }
  const selectedFailure = trials.find((trial) => trial.failure_class !== 'passed') ?? null;
  const falseCompletes = failureCounts.false_complete;
  const passed = numberValue(summary['passed']) ?? trials.filter((trial) => trial.passed).length;
  const trialCount = numberValue(summary['trials']) ?? trials.length;
  const failed = numberValue(summary['failed']) ?? Math.max(0, trialCount - passed);
  const countable = parsed['countable'] !== false && !jobInterrupted && trialCount > 0;
  return {
    schema_version: 1,
    report_type: 'babel_benchmark_analysis',
    generated_at: (input.now ?? new Date()).toISOString(),
    run_dir: runDir,
    result_path: resultPath,
    job_name: stringValue(parsed['job_name']) ?? basename(runDir),
    suite: stringValue(parsed['suite']),
    countable,
    interrupted: jobInterrupted,
    summary: {
      trials: trialCount,
      passed,
      failed,
      mean_reward: numberValue(summary['mean_reward']),
      babel_completed: numberValue(summary['babel_completed']),
      babel_timeouts: numberValue(summary['babel_timeouts']),
      verifier_errors: numberValue(summary['verifier_errors']),
      false_completes: falseCompletes,
    },
    failure_counts: failureCounts,
    trials,
    selected_failure: selectedFailure,
    work_packet: buildWorkPacket(selectedFailure, runDir, passed, trialCount, jobInterrupted),
  };
}

export function formatBenchmarkRunAnalysisHuman(analysis: BenchmarkRunAnalysis): string {
  const selected = analysis.selected_failure;
  const failureLines = Object.entries(analysis.failure_counts)
    .filter(([, count]) => count > 0)
    .map(([failureClass, count]) => `- ${failureClass}: ${count}`);
  return [
    'Babel Benchmark Analysis',
    `Run: ${analysis.run_dir}`,
    `Score: ${analysis.summary.passed}/${analysis.summary.trials}`,
    `Countable: ${analysis.countable ? 'yes' : 'no'}`,
    `Selected failure: ${selected ? `${selected.task_name} (${selected.failure_class})` : '(none)'}`,
    selected?.partial_pass
      ? `Partial verifier: ${selected.partial_pass.passed}/${selected.partial_pass.total} passed; blocking ${selected.partial_pass.blocking_category ?? 'unknown'}`
      : 'Partial verifier: none',
    '',
    'Failure classes:',
    ...(failureLines.length > 0 ? failureLines : ['- none']),
    '',
    'Work packet:',
    `Headline: ${analysis.work_packet.headline}`,
    `Likely owner: ${analysis.work_packet.likely_owner}`,
    'Evidence:',
    ...analysis.work_packet.evidence_paths.map((path) => `- ${path}`),
    'Suggested commands:',
    ...analysis.work_packet.suggested_commands.map((command) => `- ${command}`),
    'Notes:',
    ...analysis.work_packet.notes.map((note) => `- ${note}`),
  ].join('\n');
}

function analyzeTrial(
  row: Record<string, unknown>,
  runDir: string,
  jobInterrupted: boolean,
): BenchmarkTrialAnalysis {
  const rowTrialDir = stringValue(row['trial_dir']);
  const rowTrialName = stringValue(row['trial_name']);
  const trialDir = rowTrialDir
    ? resolve(rowTrialDir)
    : rowTrialName
      ? join(runDir, rowTrialName)
      : null;
  const trialResult = trialDir ? readJsonRecordOrNull(join(trialDir, 'result.json')) : null;
  const merged = mergeTrialRow(row, trialResult);
  const taskName = stringValue(merged['task_name']) ?? stringValue(merged['task']) ?? 'unknown-task';
  const trialName = stringValue(merged['trial_name']) ?? rowTrialName ?? taskName;
  const babel = asRecord(merged['babel']);
  const verifier = asRecord(merged['verifier']);
  const setup = trialDir ? readJsonRecordOrNull(join(trialDir, 'app-setup.json')) : null;
  const reward = numberValue(merged['reward']) ?? numberValue(verifier['reward']);
  const passed = merged['passed'] === true || verifier['passed'] === true || reward === 1;
  const babelStatus = stringValue(merged['babel_status']) ?? stringValue(babel['status']);
  const babelResultStatus = stringValue(merged['babel_result_status']) ?? stringValue(babel['result_status']);
  const verifierStatus = stringValue(merged['verifier_status']) ?? stringValue(verifier['status']) ?? numberValue(verifier['status']);
  const verifierExitCode = numberValue(verifier['exit_code']);
  const babelRunDir = stringValue(merged['babel_run_dir']) ?? stringValue(babel['run_dir']);
  const keyArtifacts = collectArtifacts(trialDir, babelRunDir);
  const riskReport = classifyBenchmarkTaskRisk(`Terminal-Bench 2 task: ${taskName}`);
  const executorTrace = readExecutorGateTrace(babelRunDir);
  const failureFingerprint = extractFailureFingerprint(executorTrace, trialDir);
  const partialPass = extractPartialPassSummary(trialDir);
  const repairLoop = extractRepairLoop(executorTrace);
  const failureClass = classifyTrial({
    passed,
    jobInterrupted,
    setup,
    babelStatus,
    babelResultStatus,
    babelTimedOut: boolValue(babel['timed_out']),
    babelExitCode: numberValue(babel['exit_code']),
    verifierStatus,
    verifierExitCode,
    verifierTimedOut: boolValue(verifier['timed_out']),
    trialResultMissing: trialDir !== null && trialResult === null,
  });
  return {
    task_name: taskName,
    trial_name: trialName,
    trial_dir: trialDir,
    passed,
    reward,
    failure_class: failureClass,
    babel_status: babelStatus,
    babel_result_status: babelResultStatus,
    babel_run_dir: babelRunDir,
    verifier_status: verifierStatus,
    verifier_exit_code: verifierExitCode,
    key_artifacts: keyArtifacts,
    notes: trialNotes(failureClass, babelStatus, babelResultStatus, verifierStatus, repairLoop, failureFingerprint),
    risk_labels: riskReport.labels.map(label => label.label),
    failure_fingerprint: failureFingerprint,
    partial_pass: partialPass,
    repair_loop: repairLoop,
  };
}

function classifyTrial(input: {
  passed: boolean;
  jobInterrupted: boolean;
  setup: Record<string, unknown> | null;
  babelStatus: string | null;
  babelResultStatus: string | null;
  babelTimedOut: boolean;
  babelExitCode: number | null;
  verifierStatus: string | number | null;
  verifierExitCode: number | null;
  verifierTimedOut: boolean;
  trialResultMissing: boolean;
}): BenchmarkFailureClass {
  if (input.passed) return 'passed';
  if (input.jobInterrupted) return 'interrupted';
  if (input.trialResultMissing) return 'missing_artifact';
  if (stringValue(input.setup?.['status']) === 'failed') return 'environment_setup_failed';
  if (input.babelTimedOut || lower(input.babelStatus) === 'timeout') return 'agent_timeout';
  if (lower(input.babelResultStatus) === 'complete' || lower(input.babelStatus) === 'complete') {
    return 'false_complete';
  }
  if (input.babelExitCode !== null && input.babelExitCode !== 0) return 'agent_failed';
  if (lower(input.babelStatus) === 'failed') return 'agent_failed';
  if (input.verifierTimedOut) return 'verifier_timeout';
  if (typeof input.verifierStatus === 'number' && input.verifierStatus !== 0) return 'verifier_failed';
  if (typeof input.verifierStatus === 'string') {
    const status = lower(input.verifierStatus);
    if (status === 'timeout') return 'verifier_timeout';
    if (status === 'error' || status === 'failed') return 'verifier_error';
  }
  if (input.verifierExitCode !== null && input.verifierExitCode !== 0) return 'verifier_failed';
  return 'unknown';
}

function buildWorkPacket(
  selected: BenchmarkTrialAnalysis | null,
  runDir: string,
  passed: number,
  trials: number,
  interrupted: boolean,
): BenchmarkRunAnalysis['work_packet'] {
  if (!selected && interrupted) {
    return {
      headline: 'Benchmark run was interrupted before a repairable trial completed.',
      focus_task: null,
      likely_owner: 'Loop budget / deadline controller',
      risk_labels: [],
      failure_fingerprint: null,
      partial_pass: null,
      best_candidate_checkpoint: null,
      best_candidate: null,
      evidence_paths: [join(runDir, 'result.json')],
      suggested_commands: [
        'node .\\dist\\index.js benchmark loop --json',
      ],
      notes: ['This run is non-countable; rerun with enough wall-clock budget before selecting a source fix.'],
    };
  }
  if (!selected) {
    return {
      headline: `Latest run has no selected failing trial (${passed}/${trials}).`,
      focus_task: null,
      likely_owner: 'none',
      risk_labels: [],
      failure_fingerprint: null,
      partial_pass: null,
      best_candidate_checkpoint: null,
      best_candidate: null,
      evidence_paths: [join(runDir, 'result.json')],
      suggested_commands: [
        'node .\\dist\\index.js benchmark loop --json',
      ],
      notes: ['No repair packet was generated because every visible trial passed.'],
    };
  }
  const owner = likelyOwner(selected.failure_class, selected);
  const bestCandidate = selectBestCandidateCheckpoint(selected.babel_run_dir, selected.risk_labels);
  return {
    headline: `Fix ${selected.task_name}: ${selected.failure_class}.`,
    focus_task: selected.task_name,
    likely_owner: owner,
    risk_labels: selected.risk_labels,
    failure_fingerprint: selected.failure_fingerprint,
    partial_pass: selected.partial_pass,
    best_candidate_checkpoint: bestCandidate?.checkpoint_id ?? null,
    best_candidate: bestCandidate,
    evidence_paths: selected.key_artifacts.length > 0 ? selected.key_artifacts : [join(runDir, 'result.json')],
    suggested_commands: [
      'npm run typecheck',
      'npm run test:unit',
      'npm run build',
      `node .\\dist\\index.js benchmark loop --target-task ${selected.task_name} --json`,
    ],
    notes: [
      `Score before fix: ${passed}/${trials}.`,
      ...(selected.risk_labels.length > 0 ? [`Risk labels: ${selected.risk_labels.join(', ')}.`] : []),
      ...(selected.failure_fingerprint ? [`Failure fingerprint: ${selected.failure_fingerprint}.`] : []),
      ...(selected.partial_pass ? [
        `Partial verifier pass: ${selected.partial_pass.passed}/${selected.partial_pass.total} tests passed; blocking category ${selected.partial_pass.blocking_category ?? 'unknown'}.`,
      ] : []),
      ...(bestCandidate ? [`Best candidate checkpoint: ${bestCandidate.checkpoint_id} (${bestCandidate.reason}).`] : []),
      ...buildBestCandidateRegressionNotes(selected.babel_run_dir, bestCandidate),
      ...selected.notes,
    ],
  };
}

function likelyOwner(failureClass: BenchmarkFailureClass, selected?: BenchmarkTrialAnalysis): string {
  if (selected?.repair_loop.repeated || selected?.repair_loop.status === 'strategy_exhausted') {
    return 'Babel executor repair convergence';
  }
  if (selected?.risk_labels.includes('numerical_performance')) {
    return 'Babel planner / QA technical strategy';
  }
  if (selected?.risk_labels.includes('git_stateful_merge')) {
    return 'Babel planner / benchmark Git workflow';
  }
  if (selected?.risk_labels.includes('artifact_generation')) {
    return 'Benchmark artifact verifier / executor postconditions';
  }
  switch (failureClass) {
    case 'agent_timeout':
    case 'agent_failed':
    case 'false_complete':
      return 'Babel executor / completion guards';
    case 'verifier_failed':
    case 'verifier_timeout':
    case 'verifier_error':
      return 'Benchmark verification strategy / artifact postconditions';
    case 'environment_setup_failed':
      return 'Terminal-Bench runner / Docker setup';
    case 'interrupted':
      return 'Loop budget / deadline controller';
    case 'missing_artifact':
      return 'Benchmark artifact writer';
    case 'passed':
    case 'unknown':
      return 'manual triage';
  }
}

function trialNotes(
  failureClass: BenchmarkFailureClass,
  babelStatus: string | null,
  babelResultStatus: string | null,
  verifierStatus: string | number | null,
  repairLoop: BenchmarkTrialAnalysis['repair_loop'],
  failureFingerprint: string | null,
): string[] {
  const notes = [
    `Failure class: ${failureClass}.`,
    `Babel status: ${babelStatus ?? '(unknown)'}.`,
    `Babel result status: ${babelResultStatus ?? '(unknown)'}.`,
    `Verifier status: ${verifierStatus ?? '(unknown)'}.`,
  ];
  if (failureClass === 'false_complete') {
    notes.push('Babel reported completion but verifier reward was not 1; tighten artifact postconditions before COMPLETE.');
  }
  if (failureClass === 'agent_timeout') {
    notes.push('The agent exceeded its task budget; inspect executor repair loops and bounded retry behavior.');
  }
  if (repairLoop.status) {
    notes.push(`Repair loop status: ${repairLoop.status} (${repairLoop.failure_count ?? 0} failure(s)).`);
  }
  if (repairLoop.repeated) {
    notes.push('Repeated recoverable failure fingerprint detected; fix repair convergence before another broad run.');
  }
  if (failureFingerprint) {
    notes.push(`Failure fingerprint: ${failureFingerprint}.`);
  }
  return notes;
}

function collectArtifacts(trialDir: string | null, babelRunDir: string | null): string[] {
  const artifacts: string[] = [];
  if (trialDir) {
    for (const relative of [
      'result.json',
      'babel-result.json',
      'babel-stdout.txt',
      'babel-stderr.txt',
      join('logs', 'verifier', 'test-stdout.txt'),
      join('logs', 'verifier', 'test-stderr.txt'),
      join('logs', 'verifier', 'ctrf.json'),
    ]) {
      const artifact = join(trialDir, relative);
      if (existsSync(artifact)) artifacts.push(artifact);
    }
  }
  if (babelRunDir && existsSync(babelRunDir)) {
    artifacts.push(babelRunDir);
    for (const relative of [
      '04_execution_report.json',
      '09_executor_gate_trace.json',
      '10_session_context.json',
    ]) {
      const artifact = join(babelRunDir, relative);
      if (existsSync(artifact)) artifacts.push(artifact);
    }
  }
  return artifacts;
}

function readExecutorGateTrace(babelRunDir: string | null): Record<string, unknown> | null {
  if (!babelRunDir) return null;
  return readJsonRecordOrNull(join(babelRunDir, '09_executor_gate_trace.json'));
}

function extractRepairLoop(trace: Record<string, unknown> | null): BenchmarkTrialAnalysis['repair_loop'] {
  const repairState = asRecord(trace?.['repair_state']);
  const status = stringValue(repairState['status']);
  const failureCount = numberValue(repairState['failure_count']);
  const failures = Array.isArray(repairState['failures']) ? repairState['failures'].filter(isRecord) : [];
  const repeated = status === 'same_failure_repeated' ||
    status === 'strategy_exhausted' ||
    failures.some(failure => (numberValue(failure['repeatedCount']) ?? 0) >= 2);
  return {
    status,
    failure_count: failureCount,
    repeated,
  };
}

function extractFailureFingerprint(
  trace: Record<string, unknown> | null,
  trialDir: string | null,
): string | null {
  const repairState = asRecord(trace?.['repair_state']);
  const last = asRecord(repairState['last_fingerprint']);
  const command = stringValue(last['command']);
  const stderr = stringValue(last['stderrSummary']);
  const stdout = stringValue(last['stdoutSummary']);
  const testId = stringValue(last['testId']);
  if (command || stderr || stdout || testId) {
    return [
      command ? `command=${command}` : null,
      testId ? `test=${testId}` : null,
      stderr ? `stderr=${stderr}` : null,
      !stderr && stdout ? `stdout=${stdout}` : null,
    ].filter(Boolean).join(' ');
  }

  if (!trialDir) return null;
  const ctrf = readJsonRecordOrNull(join(trialDir, 'logs', 'verifier', 'ctrf.json'));
  const tests = Array.isArray(asRecord(ctrf?.['results'])['tests'])
    ? asRecord(ctrf?.['results'])['tests'] as unknown[]
    : [];
  const firstFailed = tests.filter(isRecord).find(test => stringValue(test['status']) === 'failed');
  if (!firstFailed) return null;
  const name = stringValue(firstFailed['name']);
  const traceText = stringValue(firstFailed['trace']) ?? stringValue(firstFailed['message']);
  return [
    name ? `test=${name}` : null,
    traceText ? `trace=${traceText.slice(0, 240).replace(/\s+/g, ' ')}` : null,
  ].filter(Boolean).join(' ');
}

function extractPartialPassSummary(trialDir: string | null): BenchmarkPartialPassSummary | null {
  if (!trialDir) return null;
  const ctrf = readJsonRecordOrNull(join(trialDir, 'logs', 'verifier', 'ctrf.json'));
  const rawTests = asRecord(ctrf?.['results'])['tests'];
  const tests = Array.isArray(rawTests)
    ? rawTests.filter(isRecord)
    : [];
  if (tests.length === 0) return null;

  let passed = 0;
  let failed = 0;
  const categoryCounts = new Map<string, number>();
  const failedTests: BenchmarkFailedTestSummary[] = [];
  for (const test of tests) {
    const rawStatus = stringValue(test['status']) ?? 'unknown';
    const normalizedStatus = rawStatus.toLowerCase();
    if (normalizedStatus === 'passed' || normalizedStatus === 'pass') {
      passed += 1;
      continue;
    }
    if (normalizedStatus === 'failed' || normalizedStatus === 'fail' || normalizedStatus === 'error') {
      failed += 1;
      const name = stringValue(test['name']) ?? stringValue(test['fullName']) ?? 'unnamed verifier test';
      const message = stringValue(test['message']);
      const trace = stringValue(test['trace']);
      const category = categorizeVerifierFailure([name, message, trace].filter(Boolean).join('\n'));
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      if (failedTests.length < 8) {
        failedTests.push({
          name,
          status: rawStatus,
          category,
          message,
          trace_excerpt: trace ? trace.slice(0, 500).replace(/\s+/g, ' ') : null,
        });
      }
      continue;
    }

    categoryCounts.set('unknown_status', (categoryCounts.get('unknown_status') ?? 0) + 1);
  }

  const failureCategories = Object.fromEntries(
    [...categoryCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
  const blockingCategory = Object.keys(failureCategories)[0] ?? null;
  return {
    total: tests.length,
    passed,
    failed,
    pass_rate: tests.length > 0 ? passed / tests.length : null,
    failed_tests: failedTests,
    failure_categories: failureCategories,
    blocking_category: blockingCategory,
  };
}

function categorizeVerifierFailure(text: string): string {
  const normalized = text.toLowerCase();
  if (
    /filenotfounderror|no such file|does not exist|missing|required output|output_data|plan_b[12]|not found/.test(normalized)
  ) {
    return 'missing_output_artifact';
  }
  if (/request_id|coverage|duplicate|all requests|covered/.test(normalized)) {
    return 'coverage';
  }
  if (/seq_align|heads_align|hidden_align|shape|schema|json decode|jsonl|malformed/.test(normalized)) {
    return 'shape_schema';
  }
  if (/cost|pad_ratio|latency|sequential_timecost|threshold|too slow|performance|runtime/.test(normalized)) {
    return 'performance_threshold';
  }
  if (/traceback|syntaxerror|typeerror|nameerror|importerror|exception/.test(normalized)) {
    return 'compile_or_runtime';
  }
  if (/assertionerror|assert /.test(normalized)) {
    return 'assertion';
  }
  return 'assertion';
}

function selectBestCandidateCheckpoint(
  babelRunDir: string | null,
  riskLabels: readonly BenchmarkRiskLabel[],
): BenchmarkCandidateCheckpoint | null {
  if (!babelRunDir) return null;
  const checkpointEntries = readCheckpointEntries(babelRunDir);
  const executionReport = readJsonRecordOrNull(join(babelRunDir, '04_execution_report.json'));
  const toolLog = Array.isArray(executionReport?.['tool_call_log'])
    ? executionReport['tool_call_log'].filter(isRecord)
    : [];
  const checkpointsById = new Map<string, Record<string, unknown>>();
  for (const entry of checkpointEntries) {
    const id = checkpointId(entry);
    if (id) checkpointsById.set(id, entry);
  }

  const candidates: Array<BenchmarkCandidateCheckpoint & { score: number }> = [];
  let lastRestorableCheckpoint: string | null = null;
  for (const entry of toolLog) {
    const tool = stringValue(entry['tool']);
    const step = numberValue(entry['step']);
    const checkpointIds = Array.isArray(entry['checkpoint_ids'])
      ? entry['checkpoint_ids'].map(stringValue).filter((value): value is string => value !== null)
      : [];
    if (tool === 'file_write' && numberValue(entry['exit_code']) === 0) {
      const restorableId = checkpointIds.find(id =>
        stringValue(checkpointsById.get(id)?.['restore_status']) !== 'metadata_only'
      );
      if (restorableId) lastRestorableCheckpoint = restorableId;
      continue;
    }
    if ((tool !== 'shell_exec' && tool !== 'test_run') || !lastRestorableCheckpoint) {
      continue;
    }

    const stdout = stringValue(entry['stdout']) ?? '';
    const stderr = stringValue(entry['stderr']) ?? '';
    const counts = inferVisibleTestCounts(stdout, stderr);
    const runtimeSeconds = inferRuntimeSeconds(stdout);
    const failureClasses = inferFailureClasses(stderr);
    const candidate: BenchmarkCandidateCheckpoint = {
      checkpoint_id: lastRestorableCheckpoint,
      step,
      command: stringValue(entry['target']),
      exit_code: numberValue(entry['exit_code']),
      total_tests: counts.total,
      passed_tests: counts.passed,
      failed_tests: counts.failed,
      failure_classes: failureClasses,
      runtime_seconds: runtimeSeconds,
      reason: '',
    };
    candidates.push({
      ...candidate,
      score: scoreCandidate(candidate, riskLabels),
    });
  }

  if (candidates.length === 0) {
    const fallback = checkpointEntries
      .filter(entry => stringValue(entry['restore_status']) !== 'metadata_only')
      .map(entry => checkpointId(entry))
      .filter((value): value is string => value !== null)
      .at(-1);
    return fallback
      ? {
          checkpoint_id: fallback,
          step: null,
          command: null,
          exit_code: null,
          total_tests: null,
          passed_tests: null,
          failed_tests: null,
          failure_classes: [],
          runtime_seconds: null,
          reason: 'latest restorable checkpoint; no local verifier/test evidence was available',
        }
      : null;
  }

  const best = candidates.reduce((currentBest, candidate) =>
    candidate.score > currentBest.score ? candidate : currentBest
  );
  return {
    checkpoint_id: best.checkpoint_id,
    step: best.step,
    command: best.command,
    exit_code: best.exit_code,
    total_tests: best.total_tests,
    passed_tests: best.passed_tests,
    failed_tests: best.failed_tests,
    failure_classes: best.failure_classes,
    runtime_seconds: best.runtime_seconds,
    reason: describeBestCandidate(best, riskLabels),
  };
}

function buildBestCandidateRegressionNotes(
  babelRunDir: string | null,
  bestCandidate: BenchmarkCandidateCheckpoint | null,
): string[] {
  if (!babelRunDir || !bestCandidate) return [];
  const latestRestorable = readCheckpointEntries(babelRunDir)
    .filter(entry => stringValue(entry['restore_status']) !== 'metadata_only')
    .map(entry => checkpointId(entry))
    .filter((value): value is string => value !== null)
    .at(-1);
  if (!latestRestorable || latestRestorable === bestCandidate.checkpoint_id) {
    return [];
  }
  return [
    `Latest restorable checkpoint is ${latestRestorable}; restore ${bestCandidate.checkpoint_id} first if the latest candidate regressed.`,
  ];
}

function readCheckpointEntries(babelRunDir: string): Record<string, unknown>[] {
  const checkpoints = readJsonRecordOrNull(join(babelRunDir, 'checkpoints', 'checkpoints.json'));
  return Array.isArray(checkpoints?.['checkpoints'])
    ? checkpoints['checkpoints'].filter(isRecord)
    : Array.isArray(checkpoints?.['entries'])
      ? checkpoints['entries'].filter(isRecord)
      : [];
}

function checkpointId(entry: Record<string, unknown>): string | null {
  return stringValue(entry['id']) ?? stringValue(entry['checkpoint_id']) ?? stringValue(entry['path']);
}

function inferVisibleTestCounts(stdout: string, stderr: string): {
  total: number | null;
  passed: number | null;
  failed: number | null;
} {
  const text = `${stdout}\n${stderr}`;
  const passed = sumMatches(text, /(\d+)\s+passed\b/gi);
  const failed = sumMatches(text, /(\d+)\s+(?:failed|failures?|errors?)\b/gi);
  if (passed > 0 || failed > 0) {
    return {
      total: passed + failed,
      passed,
      failed,
    };
  }

  const completedSizeChecks = new Set<string>();
  for (const match of stdout.matchAll(/Median time for\s+(\d+x\d+):\s+([0-9.]+)\s+seconds/gi)) {
    completedSizeChecks.add(match[1]!);
  }
  if (completedSizeChecks.size > 0) {
    const failedCount = stderr.trim().length > 0 ? 1 : 0;
    return {
      total: completedSizeChecks.size + failedCount,
      passed: completedSizeChecks.size,
      failed: failedCount,
    };
  }

  return {
    total: null,
    passed: null,
    failed: null,
  };
}

function sumMatches(text: string, pattern: RegExp): number {
  let total = 0;
  for (const match of text.matchAll(pattern)) {
    total += Number(match[1] ?? 0);
  }
  return total;
}

function inferRuntimeSeconds(stdout: string): number | null {
  const values: number[] = [];
  for (const match of stdout.matchAll(/Median time for\s+\d+x\d+:\s+([0-9.]+)\s+seconds/gi)) {
    values.push(Number(match[1]));
  }
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function inferFailureClasses(stderr: string): string[] {
  const labels = new Set<string>();
  if (/AssertionError/i.test(stderr)) labels.add('assertion');
  if (/Traceback|exception/i.test(stderr)) labels.add('exception');
  if (/timeout|timed out/i.test(stderr)) labels.add('timeout');
  if (/no such file|not found|missing/i.test(stderr)) labels.add('missing_artifact');
  if (/syntaxerror|compile/i.test(stderr)) labels.add('syntax_or_compile');
  if (labels.size === 0 && stderr.trim().length > 0) labels.add('stderr_failure');
  return [...labels];
}

function scoreCandidate(
  candidate: BenchmarkCandidateCheckpoint,
  riskLabels: readonly BenchmarkRiskLabel[],
): number {
  let score = 0;
  if (candidate.exit_code === 0) score += 1_000_000;
  score += (candidate.passed_tests ?? 0) * 1_000;
  score -= (candidate.failed_tests ?? 0) * 100;
  score -= candidate.failure_classes.length * 25;
  if (riskLabels.includes('numerical_performance') && candidate.runtime_seconds !== null) {
    score -= candidate.runtime_seconds;
  }
  score -= (candidate.step ?? 0) * 0.001;
  return score;
}

function describeBestCandidate(
  candidate: BenchmarkCandidateCheckpoint,
  riskLabels: readonly BenchmarkRiskLabel[],
): string {
  if (candidate.exit_code === 0) {
    return 'local verifier/test command exited successfully';
  }
  if ((candidate.passed_tests ?? 0) > 0) {
    const runtime = riskLabels.includes('numerical_performance') && candidate.runtime_seconds !== null
      ? ` with ${candidate.runtime_seconds.toFixed(6)}s visible runtime`
      : '';
    return `${candidate.passed_tests}/${candidate.total_tests ?? '?'} visible checks passed${runtime}`;
  }
  if (candidate.failure_classes.length > 0) {
    return `fewest/least severe visible failure classes: ${candidate.failure_classes.join(', ')}`;
  }
  return 'highest-ranked checkpoint by local execution evidence';
}

function resolveResultPath(input: string): string {
  const resolved = resolve(input);
  return basename(resolved) === 'result.json' ? resolved : join(resolved, 'result.json');
}

function resultRows(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const rows = Array.isArray(parsed['results'])
    ? parsed['results']
    : Array.isArray(parsed['trials'])
      ? parsed['trials']
      : [];
  return rows.filter(isRecord);
}

function mergeTrialRow(row: Record<string, unknown>, trialResult: Record<string, unknown> | null): Record<string, unknown> {
  if (!trialResult) return row;
  return {
    ...trialResult,
    ...row,
    babel: {
      ...asRecord(trialResult['babel']),
      ...pickDefined({
        status: row['babel_status'],
        result_status: row['babel_result_status'],
        run_dir: row['babel_run_dir'],
      }),
    },
    verifier: {
      ...asRecord(trialResult['verifier']),
      ...pickDefined({
        status: row['verifier_status'],
        reward: row['reward'],
        passed: row['passed'],
      }),
    },
  };
}

function readJsonRecord(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object at ${path}`);
  }
  return parsed;
}

function readJsonRecordOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return readJsonRecord(path);
  } catch {
    return null;
  }
}

function emptyFailureCounts(): Record<BenchmarkFailureClass, number> {
  return {
    passed: 0,
    agent_timeout: 0,
    agent_failed: 0,
    false_complete: 0,
    verifier_failed: 0,
    verifier_timeout: 0,
    verifier_error: 0,
    environment_setup_failed: 0,
    interrupted: 0,
    missing_artifact: 0,
    unknown: 0,
  };
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

function boolValue(value: unknown): boolean {
  return value === true;
}

function lower(value: string | null): string | null {
  return value ? value.toLowerCase() : null;
}

function pickDefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null));
}
