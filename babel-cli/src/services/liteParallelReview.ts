import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSession } from '../agent/session.js';
import {
  applyLiteOfflineEnv,
  restoreLiteOfflineEnv,
  snapshotLiteOfflineEnv,
} from '../agent/provider/textProviderLane.js';
import {
  readLiteTrustDemoFixture,
  resolveLiteTrustDemoFixturePath,
} from './liteTrustDemo.js';
import { inferDoExecutionVerb, routeLiteOrFull, shouldSpawnSparkReview } from './liteFullRouter.js';

export interface LiteParallelReviewScenario {
  id: string;
  task: string;
  expected_route_lane: 'babel_full';
  expected_execution_verb: 'plan' | 'fix' | 'ask' | 'patch';
  expects_spark_review: boolean;
  mutation_policy: 'read_only' | 'may_edit';
  repo_fixture: 'minimal_plan_repo' | 'trust_demo_math';
  provider?: 'mock';
}

export interface LiteParallelReviewScenarioResult {
  id: string;
  status: 'pass' | 'fail';
  detail: string;
  route_lane?: string;
  execution_verb?: string;
  spark_agent_count?: number;
  synthesis_present?: boolean;
  reviewers_read_only?: boolean;
}

export interface LiteParallelReviewHarnessResult {
  fixture_type: 'babel_lite_parallel_review';
  status: 'pass' | 'fail';
  scenarios: LiteParallelReviewScenarioResult[];
}

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lite-parallel-review',
  'scenarios.json',
);

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'babel-lite',
    GIT_AUTHOR_EMAIL: 'babel-lite@local',
    GIT_COMMITTER_NAME: 'babel-lite',
    GIT_COMMITTER_EMAIL: 'babel-lite@local',
  };
}

function initGitRepo(root: string): void {
  const init = spawnSync('git', ['init'], { cwd: root, encoding: 'utf-8' });
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr || init.stdout || 'unknown error'}`);
  }
  const add = spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf-8', env: gitEnv() });
  if (add.status !== 0) {
    throw new Error(`git add failed: ${add.stderr || add.stdout || 'unknown error'}`);
  }
  const commit = spawnSync('git', ['commit', '-m', 'babel-lite-parallel-review'], {
    cwd: root,
    encoding: 'utf-8',
    env: gitEnv(),
  });
  if (commit.status !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout || 'unknown error'}`);
  }
}

function writeMinimalPlanRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Auth module\n\nMigration target.\n', 'utf-8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'auth-module-fixture',
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2), 'utf-8');
  initGitRepo(root);
}

function writeTrustDemoMathRepo(root: string): void {
  const fixture = readLiteTrustDemoFixture(resolveLiteTrustDemoFixturePath());
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node src/math.test.js' },
  }, null, 2), 'utf-8');
  writeFileSync(join(root, fixture.target_file), fixture.broken_implementation, 'utf-8');
  writeFileSync(join(root, 'src', 'math.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './math.js';",
    '',
    "test('add sums two numbers', () => {",
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'), 'utf-8');
  initGitRepo(root);
}

export function readLiteParallelReviewScenarios(
  fixturePath: string = FIXTURE_PATH,
): LiteParallelReviewScenario[] {
  const parsed = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
    scenarios: LiteParallelReviewScenario[];
  };
  return parsed.scenarios;
}

export function resolveLiteParallelReviewFixturePath(): string {
  return FIXTURE_PATH;
}

function prepareRepo(root: string, fixture: LiteParallelReviewScenario['repo_fixture']): void {
  if (fixture === 'minimal_plan_repo') {
    writeMinimalPlanRepo(root);
    return;
  }
  writeTrustDemoMathRepo(root);
}

export async function runLiteParallelReviewScenario(
  scenario: LiteParallelReviewScenario,
  options: { projectRoot: string },
): Promise<LiteParallelReviewScenarioResult> {
  const routeDecision = routeLiteOrFull(scenario.task, { requestedVerb: 'do' });
  const spawnSpark = shouldSpawnSparkReview(routeDecision, { requestedVerb: 'do', agentsMode: 'read-only' });
  const inferredVerb = inferDoExecutionVerb(scenario.task);

  if (routeDecision.selected_lane !== scenario.expected_route_lane) {
    return {
      id: scenario.id,
      status: 'fail',
      detail: `Expected route lane ${scenario.expected_route_lane}; got ${routeDecision.selected_lane}.`,
      route_lane: routeDecision.selected_lane,
    };
  }
  if (inferredVerb !== scenario.expected_execution_verb) {
    return {
      id: scenario.id,
      status: 'fail',
      detail: `Expected execution verb ${scenario.expected_execution_verb}; got ${inferredVerb}.`,
      execution_verb: inferredVerb,
    };
  }
  if (spawnSpark !== scenario.expects_spark_review) {
    return {
      id: scenario.id,
      status: 'fail',
      detail: `Expected spark review=${String(scenario.expects_spark_review)}; got ${String(spawnSpark)}.`,
    };
  }

  const session = new AgentSession({
    task: scenario.task,
    verb: 'do',
    projectRoot: options.projectRoot,
    ...(scenario.provider !== undefined ? { provider: scenario.provider } : {}),
    agentsMode: 'read-only',
  });
  const offlineEnvSnapshot = snapshotLiteOfflineEnv();
  if (scenario.provider === 'mock') {
    applyLiteOfflineEnv('mock');
  }
  let result;
  try {
    result = await session.run();
  } finally {
    restoreLiteOfflineEnv(offlineEnvSnapshot);
  }
  const payload = result.payload as Record<string, unknown>;
  const sparkAgents = Array.isArray(payload['spark_agents']) ? payload['spark_agents'] : [];
  const synthesis = payload['spark_synthesis'];
  const reviewersReadOnly = sparkAgents.length === 0 ||
    sparkAgents.every(agent =>
      typeof agent === 'object' &&
      agent !== null &&
      (agent as { mode?: string }).mode === 'read_only',
    );

  let passed = result.exitCode === 0 || (scenario.mutation_policy === 'read_only' && result.exitCode === 0);
  let detail = `exit=${result.exitCode}, status=${String(payload['status'])}`;

  if (scenario.expects_spark_review) {
    passed = passed &&
      sparkAgents.length >= 4 &&
      synthesis !== undefined &&
      reviewersReadOnly &&
      payload['execution_path'] === 'spark_parallel_review_do';
    detail = passed
      ? `Spark parallel review fed ${scenario.expected_execution_verb} lane (${sparkAgents.length} reviewers, synthesis present).`
      : `Expected spark parallel review metadata; agents=${sparkAgents.length}, synthesis=${synthesis !== undefined}, path=${String(payload['execution_path'])}.`;
  }

  if (scenario.mutation_policy === 'may_edit' && scenario.expected_execution_verb === 'fix') {
    passed = passed && (payload['status'] === 'DO_COMPLETE' || payload['status'] === 'FIX_COMPLETE');
    if (!passed) {
      detail = `Expected fix completion after spark review; got status=${String(payload['status'])}.`;
    }
  }

  if (scenario.mutation_policy === 'read_only' && scenario.expected_execution_verb === 'plan') {
    passed = passed && payload['status'] === 'PLAN_READY';
    if (!passed) {
      detail = `Expected PLAN_READY after spark review; got status=${String(payload['status'])}.`;
    }
    const runDir = typeof payload['run_dir'] === 'string' ? payload['run_dir'] : null;
    if (passed && runDir) {
      const synthesisArtifact = join(runDir, 'spark_synthesis.json');
      passed = existsSync(synthesisArtifact);
      if (!passed) {
        detail = `Expected spark_synthesis.json in plan run dir; missing at ${synthesisArtifact}.`;
      }
    }
  }

  return {
    id: scenario.id,
    status: passed ? 'pass' : 'fail',
    detail,
    route_lane: routeDecision.selected_lane,
    execution_verb: inferredVerb,
    spark_agent_count: sparkAgents.length,
    synthesis_present: synthesis !== undefined,
    reviewers_read_only: reviewersReadOnly,
  };
}

export async function runLiteParallelReviewHarness(
  options: { fixturePath?: string } = {},
): Promise<LiteParallelReviewHarnessResult> {
  const scenarios = readLiteParallelReviewScenarios(options.fixturePath ?? FIXTURE_PATH);
  const results: LiteParallelReviewScenarioResult[] = [];

  for (const scenario of scenarios) {
    const root = mkdtempSync(join(tmpdir(), 'babel-lite-parallel-review-'));
    try {
      prepareRepo(root, scenario.repo_fixture);
      results.push(await runLiteParallelReviewScenario(scenario, { projectRoot: root }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  return {
    fixture_type: 'babel_lite_parallel_review',
    status: results.every(result => result.status === 'pass') ? 'pass' : 'fail',
    scenarios: results,
  };
}
