import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { isPathInside } from './targetResolver.js';
import { resolveBabelCliEntry, runBabelCli } from './liteTrustDemo.js';
import type { VaguenessCheckResult } from './liteVaguenessBenchmark.js';
import { scoreVaguenessScenario, type VaguenessScenario } from './liteVaguenessBenchmark.js';

export type DiscoveryCategory = 'ask' | 'plan' | 'explore';
export type DiscoveryProvider = 'live' | 'mock';
export type DiscoveryCellStatus = 'pass' | 'fail' | 'skip';

export interface WorkspaceDiscoveryRepoEntry {
  id: string;
  path: string;
  display_name: string;
  slug: string;
  stack: string;
  required: boolean;
  anchor_files: string[];
}

export interface WorkspaceDiscoveryRepoManifest {
  schema_version: 1;
  fixture_type: 'babel_workspace_discovery_repos';
  workspace_root: string;
  repos: WorkspaceDiscoveryRepoEntry[];
}

export interface WorkspaceDiscoveryScenario {
  id: string;
  category: DiscoveryCategory;
  description: string;
  task_template: string;
  command_verb: 'daily' | 'plan';
  acceptable_statuses: string[];
  allow_blocked?: boolean;
  acceptable_lanes?: string[];
  expect_tools?: boolean;
  expect_plan_artifact?: boolean;
  expect_review?: boolean;
  anti_statuses?: string[];
  read_only?: boolean;
}

export interface WorkspaceDiscoveryScenarioManifest {
  schema_version: 1;
  fixture_type: 'babel_workspace_discovery_scenarios';
  smoke_scenario_ids: string[];
  smoke_repo_ids: string[];
  scenarios: WorkspaceDiscoveryScenario[];
}

export interface DiscoveryToolCall {
  tool: string;
  target: string;
  succeeded: boolean;
}

export interface WorkspaceDiscoveryCellResult {
  id: string;
  scenario_id: string;
  repo_id: string;
  stack: string;
  category: DiscoveryCategory;
  project_root: string;
  resolved_task: string;
  status: DiscoveryCellStatus;
  exit_code: number;
  reported_status: string | null;
  selected_lane: string | null;
  run_dir: string | null;
  latency_ms: number;
  checks: VaguenessCheckResult[];
  tool_call_count: number;
  discovery_tool_count: number;
  context_anchor_hits: string[];
  tool_targets: string[];
  changed_files: string[];
  notes: string[];
  stdout_path: string;
  stderr_path: string;
}

export interface WorkspaceDiscoveryMetrics {
  tool_exploration_rate: number;
  context_anchor_rate: number;
  grounded_path_rate: number;
  plan_artifact_rate: number;
  blocked_clarification_rate: number;
  deep_escalation_rate: number;
  false_mutation_rate: number;
  status_ok_rate: number;
}

export const DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE = 0.9;
export const DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE = 0.9;
export const DEFAULT_WORKSPACE_DISCOVERY_MIN_GROUNDED_PATH_RATE = 0.9;
export const DEFAULT_WORKSPACE_DISCOVERY_MAX_DEEP_ESCALATION_RATE = 0.1;

export interface WorkspaceDiscoveryGateInput {
  passRate: number;
  minPassRate: number;
  minContextAnchorRate: number;
  metrics: WorkspaceDiscoveryMetrics;
  criticalFails: number;
}

export function evaluateWorkspaceDiscoveryGate(input: WorkspaceDiscoveryGateInput): boolean {
  return (
    input.passRate >= input.minPassRate &&
    input.criticalFails === 0 &&
    input.metrics.grounded_path_rate >= DEFAULT_WORKSPACE_DISCOVERY_MIN_GROUNDED_PATH_RATE &&
    input.metrics.context_anchor_rate >= input.minContextAnchorRate &&
    input.metrics.false_mutation_rate === 0 &&
    input.metrics.deep_escalation_rate <= DEFAULT_WORKSPACE_DISCOVERY_MAX_DEEP_ESCALATION_RATE
  );
}

export interface WorkspaceDiscoveryReport {
  schema_version: 1;
  report_type: 'babel_workspace_discovery_benchmark';
  generated_at: string;
  provider: DiscoveryProvider;
  daily_profile: string;
  smoke_mode: boolean;
  evidence_dir: string;
  workspace_root: string;
  min_pass_rate: number;
  min_context_anchor_rate: number;
  gate_passed: boolean;
  totals: {
    pass: number;
    fail: number;
    skip: number;
    executed: number;
    pass_rate: number;
    by_repo: Record<string, { pass: number; fail: number; skip: number }>;
    by_scenario: Record<string, { pass: number; fail: number; skip: number }>;
    by_stack: Record<string, { pass: number; fail: number; skip: number }>;
  };
  metrics: WorkspaceDiscoveryMetrics;
  cells: WorkspaceDiscoveryCellResult[];
}

export interface WorkspaceDiscoveryBenchmarkOptions {
  provider?: DiscoveryProvider;
  repoManifestPath?: string;
  scenariosPath?: string;
  workspaceRoot?: string;
  evidenceDir?: string;
  minPassRate?: number;
  minContextAnchorRate?: number;
  smoke?: boolean;
  repoFilter?: string[];
  maxCells?: number;
  cliEntry?: string;
  now?: Date;
}

const DISCOVERY_TOOLS = new Set([
  'read_file',
  'grep',
  'semantic_search',
  'directory_list',
  'file_read',
  'repo_search',
]);

const DEFAULT_ANTI_STATUSES = [
  'EXECUTOR_HALTED',
  'LITE_SCHEMA_FAILED',
  'FULL_ROUTE_REFUSED',
  'QA_REJECTED_MAX_LOOPS',
];

function fixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'fixtures', 'workspace-discovery');
}

export function defaultWorkspaceDiscoveryReposPath(): string {
  return join(fixturesDir(), 'repos.json');
}

export function defaultWorkspaceDiscoveryScenariosPath(): string {
  return join(fixturesDir(), 'scenarios.json');
}

export function readWorkspaceDiscoveryRepos(path?: string): WorkspaceDiscoveryRepoManifest {
  const raw = readFileSync(resolve(path ?? defaultWorkspaceDiscoveryReposPath()), 'utf-8');
  const parsed = JSON.parse(raw) as WorkspaceDiscoveryRepoManifest;
  if (parsed.fixture_type !== 'babel_workspace_discovery_repos') {
    throw new Error('Workspace discovery repos fixture has an unexpected fixture_type.');
  }
  return parsed;
}

export function readWorkspaceDiscoveryScenarios(path?: string): WorkspaceDiscoveryScenarioManifest {
  const raw = readFileSync(resolve(path ?? defaultWorkspaceDiscoveryScenariosPath()), 'utf-8');
  const parsed = JSON.parse(raw) as WorkspaceDiscoveryScenarioManifest;
  if (parsed.fixture_type !== 'babel_workspace_discovery_scenarios') {
    throw new Error('Workspace discovery scenarios fixture has an unexpected fixture_type.');
  }
  return parsed;
}

export function resolveDiscoveryTaskTemplate(
  template: string,
  repo: Pick<WorkspaceDiscoveryRepoEntry, 'display_name' | 'slug'>,
): string {
  return template.replaceAll('{display_name}', repo.display_name).replaceAll('{slug}', repo.slug);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function loadToolCalls(
  payload: Record<string, unknown> | null,
  runDir: string | null,
): DiscoveryToolCall[] {
  const calls: DiscoveryToolCall[] = [];

  const ingest = (entries: unknown): void => {
    if (!Array.isArray(entries)) {
      return;
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const tool = typeof record['tool'] === 'string' ? record['tool'] : '';
      const target = typeof record['target'] === 'string' ? record['target'] : '';
      if (tool) {
        const succeeded =
          record['verified'] === false
            ? false
            : typeof record['exit_code'] === 'number'
              ? record['exit_code'] === 0
              : true;
        calls.push({ tool, target, succeeded });
      }
    }
  };

  ingest(payload?.['tool_call_log']);
  if (runDir && existsSync(runDir)) {
    const executionReportPath = join(runDir, '04_execution_report.json');
    if (existsSync(executionReportPath)) {
      try {
        const report = JSON.parse(readFileSync(executionReportPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        ingest(report['tool_call_log']);
      } catch {
        // ignore malformed execution report
      }
    }
  }

  const deduped = new Map<string, DiscoveryToolCall>();
  for (const call of calls) {
    deduped.set(`${call.tool}::${call.target}`, call);
  }
  return [...deduped.values()];
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function matchesAnchor(target: string, anchor: string, projectRoot: string): boolean {
  const normalizedTarget = normalizePathForMatch(target);
  const normalizedAnchor = normalizePathForMatch(anchor);
  const normalizedRoot = normalizePathForMatch(projectRoot);
  const absoluteAnchor = normalizePathForMatch(resolve(projectRoot, anchor));
  return (
    normalizedTarget.endsWith(normalizedAnchor) ||
    normalizedTarget.includes(`/${normalizedAnchor}`) ||
    normalizedTarget === absoluteAnchor ||
    (normalizedTarget.startsWith(`${normalizedRoot}/`) &&
      normalizedTarget.includes(normalizedAnchor.split('/').pop() ?? normalizedAnchor))
  );
}

export function findContextAnchorHits(
  toolCalls: DiscoveryToolCall[],
  projectRoot: string,
  anchorFiles: string[],
): string[] {
  const hits = new Set<string>();
  for (const call of toolCalls) {
    for (const anchor of anchorFiles) {
      if (matchesAnchor(call.target, anchor, projectRoot)) {
        hits.add(anchor);
      }
    }
    if (/project_context\.md/i.test(call.target)) {
      hits.add('PROJECT_CONTEXT.md');
    }
  }
  return [...hits];
}

export function validateToolTargetsWithinProjectRoot(
  projectRoot: string,
  targets: string[],
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const rawTarget of targets) {
    const target = rawTarget.trim();
    if (!target) {
      continue;
    }
    const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(projectRoot, target);
    if (!isPathInside(projectRoot, resolvedTarget)) {
      violations.push(`tool target outside project_root: ${resolvedTarget}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

export function hasPlanArtifact(runDir: string | null): boolean {
  if (!runDir || !existsSync(runDir)) {
    return false;
  }
  for (const name of ['plan.md', 'lite_plan_answer.json']) {
    const path = join(runDir, name);
    if (!existsSync(path)) {
      continue;
    }
    try {
      if (statSync(path).size > 0) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

function toVaguenessScenario(
  scenario: WorkspaceDiscoveryScenario,
  task: string,
): VaguenessScenario {
  return {
    id: scenario.id,
    tier: 'L3_scope',
    category: scenario.category === 'explore' ? 'explore' : scenario.category,
    description: scenario.description,
    target: 'repo',
    command: [scenario.command_verb, '--json', task],
    acceptable_statuses: scenario.acceptable_statuses,
    ...(scenario.allow_blocked !== undefined ? { allow_blocked: scenario.allow_blocked } : {}),
    ...(scenario.acceptable_lanes !== undefined
      ? { acceptable_lanes: scenario.acceptable_lanes }
      : {}),
    ...(scenario.expect_tools !== undefined ? { expect_tools: scenario.expect_tools } : {}),
    ...(scenario.expect_review !== undefined ? { expect_review: scenario.expect_review } : {}),
    ...(scenario.anti_statuses !== undefined ? { anti_statuses: scenario.anti_statuses } : {}),
    ...(scenario.read_only !== undefined ? { read_only: scenario.read_only } : {}),
  };
}

export interface WorkspaceDiscoveryScoreInput {
  scenario: WorkspaceDiscoveryScenario;
  repo: WorkspaceDiscoveryRepoEntry;
  projectRoot: string;
  resolvedTask: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown> | null;
}

export function scoreWorkspaceDiscoveryCell(input: WorkspaceDiscoveryScoreInput): {
  pass: boolean;
  checks: VaguenessCheckResult[];
  reportedStatus: string | null;
  selectedLane: string | null;
  runDir: string | null;
  toolCalls: DiscoveryToolCall[];
  contextAnchorHits: string[];
  changedFiles: string[];
} {
  const base = scoreVaguenessScenario({
    scenario: toVaguenessScenario(input.scenario, input.resolvedTask),
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    payload: input.payload,
  });

  const checks = base.checks.filter((check) => check.id !== 'exploration_ok');
  const runDir = base.runDir;
  const toolCalls = loadToolCalls(input.payload, runDir);
  const executedToolCalls = toolCalls.filter((call) => call.succeeded);
  const toolTargets = executedToolCalls.map((call) => call.target).filter(Boolean);
  const discoveryTools = executedToolCalls.filter((call) => DISCOVERY_TOOLS.has(call.tool));
  const contextAnchorHits = findContextAnchorHits(
    toolCalls,
    input.projectRoot,
    input.repo.anchor_files,
  );

  const discoveryToolsOk =
    input.scenario.expect_tools !== true || (toolCalls.length >= 2 && discoveryTools.length >= 1);
  checks.push({
    id: 'discovery_tools_ok',
    pass: discoveryToolsOk,
    detail: `tool_calls=${executedToolCalls.length} discovery_tools=${discoveryTools.length}`,
  });

  const scopeResult = validateToolTargetsWithinProjectRoot(input.projectRoot, toolTargets);
  checks.push({
    id: 'grounded_paths_ok',
    pass: scopeResult.ok,
    detail: scopeResult.ok
      ? `targets=${toolTargets.length} all within project_root`
      : scopeResult.violations.join('; ') || 'tool targets outside project_root',
  });

  checks.push({
    id: 'context_anchor_ok',
    pass: contextAnchorHits.length >= 1,
    detail:
      contextAnchorHits.length > 0
        ? `anchors=${contextAnchorHits.join(',')}`
        : `no anchor hits among ${input.repo.anchor_files.join(', ')}`,
  });

  if (input.scenario.expect_plan_artifact === true) {
    const planOk = hasPlanArtifact(runDir);
    checks.push({
      id: 'plan_artifact_ok',
      pass: planOk,
      detail: planOk ? 'plan artifact present' : 'missing plan.md or lite_plan_answer.json',
    });
  }

  const pass = checks.every((check) => check.pass);
  return {
    pass,
    checks,
    reportedStatus: base.reportedStatus,
    selectedLane: base.selectedLane,
    runDir,
    toolCalls,
    contextAnchorHits,
    changedFiles: base.artifacts.changedFiles,
  };
}

function getBucket(
  map: Record<string, { pass: number; fail: number; skip: number }>,
  key: string,
): { pass: number; fail: number; skip: number } {
  map[key] ??= { pass: 0, fail: 0, skip: 0 };
  return map[key];
}

function incrementBucket(
  bucket: { pass: number; fail: number; skip: number },
  status: DiscoveryCellStatus,
): void {
  if (status === 'pass') {
    bucket.pass += 1;
    return;
  }
  if (status === 'fail') {
    bucket.fail += 1;
    return;
  }
  bucket.skip += 1;
}

function computeMetrics(cells: WorkspaceDiscoveryCellResult[]): WorkspaceDiscoveryMetrics {
  const executed = cells.filter((cell) => cell.status !== 'skip');
  const denom = executed.length || 1;
  const planCells = executed.filter((cell) => cell.category === 'plan');
  const explorePlanCells = executed.filter((cell) => cell.category !== 'ask');

  return {
    tool_exploration_rate: executed.filter((cell) => cell.discovery_tool_count >= 1).length / denom,
    context_anchor_rate:
      explorePlanCells.filter((cell) => cell.context_anchor_hits.length > 0).length /
      (explorePlanCells.length || 1),
    grounded_path_rate:
      executed.filter((cell) =>
        cell.checks.some((check) => check.id === 'grounded_paths_ok' && check.pass),
      ).length / denom,
    plan_artifact_rate:
      planCells.filter((cell) =>
        cell.checks.some((check) => check.id === 'plan_artifact_ok' && check.pass),
      ).length / (planCells.length || 1),
    blocked_clarification_rate:
      executed.filter((cell) => cell.reported_status === 'NEEDS_MORE_CONTEXT').length / denom,
    deep_escalation_rate:
      executed.filter((cell) => cell.selected_lane === 'deep_lane').length / denom,
    false_mutation_rate:
      executed.filter((cell) =>
        cell.checks.some((check) => check.id === 'read_only_ok' && !check.pass),
      ).length / denom,
    status_ok_rate:
      executed.filter((cell) => cell.checks.some((check) => check.id === 'status_ok' && check.pass))
        .length / denom,
  };
}

function shouldRunCell(
  scenario: WorkspaceDiscoveryScenario,
  repo: WorkspaceDiscoveryRepoEntry,
  options: WorkspaceDiscoveryBenchmarkOptions,
  manifest: WorkspaceDiscoveryScenarioManifest,
): boolean {
  if (options.smoke === true) {
    if (!manifest.smoke_scenario_ids.includes(scenario.id)) {
      return false;
    }
    if (!manifest.smoke_repo_ids.includes(repo.id)) {
      return false;
    }
  }
  if (
    options.repoFilter &&
    options.repoFilter.length > 0 &&
    !options.repoFilter.includes(repo.id)
  ) {
    return false;
  }
  return true;
}

function invokeDiscoveryCli(
  scenario: WorkspaceDiscoveryScenario,
  repo: WorkspaceDiscoveryRepoEntry,
  projectRoot: string,
  provider: DiscoveryProvider,
  cliEntry: string,
): ReturnType<typeof runBabelCli> {
  const task = resolveDiscoveryTaskTemplate(scenario.task_template, repo);
  const argv = [scenario.command_verb, '--json', task, '--project-root', projectRoot];
  return runBabelCli(argv, {
    projectRoot,
    cliEntry,
    offlineDemo: provider === 'mock',
    env: {
      BABEL_DAILY_PROFILE: 'terminal',
    },
  });
}

export function runWorkspaceDiscoveryBenchmark(
  options: WorkspaceDiscoveryBenchmarkOptions = {},
): WorkspaceDiscoveryReport {
  const provider = options.provider ?? 'live';
  const smoke = options.smoke === true;
  const minPassRate = options.minPassRate ?? DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE;
  const minContextAnchorRate =
    options.minContextAnchorRate ?? DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE;
  const repoManifest = readWorkspaceDiscoveryRepos(options.repoManifestPath);
  const scenarioManifest = readWorkspaceDiscoveryScenarios(options.scenariosPath);
  const workspaceRoot = resolve(options.workspaceRoot ?? repoManifest.workspace_root);
  const cliEntry = options.cliEntry ?? resolveBabelCliEntry();
  const timestamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '');
  const evidenceDir = resolve(
    options.evidenceDir ?? join(BABEL_RUNS_DIR, 'workspace-discovery', timestamp),
  );
  mkdirSync(evidenceDir, { recursive: true });

  const cells: WorkspaceDiscoveryCellResult[] = [];
  const byRepo: Record<string, { pass: number; fail: number; skip: number }> = {};
  const byScenario: Record<string, { pass: number; fail: number; skip: number }> = {};
  const byStack: Record<string, { pass: number; fail: number; skip: number }> = {};
  let executedCells = 0;

  for (const repo of repoManifest.repos) {
    const projectRoot = resolve(workspaceRoot, repo.path);

    for (const scenario of scenarioManifest.scenarios) {
      if (!shouldRunCell(scenario, repo, options, scenarioManifest)) {
        continue;
      }
      if (options.maxCells !== undefined && executedCells >= options.maxCells) {
        break;
      }

      if (!existsSync(projectRoot)) {
        const skipResult: WorkspaceDiscoveryCellResult = {
          id: `${scenario.id}__${repo.id}`,
          scenario_id: scenario.id,
          repo_id: repo.id,
          stack: repo.stack,
          category: scenario.category,
          project_root: projectRoot,
          resolved_task: resolveDiscoveryTaskTemplate(scenario.task_template, repo),
          status: 'skip',
          exit_code: 0,
          reported_status: null,
          selected_lane: null,
          run_dir: null,
          latency_ms: 0,
          checks: [],
          tool_call_count: 0,
          discovery_tool_count: 0,
          context_anchor_hits: [],
          tool_targets: [],
          changed_files: [],
          notes: [`project root missing: ${projectRoot}`],
          stdout_path: '',
          stderr_path: '',
        };
        cells.push(skipResult);
        incrementBucket(getBucket(byRepo, repo.id), 'skip');
        incrementBucket(getBucket(byScenario, scenario.id), 'skip');
        incrementBucket(getBucket(byStack, repo.stack), 'skip');
        if (repo.required) {
          throw new Error(`Required repo path does not exist: ${projectRoot}`);
        }
        continue;
      }

      executedCells += 1;
      const cellId = `${scenario.id}__${repo.id}`;
      const cellDir = join(evidenceDir, cellId);
      mkdirSync(cellDir, { recursive: true });
      const resolvedTask = resolveDiscoveryTaskTemplate(scenario.task_template, repo);
      const started = performance.now();
      const cli = invokeDiscoveryCli(scenario, repo, projectRoot, provider, cliEntry);
      const stdoutPath = join(cellDir, 'stdout.log');
      const stderrPath = join(cellDir, 'stderr.log');
      writeFileSync(stdoutPath, cli.stdout, 'utf-8');
      writeFileSync(stderrPath, cli.stderr, 'utf-8');

      const scored = scoreWorkspaceDiscoveryCell({
        scenario,
        repo,
        projectRoot,
        resolvedTask,
        exitCode: cli.exitCode,
        stdout: cli.stdout,
        stderr: cli.stderr,
        payload: cli.payload,
      });

      const result: WorkspaceDiscoveryCellResult = {
        id: cellId,
        scenario_id: scenario.id,
        repo_id: repo.id,
        stack: repo.stack,
        category: scenario.category,
        project_root: projectRoot,
        resolved_task: resolvedTask,
        status: scored.pass ? 'pass' : 'fail',
        exit_code: cli.exitCode,
        reported_status: scored.reportedStatus,
        selected_lane: scored.selectedLane,
        run_dir: scored.runDir,
        latency_ms: Math.round(performance.now() - started),
        checks: scored.checks,
        tool_call_count: scored.toolCalls.length,
        discovery_tool_count: scored.toolCalls.filter((call) => DISCOVERY_TOOLS.has(call.tool))
          .length,
        context_anchor_hits: scored.contextAnchorHits,
        tool_targets: scored.toolCalls.map((call) => call.target).filter(Boolean),
        changed_files: scored.changedFiles,
        notes: [scenario.description, `stack=${repo.stack}`],
        stdout_path: stdoutPath,
        stderr_path: stderrPath,
      };
      cells.push(result);
      incrementBucket(getBucket(byRepo, repo.id), result.status);
      incrementBucket(getBucket(byScenario, scenario.id), result.status);
      incrementBucket(getBucket(byStack, repo.stack), result.status);
    }
    if (options.maxCells !== undefined && executedCells >= options.maxCells) {
      break;
    }
  }

  const pass = cells.filter((cell) => cell.status === 'pass').length;
  const fail = cells.filter((cell) => cell.status === 'fail').length;
  const skip = cells.filter((cell) => cell.status === 'skip').length;
  const executed = cells.length - skip;
  const passRate = executed > 0 ? pass / executed : 0;
  const metrics = computeMetrics(cells);

  const criticalFails = cells.filter(
    (cell) =>
      cell.status === 'fail' &&
      ((cell.reported_status && DEFAULT_ANTI_STATUSES.includes(cell.reported_status)) ||
        cell.checks.some((check) => check.id === 'read_only_ok' && !check.pass)),
  ).length;

  const gatePassed = evaluateWorkspaceDiscoveryGate({
    passRate,
    minPassRate,
    minContextAnchorRate,
    metrics,
    criticalFails,
  });

  return {
    schema_version: 1,
    report_type: 'babel_workspace_discovery_benchmark',
    generated_at: new Date().toISOString(),
    provider,
    daily_profile: 'terminal',
    smoke_mode: smoke,
    evidence_dir: evidenceDir,
    workspace_root: workspaceRoot,
    min_pass_rate: minPassRate,
    min_context_anchor_rate: minContextAnchorRate,
    gate_passed: gatePassed,
    totals: {
      pass,
      fail,
      skip,
      executed,
      pass_rate: passRate,
      by_repo: byRepo,
      by_scenario: byScenario,
      by_stack: byStack,
    },
    metrics,
    cells,
  };
}
