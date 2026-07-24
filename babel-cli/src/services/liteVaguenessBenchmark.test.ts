import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readVaguenessRepos,
  readVaguenessScenarios,
  runVaguenessBenchmark,
  scoreVaguenessScenario,
} from './liteVaguenessBenchmark.js';

test('vagueness fixtures load with expected schema', () => {
  const scenarios = readVaguenessScenarios();
  const repos = readVaguenessRepos();
  assert.equal(scenarios.fixture_type, 'babel_vagueness_scenarios');
  assert.equal(repos.fixture_type, 'babel_vagueness_repos');
  assert.ok(scenarios.scenarios.length >= 18);
  assert.ok(repos.repos.some((repo) => repo.id === 'babel_core'));
});

test('scoreVaguenessScenario accepts blocked clarification for vague L3 tasks', () => {
  const scenario = readVaguenessScenarios().scenarios.find(
    (entry) => entry.id === 'l3_plan_next_features',
  );
  assert.ok(scenario);
  const scored = scoreVaguenessScenario({
    scenario,
    exitCode: 0,
    stdout: JSON.stringify({ status: 'NEEDS_MORE_CONTEXT', selected_lane: 'lite_plan' }),
    stderr: '',
    payload: {
      status: 'NEEDS_MORE_CONTEXT',
      selected_lane: 'lite_plan',
      changed_files: [],
    },
  });
  assert.equal(scored.pass, true);
  assert.ok(scored.checks.find((check) => check.id === 'status_ok')?.pass);
});

test('scoreVaguenessScenario fails read-only mutation and schema failures', () => {
  const scenario = readVaguenessScenarios().scenarios.find(
    (entry) => entry.id === 'l1_what_is_project',
  );
  assert.ok(scenario);
  const mutation = scoreVaguenessScenario({
    scenario,
    exitCode: 0,
    stdout: '',
    stderr: '',
    payload: {
      status: 'ANSWER_READY',
      selected_lane: 'lite_ask',
      changed_files: ['src/example.ts'],
    },
  });
  assert.equal(mutation.pass, false);
  assert.equal(mutation.checks.find((check) => check.id === 'read_only_ok')?.pass, false);

  const schema = scoreVaguenessScenario({
    scenario,
    exitCode: 1,
    stdout: 'Zod validation failed for answer payload',
    stderr: '',
    payload: { status: 'LITE_SCHEMA_FAILED', selected_lane: 'lite_ask', changed_files: [] },
  });
  assert.equal(schema.pass, false);
  assert.equal(schema.checks.find((check) => check.id === 'no_anti_status')?.pass, false);
});

test('scoreVaguenessScenario requires tool exploration when expect_tools is set', () => {
  const scenario = readVaguenessScenarios().scenarios.find(
    (entry) => entry.id === 'l3_where_routing_defined',
  );
  assert.ok(scenario);
  const withoutTools = scoreVaguenessScenario({
    scenario,
    exitCode: 0,
    stdout: '',
    stderr: '',
    payload: {
      status: 'ANSWER_READY',
      selected_lane: 'lite_ask',
      changed_files: [],
    },
  });
  assert.equal(withoutTools.pass, false);

  const withTools = scoreVaguenessScenario({
    scenario,
    exitCode: 0,
    stdout: '',
    stderr: '',
    payload: {
      status: 'ANSWER_READY',
      selected_lane: 'lite_ask',
      changed_files: [],
      tool_call_log: [{ step: 1, tool: 'grep', target: 'fix lane', exit_code: 0 }],
    },
  });
  assert.equal(withTools.pass, true);
});

test.skip(
  'runVaguenessBenchmark executes mock seeded fix scenario offline',
  { concurrency: false },
  () => {
    // SKIP: functionality consolidated into chat mode — 'daily' command removed
    const scenariosPath = mkdtempSync(join(tmpdir(), 'babel-vagueness-scenarios-'));
    const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-vagueness-evidence-'));
    try {
      writeFileSync(
        join(scenariosPath, 'scenarios.json'),
        JSON.stringify(
          {
            schema_version: 1,
            fixture_type: 'babel_vagueness_scenarios',
            scenarios: [
              {
                id: 'mock_fix_only',
                tier: 'L2_intent',
                category: 'fix',
                description: 'offline seeded fix',
                target: 'seeded',
                command: ['daily', '--json', 'fix failing tests'],
                acceptable_statuses: ['FIX_COMPLETE', 'SMALL_FIX_COMPLETE', 'DO_COMPLETE'],
                expect_lane: 'lite_fix',
                read_only: false,
              },
            ],
          },
          null,
          2,
        ),
        'utf-8',
      );

      const report = runVaguenessBenchmark({
        provider: 'mock',
        projectRoot: process.cwd(),
        scenariosPath: join(scenariosPath, 'scenarios.json'),
        evidenceDir,
        minPassRate: 1,
      });

      assert.equal(report.totals.executed, 1);
      assert.equal(report.scenarios[0]?.status, 'pass');
      assert.ok(
        ['FIX_COMPLETE', 'SMALL_FIX_COMPLETE', 'DO_COMPLETE'].includes(
          report.scenarios[0]?.reported_status ?? '',
        ),
      );
    } finally {
      rmSync(scenariosPath, { recursive: true, force: true });
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  },
);

test('runVaguenessBenchmark skips optional missing repos without failing gate', () => {
  const manifestDir = mkdtempSync(join(tmpdir(), 'babel-vagueness-repos-'));
  const scenariosPath = mkdtempSync(join(tmpdir(), 'babel-vagueness-scenarios-'));
  const evidenceDir = mkdtempSync(join(tmpdir(), 'babel-vagueness-evidence-'));
  try {
    mkdirSync(join(manifestDir, 'nested'), { recursive: true });
    writeFileSync(
      join(manifestDir, 'repos.json'),
      JSON.stringify(
        {
          schema_version: 1,
          fixture_type: 'babel_vagueness_repos',
          workspace_root: manifestDir,
          repos: [
            {
              id: 'missing_optional',
              path: 'nested\\does-not-exist',
              required: false,
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );
    writeFileSync(
      join(scenariosPath, 'scenarios.json'),
      JSON.stringify(
        {
          schema_version: 1,
          fixture_type: 'babel_vagueness_scenarios',
          scenarios: [
            {
              id: 'skip_probe',
              tier: 'L1_minimal',
              category: 'ask',
              description: 'skip when repo missing',
              target: 'repo',
              command: ['daily', '--json', 'what is this project?'],
              acceptable_statuses: ['ANSWER_READY'],
              read_only: true,
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const report = runVaguenessBenchmark({
      provider: 'mock',
      repoManifestPath: join(manifestDir, 'repos.json'),
      scenariosPath: join(scenariosPath, 'scenarios.json'),
      evidenceDir,
      minPassRate: 0,
    });

    assert.equal(report.totals.skip, 1);
    assert.equal(report.totals.executed, 0);
    assert.equal(report.gate_passed, true);
  } finally {
    rmSync(manifestDir, { recursive: true, force: true });
    rmSync(scenariosPath, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});
