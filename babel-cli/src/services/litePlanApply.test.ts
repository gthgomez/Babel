import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { collectPlanHandoffViolations, loadPlanHandoff } from '../agent/planHandoff.js';
import { splitChainedShellSteps } from '../pipeline/executorPlanNormalize.js';
import { detectSmallFix } from './smallFix.js';
import { routeLiteOrFull } from './liteFullRouter.js';

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'lite-plan-apply',
);
const scenario = JSON.parse(readFileSync(join(fixtureDir, 'scenario.json'), 'utf-8')) as {
  plan_run_id: string;
  source_file: string;
  test_file: string;
  hallucinated_file: string;
  verifier_command: string;
  task: string;
};

test('lite-plan-apply fixture routes routine babel-cli maintenance to lite_fix', () => {
  const decision = routeLiteOrFull(scenario.task, { requestedVerb: 'fix' });
  assert.equal(decision.selected_lane, 'lite_fix');
  assert.equal(
    decision.risk_signals.some((signal) => signal.code === 'protected_babel_control_plane'),
    false,
  );
});

test('lite-plan-apply fixture detects dual-file scoped small fix', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const detected = detectSmallFix({
    projectRoot: repoRoot,
    task: scenario.task,
  });

  assert.ok(detected);
  assert.equal(detected?.mode, 'dual');
  if (detected?.mode === 'dual') {
    assert.equal(detected.sourceFile, scenario.source_file);
    assert.equal(detected.testFile, scenario.test_file);
    assert.equal(detected.verifierCommand, scenario.verifier_command);
  }
});

test('lite-plan-apply fixture rejects hallucinated planner paths outside plan contract', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-lite-plan-apply-'));
  const planRunDir = join(root, 'runs', 'babel-lite', scenario.plan_run_id);
  try {
    mkdirSync(planRunDir, { recursive: true });
    mkdirSync(join(root, 'babel-cli', 'src', 'pipeline'), { recursive: true });
    mkdirSync(join(root, 'babel-cli', 'src', 'evidence'), { recursive: true });
    writeFileSync(join(root, scenario.source_file), 'export {};\n', 'utf-8');
    writeFileSync(join(root, scenario.test_file), "import test from 'node:test';\n", 'utf-8');
    writeFileSync(
      join(planRunDir, 'contract.json'),
      JSON.stringify({
        schema_version: 1,
        likely_files: [scenario.source_file, scenario.test_file],
        required_reads: [scenario.source_file],
      }),
      'utf-8',
    );
    writeFileSync(
      join(planRunDir, 'model_plan.json'),
      JSON.stringify({
        schema_version: 1,
        summary: 'Repair stale latest pointers',
      }),
      'utf-8',
    );

    const handoff = loadPlanHandoff({
      repoPath: root,
      task: scenario.task,
      planRunId: scenario.plan_run_id,
    });
    assert.ok(handoff);

    const splitPlan = splitChainedShellSteps({
      plan_version: '1.0',
      plan_type: 'IMPLEMENTATION_PLAN',
      thinking: 'noop',
      task_summary: 'OBJECTIVE: stale pointer repair',
      known_facts: [],
      assumptions: [],
      risks: [],
      root_cause: 'N/A',
      out_of_scope: [],
      minimal_action_set: [
        {
          step: 1,
          tool: 'file_write',
          target: scenario.hallucinated_file,
          description: 'hallucinated path',
          rationale: 'bad path',
          reversible: true,
          verification: 'file_write succeeds',
        },
        {
          step: 2,
          tool: 'test_run',
          target: 'npm --prefix ./babel-cli run typecheck && npx jest',
          description: 'chained verifier',
          rationale: 'verify',
          reversible: true,
          verification: 'commands exit 0',
        },
      ],
    });

    assert.equal(splitPlan.minimal_action_set.length, 3);
    assert.equal(splitPlan.minimal_action_set[1]?.target, 'npm --prefix ./babel-cli run typecheck');
    assert.equal(splitPlan.minimal_action_set[2]?.target, 'npx jest');
    assert.ok(handoff?.allowedPaths.includes(scenario.source_file));
    assert.ok(!handoff?.allowedPaths.includes(scenario.hallucinated_file));
    assert.equal(collectPlanHandoffViolations(splitPlan, handoff?.allowedPaths ?? []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
