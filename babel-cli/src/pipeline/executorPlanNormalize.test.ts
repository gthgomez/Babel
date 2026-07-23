import assert from 'node:assert/strict';
import test from 'node:test';

import { splitChainedShellSteps, splitShellChain } from './executorPlanNormalize.js';

test('splitShellChain leaves single commands unchanged', () => {
  assert.deepEqual(splitShellChain('npx tsc --noEmit'), ['npx tsc --noEmit']);
});

test('splitShellChain splits chained shell commands on &&', () => {
  assert.deepEqual(splitShellChain('npx tsc --noEmit && npx jest'), [
    'npx tsc --noEmit',
    'npx jest',
  ]);
});

test('splitChainedShellSteps expands chained shell_exec and test_run steps', () => {
  const plan = splitChainedShellSteps({
    plan_version: '1.0',
    plan_type: 'IMPLEMENTATION_PLAN',
    thinking: 'split chained verifier',
    task_summary: 'OBJECTIVE: verify',
    known_facts: [],
    assumptions: [],
    risks: [],
    root_cause: 'N/A',
    out_of_scope: [],
    minimal_action_set: [
      {
        step: 1,
        tool: 'test_run',
        target: 'npx tsc --noEmit && npx jest --runInBand',
        description: 'Run typecheck and tests',
        rationale: 'Verify type safety and tests',
        reversible: true,
        verification: 'commands exit 0',
      },
    ],
  });

  assert.equal(plan.minimal_action_set.length, 2);
  assert.equal(plan.minimal_action_set[0]?.target, 'npx tsc --noEmit');
  assert.equal(plan.minimal_action_set[1]?.target, 'npx jest --runInBand');
});
