import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVerifierPlan,
  reconcileVerifierPlan,
  summarizeVerifierContract,
} from './requiredVerifierContract.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

function command(command: string, exitCode: number, step = 1): ToolCallLog {
  return {
    step,
    tool: 'test_run',
    target: command,
    exit_code: exitCode,
    stdout: exitCode === 0 ? 'ok' : 'not ok',
    stderr: exitCode === 0 ? '' : 'AssertionError',
    verified: exitCode === 0,
  };
}

test('verifier plan creation extracts declared required commands', () => {
  const plan = buildVerifierPlan('Verifier commands: npm run typecheck && npm test -- --run src/a.test.ts && npm run build');

  assert.deepEqual(plan.map(item => item.command), [
    'npm run typecheck',
    'npm test -- --run src/a.test.ts',
    'npm run build',
  ]);
  assert.equal(plan.every(item => item.required), true);
  assert.equal(plan[0]?.source, 'user_required');
});

test('verifier plan creation extracts inline labeled commands from app tasks', () => {
  const plan = buildVerifierPlan(
    'AWEH-009. Verifier commands: npm run typecheck && npm test -- --run && npm run build. Expected outcome: component remains unchanged.',
  );

  assert.deepEqual(plan.map(item => item.command), [
    'npm run typecheck',
    'npm test -- --run',
    'npm run build',
  ]);
});

test('verifier command path variants normalize to canonical command keys', () => {
  const plan = buildVerifierPlan('Verifier commands: npm run build && npm test');
  const reconciled = reconcileVerifierPlan(plan, [
    command('/tmp/node_modules/.bin/npm run build', 0),
    command('"C:/Program Files/nodejs/npm" test', 0, 2),
  ]);
  const summary = summarizeVerifierContract(reconciled);

  assert.equal(reconciled[0]?.state, 'passed');
  assert.equal(reconciled[1]?.state, 'passed');
  assert.equal(summary.verifierCompletionSatisfied, true);
  assert.equal(summary.completionBlockingStatus, null);
});

test('required verifier command-path matrix supports common path-encoded executables', () => {
  const plan = buildVerifierPlan(
    'Verifier commands: npm run build && npm test && node --test && tsc -b && vitest run && jest',
  );
  const reconciled = reconcileVerifierPlan(plan, [
    command('.\\node_modules\\.bin\\npm run build', 0),
    command('"/usr/bin/npm" test', 0),
    command('"/usr/bin/node" --test', 0),
    command('/opt/homebrew/bin/tsc -b', 0),
    command('"C:/tmp/vitest" run', 0),
    command('/usr/local/bin/jest', 0),
  ]);
  const summary = summarizeVerifierContract(reconciled);

  assert.equal(summary.requiredVerifierCount, 6);
  assert.deepEqual(reconciled.map(entry => entry.state), [
    'passed',
    'passed',
    'passed',
    'passed',
    'passed',
    'passed',
  ]);
  assert.equal(summary.verifierCompletionSatisfied, true);
  assert.equal(summary.completionBlockingStatus, null);
});

test('command-path variants from plan and execution dedupe identical verifier keys', () => {
  const plan = buildVerifierPlan('Verifier commands: npm test && ./node_modules/.bin/npm run test && npm test');

  assert.equal(plan.length, 2);
  assert.equal(plan[0]?.command, 'npm test');
  assert.equal(plan[1]?.command, './node_modules/.bin/npm run test');
});

test('verifier plan creation trims human cwd phrase from command text', () => {
  const plan = buildVerifierPlan('The Node project is in app. Run npm test from app before completing.');

  assert.deepEqual(plan.map(item => item.command), ['npm test']);
});

test('required verifier all pass satisfies completion', () => {
  const plan = buildVerifierPlan('Run npm test before completing.');
  const reconciled = reconcileVerifierPlan(plan, [command('npm test', 0)]);
  const summary = summarizeVerifierContract(reconciled);

  assert.equal(reconciled[0]?.state, 'passed');
  assert.equal(summary.verifierCompletionSatisfied, true);
  assert.equal(summary.completionBlockingStatus, null);
});

test('required verifier final pass after prior failure satisfies completion', () => {
  const plan = buildVerifierPlan('Run npm test before completing.');
  const reconciled = reconcileVerifierPlan(plan, [
    command('npm test', 1, 3),
    command('npm test', 0, 5),
  ]);
  const summary = summarizeVerifierContract(reconciled);

  assert.equal(reconciled[0]?.state, 'passed');
  assert.equal(reconciled[0]?.exitCode, 0);
  assert.equal(reconciled[0]?.executionHistory.length, 2);
  assert.deepEqual(reconciled[0]?.executionHistory.map(item => [item.step, item.state, item.selected]), [
    [3, 'failed', false],
    [5, 'passed', true],
  ]);
  assert.equal(summary.verifierCompletionSatisfied, true);
  assert.equal(summary.completionBlockingStatus, null);
});

test('missing required verifier blocks completion', () => {
  const plan = buildVerifierPlan('Run npm test before completing.');
  const summary = summarizeVerifierContract(reconcileVerifierPlan(plan, []));

  assert.equal(summary.verifierCompletionSatisfied, false);
  assert.equal(summary.completionBlockingStatus, 'REQUIRED_VERIFIER_MISSING');
  assert.deepEqual(summary.missingRequiredVerifiers, ['npm test']);
});

test('failed required verifier blocks completion', () => {
  const plan = buildVerifierPlan('Run npm test before completing.');
  const summary = summarizeVerifierContract(reconcileVerifierPlan(plan, [command('npm test', 1)]));

  assert.equal(summary.verifierCompletionSatisfied, false);
  assert.equal(summary.completionBlockingStatus, 'REQUIRED_VERIFIER_FAILED');
  assert.deepEqual(summary.failedRequiredVerifiers, ['npm test']);
});

test('skipped required verifier after prior failure blocks completion', () => {
  const plan = buildVerifierPlan('Verifier commands: npm run typecheck && npm test && npm run build');
  const reconciled = reconcileVerifierPlan(plan, [command('npm run typecheck', 1)]);
  const summary = summarizeVerifierContract(reconciled);

  assert.equal(reconciled[1]?.state, 'skipped_due_to_prior_required_failure');
  assert.equal(reconciled[2]?.state, 'skipped_due_to_prior_required_failure');
  assert.equal(summary.completionBlockingStatus, 'REQUIRED_VERIFIER_SKIPPED');
  assert.deepEqual(summary.skippedRequiredVerifiers, ['npm test', 'npm run build']);
});

test('optional skipped verifier does not block completion', () => {
  const plan = buildVerifierPlan('Run npm test before completing. Run npm run lint if possible.');
  const summary = summarizeVerifierContract(reconcileVerifierPlan(plan, [command('npm test', 0)]));

  assert.equal(summary.requiredVerifierCount, 1);
  assert.equal(summary.requiredVerifierPassedCount, 1);
  assert.equal(summary.verifierCompletionSatisfied, true);
  assert.equal(summary.verifiers.find(item => item.command === 'npm run lint')?.state, 'skipped_optional');
});

test('no required verifier reports explicit zero count', () => {
  const summary = summarizeVerifierContract(reconcileVerifierPlan(buildVerifierPlan('Create a file.'), []));

  assert.equal(summary.requiredVerifierCount, 0);
  assert.equal(summary.verifierCompletionSatisfied, true);
});
