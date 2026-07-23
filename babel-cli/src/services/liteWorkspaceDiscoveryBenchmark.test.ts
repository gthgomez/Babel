import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE,
  DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE,
  evaluateWorkspaceDiscoveryGate,
  findContextAnchorHits,
  hasPlanArtifact,
  readWorkspaceDiscoveryRepos,
  readWorkspaceDiscoveryScenarios,
  resolveDiscoveryTaskTemplate,
  scoreWorkspaceDiscoveryCell,
  type WorkspaceDiscoveryMetrics,
} from './liteWorkspaceDiscoveryBenchmark.js';

function baseGateMetrics(
  overrides: Partial<WorkspaceDiscoveryMetrics> = {},
): WorkspaceDiscoveryMetrics {
  return {
    tool_exploration_rate: 1,
    context_anchor_rate: 1,
    grounded_path_rate: 1,
    plan_artifact_rate: 1,
    blocked_clarification_rate: 0,
    deep_escalation_rate: 0,
    false_mutation_rate: 0,
    status_ok_rate: 1,
    ...overrides,
  };
}

test('evaluateWorkspaceDiscoveryGate enforces 90% pass and anchor floors', () => {
  assert.equal(
    evaluateWorkspaceDiscoveryGate({
      passRate: 0.9,
      minPassRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE,
      minContextAnchorRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE,
      metrics: baseGateMetrics(),
      criticalFails: 0,
    }),
    true,
  );

  assert.equal(
    evaluateWorkspaceDiscoveryGate({
      passRate: 0.89,
      minPassRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE,
      minContextAnchorRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE,
      metrics: baseGateMetrics(),
      criticalFails: 0,
    }),
    false,
  );

  assert.equal(
    evaluateWorkspaceDiscoveryGate({
      passRate: 1,
      minPassRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE,
      minContextAnchorRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE,
      metrics: baseGateMetrics({ context_anchor_rate: 0.89 }),
      criticalFails: 0,
    }),
    false,
  );

  assert.equal(
    evaluateWorkspaceDiscoveryGate({
      passRate: 1,
      minPassRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE,
      minContextAnchorRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE,
      metrics: baseGateMetrics({ grounded_path_rate: 0.89 }),
      criticalFails: 0,
    }),
    false,
  );

  assert.equal(
    evaluateWorkspaceDiscoveryGate({
      passRate: 1,
      minPassRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_PASS_RATE,
      minContextAnchorRate: DEFAULT_WORKSPACE_DISCOVERY_MIN_CONTEXT_ANCHOR_RATE,
      metrics: baseGateMetrics({ false_mutation_rate: 0.01 }),
      criticalFails: 0,
    }),
    false,
  );
});

test('workspace discovery fixtures load with 8 repos and 6 scenarios', () => {
  const repos = readWorkspaceDiscoveryRepos();
  const scenarios = readWorkspaceDiscoveryScenarios();
  assert.equal(repos.fixture_type, 'babel_workspace_discovery_repos');
  assert.equal(scenarios.fixture_type, 'babel_workspace_discovery_scenarios');
  assert.equal(repos.repos.length, 8);
  assert.equal(scenarios.scenarios.length, 6);
  assert.equal(scenarios.smoke_repo_ids.length, 4);
});

test('resolveDiscoveryTaskTemplate substitutes slug and display name', () => {
  const repo = readWorkspaceDiscoveryRepos().repos.find((entry) => entry.id === 'relic_run');
  assert.ok(repo);
  const task = resolveDiscoveryTaskTemplate(
    'make a plan for adding new features to {slug} in {display_name}',
    repo,
  );
  assert.match(task, /relicRun/);
  assert.match(task, /Relic Run/);
});

test('findContextAnchorHits detects PROJECT_CONTEXT reads', () => {
  const hits = findContextAnchorHits(
    [
      {
        tool: 'read_file',
        target: '/tmp/example_game_suite/relicRun/PROJECT_CONTEXT.md',
        succeeded: true,
      },
    ],
    '/tmp/example_game_suite/relicRun',
    ['PROJECT_CONTEXT.md', 'package.json'],
  );
  assert.ok(hits.includes('PROJECT_CONTEXT.md'));
});

test('scoreWorkspaceDiscoveryCell ignores policy-blocked out-of-scope tool targets', () => {
  const repo = readWorkspaceDiscoveryRepos().repos.find(
    (entry) => entry.id === 'monte_carlo_ledger',
  );
  const scenario = readWorkspaceDiscoveryScenarios().scenarios.find(
    (entry) => entry.id === 'disc_plan_named_features',
  );
  assert.ok(repo);
  assert.ok(scenario);

  const scored = scoreWorkspaceDiscoveryCell({
    scenario,
    repo,
    projectRoot: '/tmp/example_mobile_suite/example_finance_forecast',
    resolvedTask: 'make a plan for adding new features to example_finance_forecast',
    exitCode: 1,
    stdout: '',
    stderr: '',
    payload: {
      status: 'NEEDS_MORE_CONTEXT',
      selected_lane: 'lite_plan',
      changed_files: [],
      tool_call_log: [
        {
          step: 1,
          tool: 'read_file',
          target: '/tmp/example_mobile_suite/example_finance_forecast/PROJECT_CONTEXT.md',
          exit_code: 0,
          verified: true,
        },
        {
          step: 2,
          tool: 'read_file',
          target: '/tmp/ENGINEERING.md',
          exit_code: 1,
          verified: false,
        },
      ],
    },
  });

  assert.equal(scored.checks.find((check) => check.id === 'grounded_paths_ok')?.pass, true);
});

test('scoreWorkspaceDiscoveryCell fails parent-workspace path leaks', () => {
  const repo = readWorkspaceDiscoveryRepos().repos.find((entry) => entry.id === 'relic_run');
  const scenario = readWorkspaceDiscoveryScenarios().scenarios.find(
    (entry) => entry.id === 'disc_plan_named_features',
  );
  assert.ok(repo);
  assert.ok(scenario);

  const scored = scoreWorkspaceDiscoveryCell({
    scenario,
    repo,
    projectRoot: '/tmp/example_game_suite/relicRun',
    resolvedTask: 'make a plan for adding new features to relicRun',
    exitCode: 0,
    stdout: '',
    stderr: '',
    payload: {
      status: 'PLAN_READY',
      selected_lane: 'lite_plan',
      changed_files: [],
      tool_call_log: [
        {
          step: 1,
          tool: 'read_file',
          target: '/tmp/example_game_suite/package.json',
          exit_code: 0,
        },
        { step: 2, tool: 'grep', target: 'roadmap', exit_code: 0 },
      ],
    },
  });

  assert.equal(scored.checks.find((check) => check.id === 'grounded_paths_ok')?.pass, false);
});

test('scoreWorkspaceDiscoveryCell passes grounded discovery with anchor hit', () => {
  const repo = readWorkspaceDiscoveryRepos().repos.find((entry) => entry.id === 'simlife');
  const scenario = readWorkspaceDiscoveryScenarios().scenarios.find(
    (entry) => entry.id === 'disc_project_identity',
  );
  assert.ok(repo);
  assert.ok(scenario);

  const scored = scoreWorkspaceDiscoveryCell({
    scenario,
    repo,
    projectRoot: '/tmp/example_game_suite/SimLife',
    resolvedTask: 'what is this project?',
    exitCode: 0,
    stdout: '',
    stderr: '',
    payload: {
      status: 'REPORT_READY',
      selected_lane: 'report',
      changed_files: [],
      tool_call_log: [
        {
          step: 1,
          tool: 'read_file',
          target: '/tmp/example_game_suite/SimLife/PROJECT_CONTEXT.md',
          exit_code: 0,
        },
        {
          step: 2,
          tool: 'directory_list',
          target: '/tmp/example_game_suite/SimLife',
          exit_code: 0,
        },
      ],
    },
  });

  assert.equal(scored.pass, true);
  assert.ok(scored.contextAnchorHits.includes('PROJECT_CONTEXT.md'));
});

test('hasPlanArtifact detects non-empty plan.md', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-discovery-plan-'));
  try {
    writeFileSync(join(runDir, 'plan.md'), '# Plan\n- inspect PROJECT_CONTEXT.md\n', 'utf-8');
    assert.equal(hasPlanArtifact(runDir), true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test('scoreWorkspaceDiscoveryCell requires plan artifact for plan scenarios', () => {
  const repo = readWorkspaceDiscoveryRepos().repos.find((entry) => entry.id === 'webrpg');
  const scenario = readWorkspaceDiscoveryScenarios().scenarios.find(
    (entry) => entry.id === 'disc_roadmap_vague',
  );
  assert.ok(repo);
  assert.ok(scenario);

  const runDir = mkdtempSync(join(tmpdir(), 'babel-discovery-run-'));
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, '04_execution_report.json'),
      JSON.stringify({
        status: 'PLAN_READY',
        tool_call_log: [
          {
            step: 1,
            tool: 'read_file',
            target: '/tmp/example_game_suite/WebRPG/PROJECT_CONTEXT.md',
            exit_code: 0,
          },
          { step: 2, tool: 'grep', target: 'roadmap', exit_code: 0 },
        ],
      }),
      'utf-8',
    );

    const scored = scoreWorkspaceDiscoveryCell({
      scenario,
      repo,
      projectRoot: '/tmp/example_game_suite/WebRPG',
      resolvedTask: 'help me plan next features',
      exitCode: 0,
      stdout: '',
      stderr: '',
      payload: {
        status: 'PLAN_READY',
        selected_lane: 'lite_plan',
        run_dir: runDir,
        changed_files: [],
      },
    });

    assert.equal(scored.checks.find((check) => check.id === 'plan_artifact_ok')?.pass, false);
    writeFileSync(join(runDir, 'plan.md'), '# Roadmap\n', 'utf-8');
    const scoredWithPlan = scoreWorkspaceDiscoveryCell({
      scenario,
      repo,
      projectRoot: '/tmp/example_game_suite/WebRPG',
      resolvedTask: 'help me plan next features',
      exitCode: 0,
      stdout: '',
      stderr: '',
      payload: {
        status: 'PLAN_READY',
        selected_lane: 'lite_plan',
        run_dir: runDir,
        changed_files: [],
        tool_call_log: [
          {
            step: 1,
            tool: 'read_file',
            target: '/tmp/example_game_suite/WebRPG/PROJECT_CONTEXT.md',
            exit_code: 0,
          },
          { step: 2, tool: 'grep', target: 'features', exit_code: 0 },
        ],
      },
    });
    assert.equal(
      scoredWithPlan.checks.find((check) => check.id === 'plan_artifact_ok')?.pass,
      true,
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
