import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BABEL_ROOT } from '../cli/constants.js';
import type { BenchmarkRiskLabel } from '../stages/benchmarkTaskRisk.js';
import {
  analyzeTerminalBenchRun,
  type BenchmarkCandidateCheckpoint,
  type BenchmarkPartialPassSummary,
  type BenchmarkRunAnalysis,
  type BenchmarkTrialAnalysis,
} from './benchmarkAnalysis.js';

export interface BenchmarkRepairStrategy {
  mode: 'partial_repair' | 'rerun_baseline' | 'no_failure';
  goal: string;
  restore_first: string | null;
  target_artifacts: string[];
  stop_conditions: string[];
  steps: string[];
}

export interface BenchmarkRepairReport {
  schema_version: 1;
  report_type: 'babel_benchmark_repair_plan';
  generated_at: string;
  run_dir: string;
  result_path: string;
  task_name: string | null;
  trial_dir: string | null;
  babel_run_dir: string | null;
  baseline_score: {
    passed: number;
    trials: number;
    mean_reward: number | null;
  };
  failure_class: string | null;
  failure_fingerprint: string | null;
  risk_labels: BenchmarkRiskLabel[];
  likely_owner: string;
  partial_pass: BenchmarkPartialPassSummary | null;
  best_candidate_checkpoint: string | null;
  best_candidate: BenchmarkCandidateCheckpoint | null;
  repair_strategy: BenchmarkRepairStrategy;
  repair_prompt: string;
  artifacts: {
    report_path: string;
    prompt_path: string;
  };
  commands: {
    restore_checkpoint: string | null;
    local_gate: string;
    analyze: string;
    targeted_benchmark: string | null;
    full_benchmark: string;
  };
}

export interface BuildBenchmarkRepairReportOptions {
  run: string;
  outputDir?: string;
  benchmarksRoot?: string;
  suite?: string;
  maxTasks?: number;
  now?: Date;
}

export function buildBenchmarkRepairReport(
  options: BuildBenchmarkRepairReportOptions,
): BenchmarkRepairReport {
  const now = options.now ?? new Date();
  const suite = options.suite ?? 'pilot10';
  const maxTasks = positiveInt(options.maxTasks, 10);
  const outputDir = resolve(options.outputDir ?? join(BABEL_ROOT, 'runs', 'benchmarks', 'repairs'));
  mkdirSync(outputDir, { recursive: true });

  const analysis = analyzeTerminalBenchRun({ run: options.run, now });
  const selected = analysis.selected_failure;
  const strategy = buildRepairStrategy(selected, analysis);
  const commands = buildRepairCommands({
    analysis,
    selected,
    strategy,
    suite,
    maxTasks,
    ...(options.benchmarksRoot ? { benchmarksRoot: options.benchmarksRoot } : {}),
    now,
  });
  const slug = sanitizeSlug(selected?.task_name ?? analysis.job_name);
  const baseName = `benchmark-repair-${formatTimestampForFile(now)}-${slug}`;
  const reportPath = join(outputDir, `${baseName}.json`);
  const promptPath = join(outputDir, `${baseName}.prompt.md`);
  const repairPrompt = buildRepairPrompt({ analysis, selected, strategy, commands });

  const report: BenchmarkRepairReport = {
    schema_version: 1,
    report_type: 'babel_benchmark_repair_plan',
    generated_at: now.toISOString(),
    run_dir: analysis.run_dir,
    result_path: analysis.result_path,
    task_name: selected?.task_name ?? null,
    trial_dir: selected?.trial_dir ?? null,
    babel_run_dir: selected?.babel_run_dir ?? null,
    baseline_score: {
      passed: analysis.summary.passed,
      trials: analysis.summary.trials,
      mean_reward: analysis.summary.mean_reward,
    },
    failure_class: selected?.failure_class ?? null,
    failure_fingerprint: selected?.failure_fingerprint ?? null,
    risk_labels: selected?.risk_labels ?? [],
    likely_owner: analysis.work_packet.likely_owner,
    partial_pass: selected?.partial_pass ?? null,
    best_candidate_checkpoint: analysis.work_packet.best_candidate_checkpoint,
    best_candidate: analysis.work_packet.best_candidate,
    repair_strategy: strategy,
    repair_prompt: repairPrompt,
    artifacts: {
      report_path: reportPath,
      prompt_path: promptPath,
    },
    commands,
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(promptPath, `${repairPrompt}\n`, 'utf8');
  return report;
}

export function formatBenchmarkRepairHuman(report: BenchmarkRepairReport): string {
  return [
    'Babel Benchmark Repair Plan',
    `Task: ${report.task_name ?? '(none)'}`,
    `Score: ${report.baseline_score.passed}/${report.baseline_score.trials}`,
    `Failure: ${report.failure_class ?? '(none)'}`,
    `Owner: ${report.likely_owner}`,
    report.partial_pass
      ? `Partial verifier: ${report.partial_pass.passed}/${report.partial_pass.total} passed; blocking ${report.partial_pass.blocking_category ?? 'unknown'}`
      : 'Partial verifier: none',
    `Best checkpoint: ${report.best_candidate_checkpoint ?? '(none)'}`,
    `Report: ${report.artifacts.report_path}`,
    `Prompt: ${report.artifacts.prompt_path}`,
    '',
    'Repair strategy:',
    `Goal: ${report.repair_strategy.goal}`,
    ...report.repair_strategy.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    'Commands:',
    ...(report.commands.restore_checkpoint
      ? [`- restore: ${report.commands.restore_checkpoint}`]
      : []),
    `- local gate: ${report.commands.local_gate}`,
    `- analyze: ${report.commands.analyze}`,
    ...(report.commands.targeted_benchmark
      ? [`- targeted: ${report.commands.targeted_benchmark}`]
      : []),
    `- full: ${report.commands.full_benchmark}`,
  ].join('\n');
}

function buildRepairStrategy(
  selected: BenchmarkTrialAnalysis | null,
  analysis: BenchmarkRunAnalysis,
): BenchmarkRepairStrategy {
  if (!selected) {
    return {
      mode: analysis.interrupted ? 'rerun_baseline' : 'no_failure',
      goal: analysis.interrupted
        ? 'Rerun the benchmark with enough wall-clock budget before selecting a code fix.'
        : 'No failing trial was visible in this run.',
      restore_first: null,
      target_artifacts: [],
      stop_conditions: ['Stop after producing a fresh countable Terminal-Bench result.'],
      steps: [
        'Run the local readiness gate.',
        'Run the full pilot or latest targeted command emitted by benchmark loop.',
        'Analyze the new result before changing source.',
      ],
    };
  }

  const checkpoint = analysis.work_packet.best_candidate_checkpoint;
  const partial = selected.partial_pass;
  const category = partial?.blocking_category ?? categoryFromFailureClass(selected.failure_class);
  const targetArtifacts = targetArtifactsFor(
    selected.task_name,
    category,
    selected.failure_fingerprint,
  );
  const taskSpecific = taskSpecificSteps(selected.task_name, category);
  return {
    mode: 'partial_repair',
    goal: `Convert ${selected.task_name} from ${selected.failure_class} to a targeted pass without regressing the local readiness gate.`,
    restore_first: checkpoint,
    target_artifacts: targetArtifacts,
    stop_conditions: [
      'Do not emit COMPLETE unless every required artifact named by the verifier exists and is non-empty.',
      'Do not run another full pilot until the targeted canary passes or the new failure fingerprint proves this source fix is exercised.',
      'Stop and re-analyze if the same failure fingerprint repeats after one focused repair.',
    ],
    steps: [
      ...(checkpoint
        ? [
            `Restore checkpoint ${checkpoint} first, then inspect only the delta required by the verifier failure.`,
          ]
        : [
            'Inspect the failing trial artifacts and identify the smallest repair surface before editing.',
          ]),
      'Use the partial verifier summary as the repair target; preserve any tests that already passed.',
      ...taskSpecific,
      'Run source readiness: npm run typecheck, focused unit tests, npm run build, npm run check:dist.',
      'Run the targeted Terminal-Bench canary for this task before any full pilot.',
      'Analyze the targeted result and either promote to full pilot or generate a new repair plan from the new fingerprint.',
    ],
  };
}

function taskSpecificSteps(taskName: string, category: string): string[] {
  if (taskName === 'llm-inference-batching-scheduler') {
    return [
      'Generate both /output_data/plan_b1.jsonl and /output_data/plan_b2.jsonl exactly; never substitute generic report names.',
      'If task JSONL inputs are large, write helper code that reads them at runtime instead of reconstructing rows from prompt text.',
      'Avoid no-argument helper invocations such as python task_file/scripts/optimized_packer.py; pass explicit input and output paths.',
      'Verify request coverage, shape alignment, and batching cost before COMPLETE.',
    ];
  }
  if (category === 'missing_output_artifact') {
    return [
      'Repair the exact output artifact path named in the verifier failure.',
      'Add an existence/non-empty postcondition for that artifact before COMPLETE.',
    ];
  }
  if (category === 'performance_threshold') {
    return [
      'Start from the best partial implementation and profile only the verifier bottleneck.',
      'Prefer algorithmic fixes over broad rewrites; keep visible passing cases intact.',
    ];
  }
  if (category === 'coverage') {
    return [
      'Preserve every existing request_id and add deterministic handling for the uncovered IDs.',
      'Check duplicate and missing IDs before running the targeted canary.',
    ];
  }
  if (category === 'shape_schema') {
    return [
      'Repair output schema and tensor/sequence shape alignment before optimizing.',
      'Validate generated JSON/JSONL with a parser before COMPLETE.',
    ];
  }
  if (category === 'compile_or_runtime') {
    return [
      'Fix the first runtime exception or compile error and rerun the exact failing command.',
      'Do not layer additional edits until the command reaches verifier assertions.',
    ];
  }
  return [
    'Patch the smallest source/artifact surface implied by the first failed verifier assertion.',
    'Rerun the exact failing command before advancing.',
  ];
}

function buildRepairPrompt(input: {
  analysis: BenchmarkRunAnalysis;
  selected: BenchmarkTrialAnalysis | null;
  strategy: BenchmarkRepairStrategy;
  commands: BenchmarkRepairReport['commands'];
}): string {
  const selected = input.selected;
  const partial = selected?.partial_pass;
  return [
    '# Babel Benchmark Repair Prompt',
    '',
    'You are managing a focused Babel CLI reliability repair. Do not restart from scratch.',
    'Use the benchmark evidence below, restore the best checkpoint when available, patch only the necessary artifacts/source, then run a targeted canary before any full pilot.',
    '',
    `Run: ${input.analysis.run_dir}`,
    `Score before fix: ${input.analysis.summary.passed}/${input.analysis.summary.trials}`,
    `Task: ${selected?.task_name ?? '(none)'}`,
    `Failure class: ${selected?.failure_class ?? '(none)'}`,
    `Failure fingerprint: ${selected?.failure_fingerprint ?? '(none)'}`,
    `Risk labels: ${(selected?.risk_labels ?? []).join(', ') || '(none)'}`,
    `Best checkpoint: ${input.analysis.work_packet.best_candidate_checkpoint ?? '(none)'}`,
    '',
    'Partial verifier:',
    partial
      ? `- ${partial.passed}/${partial.total} tests passed; blocking category ${partial.blocking_category ?? 'unknown'}`
      : '- none available',
    ...(partial
      ? partial.failed_tests.map(
          (test) => `- ${test.name}: ${test.category}${test.message ? ` - ${test.message}` : ''}`,
        )
      : []),
    '',
    'Target artifacts:',
    ...(input.strategy.target_artifacts.length > 0
      ? input.strategy.target_artifacts.map((artifact) => `- ${artifact}`)
      : ['- infer from verifier evidence']),
    '',
    'Required repair behavior:',
    ...input.strategy.steps.map((step) => `- ${step}`),
    '',
    'Stop conditions:',
    ...input.strategy.stop_conditions.map((condition) => `- ${condition}`),
    '',
    'Commands:',
    ...(input.commands.restore_checkpoint ? [`- ${input.commands.restore_checkpoint}`] : []),
    `- ${input.commands.local_gate}`,
    ...(input.commands.targeted_benchmark ? [`- ${input.commands.targeted_benchmark}`] : []),
    `- ${input.commands.analyze}`,
    '',
    'Completion rule: targeted pass first, then full pilot. If targeted fails with a new fingerprint, generate a new repair plan from that run.',
  ].join('\n');
}

function buildRepairCommands(input: {
  analysis: BenchmarkRunAnalysis;
  selected: BenchmarkTrialAnalysis | null;
  strategy: BenchmarkRepairStrategy;
  suite: string;
  maxTasks: number;
  benchmarksRoot?: string;
  now: Date;
}): BenchmarkRepairReport['commands'] {
  const workspaceRoot = dirname(BABEL_ROOT);
  const benchmarksRoot = resolve(input.benchmarksRoot ?? join(workspaceRoot, 'benchmarks'));
  const runnerPath = join(benchmarksRoot, 'scripts', 'run_babel_terminal_bench_pilot.mjs');
  const taskName = input.selected?.task_name ?? null;
  const base = [
    process.execPath,
    runnerPath,
    '--suite',
    input.suite,
    '--model-tier',
    'cheap',
    '--deepinfra-timeout-ms',
    '240000',
    '--waterfall-timeout-ms',
    '720000',
    '--continue-on-fail',
    'true',
  ];
  const stamp = formatTimestampForJob(input.now);
  const targeted = taskName
    ? [
        ...base,
        '--max-tasks',
        '1',
        '--tasks',
        taskName,
        '--job',
        `babel-repair-${input.suite}-${stamp}-${sanitizeSlug(taskName)}`,
      ]
        .map(quoteArg)
        .join(' ')
    : null;
  return {
    restore_checkpoint:
      input.strategy.restore_first && input.selected?.babel_run_dir
        ? [
            'node',
            '.\\dist\\index.js',
            'checkpoint',
            'restore',
            input.strategy.restore_first,
            '--run',
            input.selected.babel_run_dir,
            '--json',
          ]
            .map(quoteArg)
            .join(' ')
        : null,
    local_gate: 'node .\\dist\\index.js benchmark loop --readiness fast --json',
    analyze: `node .\\dist\\index.js benchmark analyze ${quoteArg(input.analysis.result_path)} --json`,
    targeted_benchmark: targeted,
    full_benchmark: [
      ...base,
      '--max-tasks',
      String(input.maxTasks),
      '--job',
      `babel-repair-${input.suite}-${stamp}-full`,
    ]
      .map(quoteArg)
      .join(' '),
  };
}

function targetArtifactsFor(
  taskName: string,
  category: string,
  fingerprint: string | null,
): string[] {
  if (taskName === 'llm-inference-batching-scheduler') {
    return ['/output_data/plan_b1.jsonl', '/output_data/plan_b2.jsonl'];
  }
  const artifacts = new Set<string>();
  for (const match of String(fingerprint ?? '').matchAll(
    /(?:\/output_data\/|output_data\/)[^\s'")]+/g,
  )) {
    artifacts.add(match[0]!.startsWith('/') ? match[0]! : `/${match[0]!}`);
  }
  if (category === 'missing_output_artifact' && artifacts.size === 0) {
    artifacts.add('exact output path named by verifier');
  }
  return [...artifacts];
}

function categoryFromFailureClass(failureClass: string): string {
  if (failureClass === 'missing_artifact' || failureClass === 'false_complete')
    return 'missing_output_artifact';
  if (failureClass === 'agent_timeout') return 'performance_threshold';
  if (failureClass === 'agent_failed') return 'compile_or_runtime';
  return 'assertion';
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

function formatTimestampForJob(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function quoteArg(arg: string): string {
  if (!/[\s"']/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}
