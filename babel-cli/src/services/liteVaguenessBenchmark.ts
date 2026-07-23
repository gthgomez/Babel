import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import { readParityCorpusTask, writeParityCorpusRepo } from './parityCorpus.js';
import { resolveBabelCliEntry, runBabelCli } from './liteTrustDemo.js';

export type VaguenessTier = 'L1_minimal' | 'L2_intent' | 'L3_scope' | 'L4_followup';
export type VaguenessCategory = 'ask' | 'plan' | 'explore' | 'fix' | 'propose';
export type VaguenessTarget = 'repo' | 'seeded';
export type VaguenessProvider = 'mock' | 'live';
export type VaguenessScenarioStatus = 'pass' | 'fail' | 'skip';

export interface VaguenessRepoEntry {
  id: string;
  path: string;
  required: boolean;
  description?: string;
}

export interface VaguenessRepoManifest {
  schema_version: 1;
  fixture_type: 'babel_vagueness_repos';
  workspace_root: string;
  repos: VaguenessRepoEntry[];
}

export interface VaguenessScenario {
  id: string;
  tier: VaguenessTier;
  category: VaguenessCategory;
  description: string;
  target: VaguenessTarget;
  command: string[];
  acceptable_statuses: string[];
  allow_blocked?: boolean;
  expect_lane?: string;
  acceptable_lanes?: string[];
  expect_tools?: boolean;
  expect_review?: boolean;
  anti_statuses?: string[];
  read_only?: boolean;
  repos?: string[];
}

export interface VaguenessScenarioManifest {
  schema_version: 1;
  fixture_type: 'babel_vagueness_scenarios';
  scenarios: VaguenessScenario[];
}

export interface VaguenessCheckResult {
  id: string;
  pass: boolean;
  detail: string;
}

export interface VaguenessScenarioResult {
  id: string;
  tier: VaguenessTier;
  category: VaguenessCategory;
  repo_id: string | null;
  project_root: string;
  status: VaguenessScenarioStatus;
  exit_code: number;
  reported_status: string | null;
  selected_lane: string | null;
  run_dir: string | null;
  latency_ms: number;
  checks: VaguenessCheckResult[];
  tool_call_count: number;
  session_loop_step_count: number;
  changed_files: string[];
  notes: string[];
  stdout_path: string;
  stderr_path: string;
}

export interface VaguenessBenchmarkMetrics {
  deep_escalation_rate: number;
  false_mutation_rate: number;
  tool_exploration_rate: number;
  blocked_clarification_rate: number;
  lane_match_rate: number;
  status_ok_rate: number;
}

export interface VaguenessBenchmarkReport {
  schema_version: 1;
  report_type: 'babel_vagueness_benchmark';
  generated_at: string;
  provider: VaguenessProvider;
  daily_profile: string;
  evidence_dir: string;
  workspace_root: string | null;
  project_root: string | null;
  min_pass_rate: number;
  gate_passed: boolean;
  totals: {
    pass: number;
    fail: number;
    skip: number;
    executed: number;
    pass_rate: number;
    by_tier: Record<string, { pass: number; fail: number; skip: number }>;
    by_repo: Record<string, { pass: number; fail: number; skip: number }>;
  };
  metrics: VaguenessBenchmarkMetrics;
  scenarios: VaguenessScenarioResult[];
}

export interface VaguenessBenchmarkOptions {
  provider?: VaguenessProvider;
  projectRoot?: string;
  repoManifestPath?: string;
  workspaceRoot?: string;
  scenariosPath?: string;
  evidenceDir?: string;
  minPassRate?: number;
  cliEntry?: string;
  now?: Date;
}

const DEFAULT_ANTI_STATUSES = [
  'EXECUTOR_HALTED',
  'LITE_SCHEMA_FAILED',
  'FULL_ROUTE_REFUSED',
  'QA_REJECTED_MAX_LOOPS',
];

const INTERNAL_VERBS = new Set(['daily', 'plan', 'undo', 'review']);

function fixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'fixtures', 'vagueness');
}

export function defaultVaguenessScenariosPath(): string {
  return join(fixturesDir(), 'scenarios.json');
}

export function defaultVaguenessReposPath(): string {
  return join(fixturesDir(), 'repos.json');
}

export function readVaguenessScenarios(path?: string): VaguenessScenarioManifest {
  const raw = readFileSync(resolve(path ?? defaultVaguenessScenariosPath()), 'utf-8');
  const parsed = JSON.parse(raw) as VaguenessScenarioManifest;
  if (parsed.fixture_type !== 'babel_vagueness_scenarios') {
    throw new Error('Vagueness scenarios fixture has an unexpected fixture_type.');
  }
  return parsed;
}

export function readVaguenessRepos(path?: string): VaguenessRepoManifest {
  const raw = readFileSync(resolve(path ?? defaultVaguenessReposPath()), 'utf-8');
  const parsed = JSON.parse(raw) as VaguenessRepoManifest;
  if (parsed.fixture_type !== 'babel_vagueness_repos') {
    throw new Error('Vagueness repos fixture has an unexpected fixture_type.');
  }
  return parsed;
}

function taskTextFromArgv(argv: string[]): string {
  return argv.filter((arg) => !arg.startsWith('-') && !INTERNAL_VERBS.has(arg)).join(' ');
}

function wantsMutationProvider(argv: string[]): boolean {
  const head = argv[0];
  if (head === 'plan' || head === 'review' || head === 'undo') {
    return false;
  }
  if (head === 'daily') {
    return /\b(fix|repair)\b/i.test(taskTextFromArgv(argv));
  }
  return false;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizeLane(lane: string | null): string | null {
  if (!lane) {
    return null;
  }
  if (lane.startsWith('lite_')) {
    return lane;
  }
  const map: Record<string, string> = {
    ask: 'lite_ask',
    plan: 'lite_plan',
    report: 'lite_report',
    patch: 'lite_patch',
    fix: 'lite_fix',
  };
  return map[lane] ?? lane;
}

function lanesMatch(
  reported: string | null,
  expected: string | undefined,
  acceptable: string[] | undefined,
): boolean {
  const normalizedReported = normalizeLane(reported);
  if (acceptable && acceptable.length > 0) {
    return acceptable.some((lane) => normalizeLane(lane) === normalizedReported);
  }
  if (!expected) {
    return true;
  }
  return normalizedReported === normalizeLane(expected);
}

interface ExecutionArtifacts {
  toolCallCount: number;
  sessionLoopStepCount: number;
  changedFiles: string[];
  outputReviewPresent: boolean;
  outputReviewShallowOnly: boolean;
}

function loadExecutionArtifacts(
  payload: Record<string, unknown> | null,
  runDir: string | null,
): ExecutionArtifacts {
  let toolCallCount = 0;
  let sessionLoopStepCount = 0;
  let changedFiles = asStringArray(payload?.['changed_files']);
  let outputReviewPresent = false;
  let outputReviewShallowOnly = false;

  const payloadToolLog = payload?.['tool_call_log'];
  if (Array.isArray(payloadToolLog)) {
    toolCallCount = payloadToolLog.length;
  }
  const payloadSteps = payload?.['session_loop_steps'];
  if (Array.isArray(payloadSteps)) {
    sessionLoopStepCount = payloadSteps.length;
  }

  if (runDir && existsSync(runDir)) {
    const executionReportPath = join(runDir, '04_execution_report.json');
    if (existsSync(executionReportPath)) {
      try {
        const report = JSON.parse(readFileSync(executionReportPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        const reportToolLog = report['tool_call_log'];
        if (Array.isArray(reportToolLog)) {
          toolCallCount = Math.max(toolCallCount, reportToolLog.length);
        }
        const reportChanged = report['changed_files'];
        if (Array.isArray(reportChanged) && reportChanged.length > 0) {
          changedFiles = reportChanged.filter((item): item is string => typeof item === 'string');
        }
      } catch {
        // ignore malformed execution report
      }
    }

    const reviewPath = join(runDir, 'output_review.json');
    if (existsSync(reviewPath)) {
      try {
        const review = JSON.parse(readFileSync(reviewPath, 'utf-8')) as Record<string, unknown>;
        outputReviewPresent = review['artifact_type'] === 'babel_human_output_review';
        const findings = Array.isArray(review['findings'])
          ? review['findings'].filter((item): item is string => typeof item === 'string')
          : [];
        outputReviewShallowOnly = findings.some((finding) =>
          /shallow|future-only|plan language/i.test(finding),
        );
      } catch {
        // ignore malformed review artifact
      }
    }
  }

  return {
    toolCallCount,
    sessionLoopStepCount,
    changedFiles,
    outputReviewPresent,
    outputReviewShallowOnly,
  };
}

export interface VaguenessScoreInput {
  scenario: VaguenessScenario;
  exitCode: number;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown> | null;
}

export function scoreVaguenessScenario(input: VaguenessScoreInput): {
  pass: boolean;
  checks: VaguenessCheckResult[];
  reportedStatus: string | null;
  selectedLane: string | null;
  runDir: string | null;
  artifacts: ExecutionArtifacts;
} {
  const { scenario, exitCode, stdout, stderr, payload } = input;
  const checks: VaguenessCheckResult[] = [];
  const humanBlob = `${stdout}\n${stderr}`;
  const reportedStatus = typeof payload?.['status'] === 'string' ? payload['status'] : null;
  const selectedLane =
    typeof payload?.['selected_lane'] === 'string' ? payload['selected_lane'] : null;
  const runDir = typeof payload?.['run_dir'] === 'string' ? payload['run_dir'] : null;
  const artifacts = loadExecutionArtifacts(payload, runDir);
  const antiStatuses = scenario.anti_statuses ?? DEFAULT_ANTI_STATUSES;

  const schemaFailure = /Zod validation failed|LITE_SCHEMA_FAILED/i.test(humanBlob);
  checks.push({
    id: 'no_anti_status',
    pass: !schemaFailure && !antiStatuses.includes(reportedStatus ?? ''),
    detail: schemaFailure
      ? 'schema failure surfaced in CLI output'
      : antiStatuses.includes(reportedStatus ?? '')
        ? `anti status=${reportedStatus}`
        : 'no anti-status or schema failure',
  });

  const statusOk =
    scenario.acceptable_statuses.includes(reportedStatus ?? '') ||
    (scenario.allow_blocked === true && reportedStatus === 'NEEDS_MORE_CONTEXT');
  const exitOk = exitCode === 0 || reportedStatus !== null;
  checks.push({
    id: 'status_ok',
    pass: statusOk && exitOk,
    detail: statusOk
      ? `status=${reportedStatus ?? 'null'} exit=${exitCode}`
      : `unexpected status=${String(reportedStatus)} exit=${exitCode}`,
  });

  const laneExpectation =
    scenario.acceptable_lanes && scenario.acceptable_lanes.length > 0
      ? scenario.acceptable_lanes.join('|')
      : scenario.expect_lane;
  checks.push({
    id: 'lane_ok',
    pass: lanesMatch(selectedLane, scenario.expect_lane, scenario.acceptable_lanes),
    detail: laneExpectation
      ? `selected_lane=${String(selectedLane)} expected=${laneExpectation}`
      : `selected_lane=${String(selectedLane)} (no expectation)`,
  });

  const explorationOk =
    scenario.expect_tools !== true ||
    artifacts.toolCallCount >= 1 ||
    artifacts.sessionLoopStepCount >= 1;
  checks.push({
    id: 'exploration_ok',
    pass: explorationOk,
    detail: scenario.expect_tools
      ? `tool_calls=${artifacts.toolCallCount} session_steps=${artifacts.sessionLoopStepCount}`
      : 'exploration not required',
  });

  const readOnlyOk = scenario.read_only !== true || artifacts.changedFiles.length === 0;
  checks.push({
    id: 'read_only_ok',
    pass: readOnlyOk,
    detail: scenario.read_only
      ? `changed_files=${artifacts.changedFiles.length}`
      : 'mutation allowed',
  });

  const reviewOk =
    scenario.expect_review !== true ||
    (artifacts.outputReviewPresent && !artifacts.outputReviewShallowOnly);
  checks.push({
    id: 'review_ok',
    pass: reviewOk,
    detail: scenario.expect_review
      ? `review_present=${artifacts.outputReviewPresent} shallow_only=${artifacts.outputReviewShallowOnly}`
      : 'review not required',
  });

  const pass = checks.every((check) => check.pass);
  return {
    pass,
    checks,
    reportedStatus,
    selectedLane,
    runDir,
    artifacts,
  };
}

function prepareSeededRoot(): string {
  const seededRoot = mkdtempSync(join(tmpdir(), 'babel-vagueness-seeded-'));
  const task = readParityCorpusTask('small_bug_fix');
  writeParityCorpusRepo(seededRoot, task);
  writeFileSync(
    join(seededRoot, 'README.md'),
    '# Vagueness Fixture\nA tiny Node math repo for vague fix scenarios.\n',
    'utf-8',
  );
  return seededRoot;
}

function resolveRepoTargets(options: VaguenessBenchmarkOptions): Array<{
  repoId: string | null;
  projectRoot: string;
  required: boolean;
}> {
  if (options.projectRoot) {
    return [
      {
        repoId: null,
        projectRoot: resolve(options.projectRoot),
        required: true,
      },
    ];
  }

  const manifest = readVaguenessRepos(options.repoManifestPath);
  const workspaceRoot = resolve(options.workspaceRoot ?? manifest.workspace_root);
  return manifest.repos.map((repo) => ({
    repoId: repo.id,
    projectRoot: resolve(workspaceRoot, repo.path),
    required: repo.required,
  }));
}

function scenarioAppliesToRepo(scenario: VaguenessScenario, repoId: string | null): boolean {
  if (!scenario.repos || scenario.repos.length === 0) {
    return true;
  }
  if (!repoId) {
    return true;
  }
  return scenario.repos.includes(repoId);
}

function invokeScenarioCli(
  scenario: VaguenessScenario,
  projectRoot: string,
  provider: VaguenessProvider,
  cliEntry: string,
): ReturnType<typeof runBabelCli> {
  const argv = [...scenario.command];
  if (!argv.includes('--project-root')) {
    argv.push('--project-root', projectRoot);
  }
  if (!argv.includes('--provider') && wantsMutationProvider(argv)) {
    const insertAt = argv[0] === 'daily' ? 1 : 0;
    argv.splice(insertAt + 1, 0, '--provider', provider);
  }
  return runBabelCli(argv, {
    projectRoot,
    cliEntry,
    offlineDemo: provider === 'mock',
    env: {
      BABEL_DAILY_PROFILE: 'terminal',
    },
  });
}

function emptyTierTotals(): Record<VaguenessTier, { pass: number; fail: number; skip: number }> {
  return {
    L1_minimal: { pass: 0, fail: 0, skip: 0 },
    L2_intent: { pass: 0, fail: 0, skip: 0 },
    L3_scope: { pass: 0, fail: 0, skip: 0 },
    L4_followup: { pass: 0, fail: 0, skip: 0 },
  };
}

function incrementScenarioTotal(
  bucket: { pass: number; fail: number; skip: number },
  status: VaguenessScenarioStatus,
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

function computeMetrics(results: VaguenessScenarioResult[]): VaguenessBenchmarkMetrics {
  const executed = results.filter((entry) => entry.status !== 'skip');
  const denom = executed.length || 1;

  const deepEscalations = executed.filter((entry) => entry.selected_lane === 'deep_lane').length;
  const readOnlyMutations = executed.filter((entry) =>
    entry.checks.some((check) => check.id === 'read_only_ok' && !check.pass),
  ).length;
  const toolExplorations = executed.filter(
    (entry) => entry.tool_call_count >= 1 || entry.session_loop_step_count >= 1,
  ).length;
  const blockedClarifications = executed.filter(
    (entry) => entry.reported_status === 'NEEDS_MORE_CONTEXT',
  ).length;
  const laneMatches = executed.filter((entry) =>
    entry.checks.some((check) => check.id === 'lane_ok' && check.pass),
  ).length;
  const statusOk = executed.filter((entry) =>
    entry.checks.some((check) => check.id === 'status_ok' && check.pass),
  ).length;

  return {
    deep_escalation_rate: deepEscalations / denom,
    false_mutation_rate: readOnlyMutations / denom,
    tool_exploration_rate: toolExplorations / denom,
    blocked_clarification_rate: blockedClarifications / denom,
    lane_match_rate: laneMatches / denom,
    status_ok_rate: statusOk / denom,
  };
}

export function runVaguenessBenchmark(
  options: VaguenessBenchmarkOptions = {},
): VaguenessBenchmarkReport {
  const provider = options.provider ?? 'mock';
  const minPassRate = options.minPassRate ?? (provider === 'mock' ? 0.85 : 0.7);
  const scenariosManifest = readVaguenessScenarios(options.scenariosPath);
  const repoTargets = resolveRepoTargets(options);
  const cliEntry = options.cliEntry ?? resolveBabelCliEntry();
  const timestamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '');
  const evidenceDir = resolve(
    options.evidenceDir ?? join(BABEL_RUNS_DIR, 'vagueness-benchmark', timestamp),
  );
  mkdirSync(evidenceDir, { recursive: true });

  const results: VaguenessScenarioResult[] = [];
  const tierTotals = emptyTierTotals();
  const repoTotals: Record<string, { pass: number; fail: number; skip: number }> = {};
  let seededRoot: string | null = null;

  try {
    for (const repoTarget of repoTargets) {
      const repoKey = repoTarget.repoId ?? 'project_root';
      repoTotals[repoKey] ??= { pass: 0, fail: 0, skip: 0 };

      if (!existsSync(repoTarget.projectRoot)) {
        for (const scenario of scenariosManifest.scenarios) {
          if (!scenarioAppliesToRepo(scenario, repoTarget.repoId)) {
            continue;
          }
          if (scenario.target === 'seeded') {
            continue;
          }
          const skipResult: VaguenessScenarioResult = {
            id: scenario.id,
            tier: scenario.tier,
            category: scenario.category,
            repo_id: repoTarget.repoId,
            project_root: repoTarget.projectRoot,
            status: 'skip',
            exit_code: 0,
            reported_status: null,
            selected_lane: null,
            run_dir: null,
            latency_ms: 0,
            checks: [],
            tool_call_count: 0,
            session_loop_step_count: 0,
            changed_files: [],
            notes: [`project root missing: ${repoTarget.projectRoot}`],
            stdout_path: '',
            stderr_path: '',
          };
          results.push(skipResult);
          incrementScenarioTotal(tierTotals[scenario.tier], 'skip');
          incrementScenarioTotal(repoTotals[repoKey], 'skip');
        }
        if (repoTarget.required) {
          throw new Error(`Required repo path does not exist: ${repoTarget.projectRoot}`);
        }
        continue;
      }

      for (const scenario of scenariosManifest.scenarios) {
        if (!scenarioAppliesToRepo(scenario, repoTarget.repoId)) {
          continue;
        }

        const projectRoot =
          scenario.target === 'seeded'
            ? (seededRoot ??= prepareSeededRoot())
            : repoTarget.projectRoot;

        const scenarioKey = repoTarget.repoId
          ? `${scenario.id}__${repoTarget.repoId}`
          : scenario.id;
        const scenarioDir = join(evidenceDir, scenarioKey);
        mkdirSync(scenarioDir, { recursive: true });

        const started = performance.now();
        const cli = invokeScenarioCli(scenario, projectRoot, provider, cliEntry);
        const stdoutPath = join(scenarioDir, 'stdout.log');
        const stderrPath = join(scenarioDir, 'stderr.log');
        writeFileSync(stdoutPath, cli.stdout, 'utf-8');
        writeFileSync(stderrPath, cli.stderr, 'utf-8');

        const scored = scoreVaguenessScenario({
          scenario,
          exitCode: cli.exitCode,
          stdout: cli.stdout,
          stderr: cli.stderr,
          payload: cli.payload,
        });

        const result: VaguenessScenarioResult = {
          id: scenarioKey,
          tier: scenario.tier,
          category: scenario.category,
          repo_id: repoTarget.repoId,
          project_root: projectRoot,
          status: scored.pass ? 'pass' : 'fail',
          exit_code: cli.exitCode,
          reported_status: scored.reportedStatus,
          selected_lane: scored.selectedLane,
          run_dir: scored.runDir,
          latency_ms: Math.round(performance.now() - started),
          checks: scored.checks,
          tool_call_count: scored.artifacts.toolCallCount,
          session_loop_step_count: scored.artifacts.sessionLoopStepCount,
          changed_files: scored.artifacts.changedFiles,
          notes: [scenario.description],
          stdout_path: stdoutPath,
          stderr_path: stderrPath,
        };
        results.push(result);
        incrementScenarioTotal(tierTotals[scenario.tier], result.status);
        incrementScenarioTotal(repoTotals[repoKey], result.status);
      }
    }
  } finally {
    if (seededRoot) {
      rmSync(seededRoot, { recursive: true, force: true });
    }
  }

  const pass = results.filter((entry) => entry.status === 'pass').length;
  const fail = results.filter((entry) => entry.status === 'fail').length;
  const skip = results.filter((entry) => entry.status === 'skip').length;
  const executed = results.length - skip;
  const passRate = executed > 0 ? pass / executed : 0;
  const criticalFails = results.filter(
    (entry) =>
      entry.status === 'fail' &&
      (entry.reported_status === 'EXECUTOR_HALTED' ||
        entry.checks.some((check) => check.id === 'read_only_ok' && !check.pass)),
  ).length;
  const gatePassed = passRate >= minPassRate && (provider === 'live' || criticalFails === 0);

  return {
    schema_version: 1,
    report_type: 'babel_vagueness_benchmark',
    generated_at: new Date().toISOString(),
    provider,
    daily_profile: 'terminal',
    evidence_dir: evidenceDir,
    workspace_root: options.projectRoot
      ? null
      : resolve(
          options.workspaceRoot ?? readVaguenessRepos(options.repoManifestPath).workspace_root,
        ),
    project_root: options.projectRoot ? resolve(options.projectRoot) : null,
    min_pass_rate: minPassRate,
    gate_passed: gatePassed,
    totals: {
      pass,
      fail,
      skip,
      executed,
      pass_rate: passRate,
      by_tier: tierTotals,
      by_repo: repoTotals,
    },
    metrics: computeMetrics(results),
    scenarios: results,
  };
}
