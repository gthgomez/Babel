import {
  classifyBenchmarkTaskRisk,
  extractBenchmarkTaskName,
  type BenchmarkRiskLabel,
} from './benchmarkTaskRisk.js';

export interface BenchmarkVerifierSpec {
  readonly taskName: string;
  readonly riskLabels: BenchmarkRiskLabel[];
  readonly requiredChecks: string[];
  readonly suggestedHelperName: string;
  readonly command: string;
  readonly successCriteria: string[];
  readonly failureFingerprintHints: string[];
}

const TASK_SPECS: Record<string, Omit<BenchmarkVerifierSpec, 'taskName' | 'riskLabels'>> = {
  'largest-eigenval': {
    requiredChecks: [
      'seeded non-symmetric real matrices up to 10x10',
      'A @ eigenvec is close to eigenval * eigenvec',
      'absolute dominant eigenvalue matches reference magnitude',
      'candidate median runtime is lower than reference median runtime on the same matrices',
    ],
    suggestedHelperName: 'verify_eigen_candidate.py',
    command: 'python verify_eigen_candidate.py',
    successCriteria: [
      'all correctness residual checks pass',
      'dominant magnitude checks pass',
      'median candidate runtime is below reference runtime',
    ],
    failureFingerprintHints: [
      'failed test id or matrix size',
      'absolute/relative residual',
      'candidate/ref timing ratio',
    ],
  },
  'write-compressor': {
    requiredChecks: [
      'data.comp exists',
      'data.comp is at most 2500 bytes',
      'provided decompressor emits bytes exactly equal to data.txt',
    ],
    suggestedHelperName: 'verify_compressor_roundtrip.py',
    command: 'python verify_compressor_roundtrip.py',
    successCriteria: [
      'data.comp size <= 2500',
      'decompressed output byte-for-byte equals data.txt',
    ],
    failureFingerprintHints: [
      'compressed size',
      'first differing byte or diff summary',
      'decompressor exit code',
    ],
  },
  'pytorch-model-cli': {
    requiredChecks: [
      'cli_tool exists and is executable',
      'weights.json exists',
      'prediction.txt exists',
      './cli_tool weights.json image.png prints only a digit',
      'prediction.txt contains the same digit',
    ],
    suggestedHelperName: 'verify_cli_tool.py',
    command: 'python verify_cli_tool.py',
    successCriteria: [
      'cli_tool exits 0',
      'stdout matches /^[0-9]$/',
      'prediction.txt matches stdout',
    ],
    failureFingerprintHints: ['build error', 'cli exit code', 'stdout/stderr digit mismatch'],
  },
  'merge-diff-arc-agi-task': {
    requiredChecks: [
      'repo is a Git repository',
      'branch1 and branch2 exist',
      'branch2 has been merged into branch1',
      'repo/algo.py exists',
      'algo.py examples match examples.json',
    ],
    suggestedHelperName: 'verify_merge_arc.py',
    command: 'python verify_merge_arc.py',
    successCriteria: [
      'git branch output includes branch1 and branch2',
      'merge status is clean',
      'visible examples all pass',
    ],
    failureFingerprintHints: [
      'missing branch',
      'merge conflict state',
      'first failing ARC example id',
    ],
  },
  'break-filter-js-from-html': {
    requiredChecks: [
      'filter.py was inspected before payload selection',
      'out.html exists',
      'visible filter runs against out.html',
      'custom executable check proves filtered output satisfies bypass postcondition',
    ],
    suggestedHelperName: 'verify_filter_bypass.py',
    command: 'python verify_filter_bypass.py',
    successCriteria: ['filter exits 0', 'filtered output preserves the required bypass trigger'],
    failureFingerprintHints: [
      'payload family stripped by sanitizer',
      'missing alert/bypass marker',
      'custom verifier assertion',
    ],
  },
  'log-summary-date-ranges': {
    requiredChecks: [
      'summary.csv exists',
      'header is exactly period,severity,count',
      'all requested period labels exist in exact order',
      'counts are derived from visible logs',
    ],
    suggestedHelperName: 'verify_summary_schema.py',
    command: 'python verify_summary_schema.py',
    successCriteria: [
      'schema matches exactly',
      'all required rows are present',
      'counts are nonnegative integers',
    ],
    failureFingerprintHints: ['missing period label', 'wrong header', 'count mismatch'],
  },
  'llm-inference-batching-scheduler': {
    requiredChecks: [
      'task_file/output_data/plan_b1.jsonl exists',
      'task_file/output_data/plan_b2.jsonl exists',
      'every input request_id appears exactly once in the matching output plan',
      'each output record has request_id, batch_id, and shape',
      'shape seq_align is 64-token aligned and covers the prompt length',
      'total unique shapes across both buckets is at most 8',
      'cost_model or visible pytest verifier confirms cost and latency thresholds',
    ],
    suggestedHelperName: 'verify_llm_batching_plan.py',
    command: 'python verify_llm_batching_plan.py',
    successCriteria: [
      'both plan_b1.jsonl and plan_b2.jsonl exist',
      'coverage and schema checks pass for both buckets',
      'cost_model/pytest exits 0 after final plan generation',
    ],
    failureFingerprintHints: [
      'missing plan_b1.jsonl or plan_b2.jsonl',
      'usage message from helper invocation',
      'first missing or duplicate request_id',
      'cost/padding/latency threshold mismatch',
    ],
  },
};

export function buildBenchmarkVerifierSpec(rawTask: string): BenchmarkVerifierSpec | null {
  const taskName = extractBenchmarkTaskName(rawTask);
  const risk = classifyBenchmarkTaskRisk(rawTask);
  const riskLabels = risk.labels.map((label) => label.label);
  if (taskName && TASK_SPECS[taskName]) {
    return {
      taskName,
      riskLabels,
      ...TASK_SPECS[taskName],
    };
  }
  if (!risk.is_benchmark_task) {
    return null;
  }
  return {
    taskName: taskName ?? 'external-benchmark-task',
    riskLabels,
    requiredChecks: [
      'requested artifacts exist',
      'at least one local verifier or postcondition command exits 0 after final mutation',
    ],
    suggestedHelperName: 'verify_benchmark_postcondition.py',
    command: 'python verify_benchmark_postcondition.py',
    successCriteria: [
      'local postcondition exits 0',
      'requested artifact contract is visibly satisfied',
    ],
    failureFingerprintHints: [
      'missing artifact',
      'failed verifier command',
      'stderr assertion summary',
    ],
  };
}

export function buildBenchmarkVerifierPromptLines(rawTask: string): string[] {
  const spec = buildBenchmarkVerifierSpec(rawTask);
  if (!spec) {
    return [];
  }
  return [
    'Benchmark local verifier spec:',
    `  - Task: ${spec.taskName}`,
    `  - Risk labels: ${spec.riskLabels.length > 0 ? spec.riskLabels.join(', ') : '(none)'}`,
    `  - Suggested helper: ${spec.suggestedHelperName}`,
    `  - Suggested command: ${spec.command}`,
    `  - Required checks: ${spec.requiredChecks.join('; ')}`,
    `  - Success criteria: ${spec.successCriteria.join('; ')}`,
    `  - Failure fingerprint hints: ${spec.failureFingerprintHints.join('; ')}`,
  ];
}
