import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { BABEL_ROOT, BABEL_RUNS_DIR } from '../cli/constants.js';

export type ParityToolId = 'babel' | 'codex' | 'claude_code';
export type ParityRunStatus = 'success' | 'failure' | 'manual_required' | 'not_run';
export type ParityVerifierStatus = 'pass' | 'fail' | 'not_run' | 'unknown';
export type ParityComparisonVerdict =
  | 'babel_stronger'
  | 'competitor_stronger'
  | 'tie'
  | 'inconclusive';

export interface ParityTaskDefinition {
  id: string;
  title: string;
  category: string;
  verifier: string;
  success_criteria: string[];
  fairness_notes: string[];
}

export interface ParityToolResult {
  task_id: string;
  tool: ParityToolId;
  status: ParityRunStatus;
  verifier: ParityVerifierStatus;
  false_complete: boolean;
  latency_ms: number | null;
  cost_usd: number | null;
  token_count: number | null;
  changed_files: string[];
  user_interventions: number | null;
  evidence_path: string | null;
  notes: string[];
}

export interface ParityComparison {
  task_id: string;
  competitor: Exclude<ParityToolId, 'babel'>;
  verdict: ParityComparisonVerdict;
  reason: string;
}

export interface ParityBenchmarkReport {
  schema_version: 1;
  benchmark_type: 'babel_cli_phase12_parity';
  generated_at: string;
  artifact_path: string;
  environment: {
    platform: NodeJS.Platform;
    node: string;
    babel_root: string;
    runs_dir: string;
  };
  summary: {
    tasks: number;
    tools: number;
    result_cells: number;
    success: number;
    failure: number;
    manual_required: number;
    not_run: number;
    false_complete: number;
    measured_cells: number;
    claim_ready: boolean;
  };
  tasks: ParityTaskDefinition[];
  results: ParityToolResult[];
  comparisons: ParityComparison[];
  truthful_gap_list: string[];
  next_actions: string[];
}

export interface ParityBenchmarkOptions {
  outputDir?: string;
  now?: Date;
  fixturePath?: string;
  results?: ParityToolResult[];
}

const ToolResultSchema = z.object({
  task_id: z.string(),
  tool: z.enum(['babel', 'codex', 'claude_code']),
  status: z.enum(['success', 'failure', 'manual_required', 'not_run']),
  verifier: z.enum(['pass', 'fail', 'not_run', 'unknown']),
  false_complete: z.boolean().default(false),
  latency_ms: z.number().nonnegative().nullable().default(null),
  cost_usd: z.number().nonnegative().nullable().default(null),
  token_count: z.number().int().nonnegative().nullable().default(null),
  changed_files: z.array(z.string()).default([]),
  user_interventions: z.number().int().nonnegative().nullable().default(null),
  evidence_path: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
});

const FixtureSchema = z.object({
  results: z.array(ToolResultSchema),
});

function toArtifactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function defaultTasks(): ParityTaskDefinition[] {
  return [
    {
      id: 'small_bug_fix',
      title: 'Small bug fix',
      category: 'edit',
      verifier: 'project-local unit test or focused regression command',
      success_criteria: ['minimal changed files', 'verifier passes', 'no false-complete claim'],
      fairness_notes: ['Use the same repo state and task prompt for every tool.'],
    },
    {
      id: 'failing_test_repair',
      title: 'Failing test repair',
      category: 'verification',
      verifier: 'the initially failing test command',
      success_criteria: [
        'failing test passes',
        'no unrelated broad refactor',
        'failure evidence is preserved',
      ],
      fairness_notes: ['Seed the same failing test before each tool run.'],
    },
    {
      id: 'multi_file_refactor',
      title: 'Multi-file refactor',
      category: 'edit',
      verifier: 'typecheck plus relevant tests',
      success_criteria: ['intended files only', 'typecheck passes', 'behavior stays equivalent'],
      fairness_notes: ['Use the same file list and acceptance text for each tool.'],
    },
    {
      id: 'docs_grounded_dependency_update',
      title: 'Docs-grounded dependency update',
      category: 'research',
      verifier: 'build and dependency-specific smoke check',
      success_criteria: ['cites current docs', 'updates only necessary files', 'build passes'],
      fairness_notes: ['Record whether each tool used fresh docs or stale memory.'],
    },
    {
      id: 'issue_pr_context_implementation',
      title: 'Issue/PR-context implementation',
      category: 'delivery',
      verifier: 'task-specific tests plus PR diff review',
      success_criteria: [
        'uses issue context',
        'produces reviewable diff',
        'does not invent requirements',
      ],
      fairness_notes: ['Give each tool the same issue and changed-file context.'],
    },
    {
      id: 'ui_browser_inspection',
      title: 'UI/browser inspection task',
      category: 'frontend',
      verifier: 'browser/screenshot inspection plus build',
      success_criteria: [
        'visual issue verified',
        'fix rendered in browser',
        'no layout regression',
      ],
      fairness_notes: ['Use the same viewport and screenshot evidence.'],
    },
    {
      id: 'checkpoint_restore_recovery',
      title: 'Checkpoint/restore recovery task',
      category: 'recovery',
      verifier: 'restore evidence plus post-restore diff check',
      success_criteria: [
        'bad change restored',
        'unrelated edits preserved',
        'restore command documented',
      ],
      fairness_notes: ['Seed the same dirty-worktree condition for every tool.'],
    },
    {
      id: 'read_only_subagent_review',
      title: 'Read-only subagent review task',
      category: 'agent_teams',
      verifier: 'review evidence and no source mutation',
      success_criteria: ['parallel review evidence', 'no writes', 'clear synthesis output'],
      fairness_notes: ['If a competing tool lacks subagents, record the nearest fair review mode.'],
    },
  ];
}

function defaultTools(): ParityToolId[] {
  return ['babel', 'codex', 'claude_code'];
}

function manualResult(taskId: string, tool: ParityToolId): ParityToolResult {
  return {
    task_id: taskId,
    tool,
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
      'Measured result not supplied. Add this cell through --fixture before making parity claims.',
    ],
  };
}

export function parityResultKey(result: Pick<ParityToolResult, 'task_id' | 'tool'>): string {
  return `${result.task_id}::${result.tool}`;
}

export function readParityFixtureFile(path: string): ParityToolResult[] {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Parity benchmark fixture not found: ${resolved}`);
  }
  const parsed = FixtureSchema.parse(JSON.parse(readFileSync(resolved, 'utf8')) as unknown);
  return parsed.results;
}

export interface ParityFixtureMergeSummary {
  input_files: number;
  input_cells: number;
  merged_cells: number;
  duplicates_overwritten: number;
}

export function mergeParityFixtureInputs(paths: string[]): {
  results: ParityToolResult[];
  summary: ParityFixtureMergeSummary;
} {
  const byKey = new Map<string, ParityToolResult>();
  let inputCells = 0;
  let duplicatesOverwritten = 0;

  for (const path of paths) {
    for (const result of readParityFixtureFile(path)) {
      inputCells += 1;
      const key = parityResultKey(result);
      if (byKey.has(key)) {
        duplicatesOverwritten += 1;
      }
      byKey.set(key, result);
    }
  }

  const results = [...byKey.values()].sort((left, right) => {
    const taskCompare = left.task_id.localeCompare(right.task_id);
    return taskCompare !== 0 ? taskCompare : left.tool.localeCompare(right.tool);
  });

  return {
    results,
    summary: {
      input_files: paths.length,
      input_cells: inputCells,
      merged_cells: results.length,
      duplicates_overwritten: duplicatesOverwritten,
    },
  };
}

function readFixture(path: string): ParityToolResult[] {
  return readParityFixtureFile(path);
}

function resultKey(result: Pick<ParityToolResult, 'task_id' | 'tool'>): string {
  return parityResultKey(result);
}

function mergeResults(
  tasks: ParityTaskDefinition[],
  tools: ParityToolId[],
  supplied: ParityToolResult[],
): ParityToolResult[] {
  const byKey = new Map<string, ParityToolResult>();
  for (const result of supplied) {
    byKey.set(resultKey(result), result);
  }
  return tasks.flatMap((task) =>
    tools.map((tool) => byKey.get(`${task.id}::${tool}`) ?? manualResult(task.id, tool)),
  );
}

function compareStatus(
  babel: ParityToolResult,
  competitor: ParityToolResult,
): ParityComparisonVerdict {
  const comparable = [babel.status, competitor.status].every(
    (status) => status === 'success' || status === 'failure',
  );
  if (!comparable) {
    return 'inconclusive';
  }
  if (babel.status === 'success' && competitor.status !== 'success') {
    return 'babel_stronger';
  }
  if (competitor.status === 'success' && babel.status !== 'success') {
    return 'competitor_stronger';
  }
  if (babel.false_complete !== competitor.false_complete) {
    return babel.false_complete ? 'competitor_stronger' : 'babel_stronger';
  }
  if (babel.verifier !== competitor.verifier) {
    if (babel.verifier === 'pass') return 'babel_stronger';
    if (competitor.verifier === 'pass') return 'competitor_stronger';
  }
  return 'tie';
}

function buildComparisons(
  tasks: ParityTaskDefinition[],
  results: ParityToolResult[],
): ParityComparison[] {
  const byKey = new Map(results.map((result) => [resultKey(result), result]));
  return tasks.flatMap((task) => {
    const babel = byKey.get(`${task.id}::babel`);
    if (!babel) return [];
    return (['codex', 'claude_code'] as const).map((competitor) => {
      const competitorResult = byKey.get(`${task.id}::${competitor}`);
      const verdict = competitorResult ? compareStatus(babel, competitorResult) : 'inconclusive';
      return {
        task_id: task.id,
        competitor,
        verdict,
        reason:
          verdict === 'inconclusive'
            ? 'At least one measured result is missing or manual-required.'
            : `Babel=${babel.status}/${babel.verifier}; ${competitor}=${competitorResult?.status}/${competitorResult?.verifier}.`,
      };
    });
  });
}

function summarize(
  tasks: ParityTaskDefinition[],
  tools: ParityToolId[],
  results: ParityToolResult[],
  comparisons: ParityComparison[],
): ParityBenchmarkReport['summary'] {
  const success = results.filter((result) => result.status === 'success').length;
  const failure = results.filter((result) => result.status === 'failure').length;
  const manualRequired = results.filter((result) => result.status === 'manual_required').length;
  const notRun = results.filter((result) => result.status === 'not_run').length;
  const falseComplete = results.filter((result) => result.false_complete).length;
  const measuredCells = success + failure;
  const completeMatrix = measuredCells === results.length;
  const hasBabelStrongerAxis = comparisons.some(
    (comparison) => comparison.verdict === 'babel_stronger',
  );
  return {
    tasks: tasks.length,
    tools: tools.length,
    result_cells: results.length,
    success,
    failure,
    manual_required: manualRequired,
    not_run: notRun,
    false_complete: falseComplete,
    measured_cells: measuredCells,
    claim_ready: completeMatrix && hasBabelStrongerAxis,
  };
}

function buildTruthfulGapList(comparisons: ParityComparison[]): string[] {
  const gaps = comparisons
    .filter(
      (comparison) =>
        comparison.verdict === 'competitor_stronger' || comparison.verdict === 'inconclusive',
    )
    .map(
      (comparison) => `${comparison.task_id} vs ${comparison.competitor}: ${comparison.verdict}`,
    );
  return gaps.length > 0
    ? gaps
    : ['No competitor-stronger or inconclusive axes were recorded in supplied results.'];
}

export function runParityBenchmark(options: ParityBenchmarkOptions = {}): ParityBenchmarkReport {
  const now = options.now ?? new Date();
  const outputDir = resolve(options.outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks'));
  const artifactPath = join(outputDir, `phase12-parity-${toArtifactTimestamp(now)}.json`);
  const tasks = defaultTasks();
  const tools = defaultTools();
  const suppliedResults = [
    ...(options.fixturePath ? readFixture(resolve(options.fixturePath)) : []),
    ...(options.results ?? []),
  ];
  const results = mergeResults(tasks, tools, suppliedResults);
  const comparisons = buildComparisons(tasks, results);
  const summary = summarize(tasks, tools, results, comparisons);

  mkdirSync(outputDir, { recursive: true });
  const report: ParityBenchmarkReport = {
    schema_version: 1,
    benchmark_type: 'babel_cli_phase12_parity',
    generated_at: now.toISOString(),
    artifact_path: artifactPath,
    environment: {
      platform: process.platform,
      node: process.version,
      babel_root: BABEL_ROOT,
      runs_dir: BABEL_RUNS_DIR,
    },
    summary,
    tasks,
    results,
    comparisons,
    truthful_gap_list: buildTruthfulGapList(comparisons),
    next_actions: summary.claim_ready
      ? ['Review the artifact and update claims only for evidenced axes.']
      : [
          'Supply measured Babel, Codex, and Claude Code results through --fixture before making parity claims.',
        ],
  };
  writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function formatParityBenchmarkHuman(report: ParityBenchmarkReport): string {
  return [
    'Babel Phase 12 Parity Benchmark',
    `Artifact: ${report.artifact_path}`,
    `Generated: ${report.generated_at}`,
    '',
    `Tasks: ${report.summary.tasks}`,
    `Result cells: ${report.summary.measured_cells}/${report.summary.result_cells} measured`,
    `Outcomes: ${report.summary.success} success, ${report.summary.failure} failure, ${report.summary.manual_required} manual required, ${report.summary.not_run} not run`,
    `False-complete: ${report.summary.false_complete}`,
    `Claim ready: ${report.summary.claim_ready ? 'yes' : 'no'}`,
    '',
    'Comparisons:',
    ...report.comparisons.map(
      (comparison) =>
        `${comparison.verdict.toUpperCase().padEnd(20)} ${comparison.task_id} vs ${comparison.competitor}`,
    ),
  ].join('\n');
}
