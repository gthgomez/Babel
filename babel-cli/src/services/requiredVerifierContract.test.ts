import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVerifierContractArtifacts,
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

for (const tool of ['file_write', 'shell_exec'] as const) for (const postWrite of [false, true]) {
  test(`Chat verification ${postWrite ? 'accepts' : 'rejects'} a required verifier ${postWrite ? 'after' : 'before'} the final ${tool}`, () => {
    const write: ToolCallLog = { step: 2, tool, target: tool === 'file_write' ? 'math.mjs' : 'node update.mjs', exit_code: 0, stdout: 'written', stderr: '', verified: true }
    const log = postWrite ? [write, command('node --test math.test.mjs', 0, 3)] : [command('node --test math.test.mjs', 0, 1), write]
    const artifacts = buildVerifierContractArtifacts({
      task: 'Update math.mjs. Run node --test math.test.mjs before completing.',
      toolCallLog: log, runDir: 'unused', requirePostMutationVerification: true,
    })
    assert.equal(artifacts.summary.requiredVerifierCount, 1)
    assert.equal(artifacts.summary.verifierCompletionSatisfied, postWrite)
    assert.equal(artifacts.summary.completionBlockingStatus, postWrite ? null : 'REQUIRED_VERIFIER_MISSING')
  })
}

test('legacy verifier reconciliation keeps its default ordering contract', () => {
  const artifacts = buildVerifierContractArtifacts({
    task: 'Run npm test before completing.', runDir: 'unused',
    toolCallLog: [command('npm test', 0), { step: 2, tool: 'file_write', target: 'math.mjs', exit_code: 0, stdout: 'written', stderr: '', verified: true }],
  })
  assert.equal(artifacts.summary.verifierCompletionSatisfied, true)
})

test('Chat records a failing post-mutation required verifier as failure', () => {
  const artifacts = buildVerifierContractArtifacts({
    task: 'Run npm test before completing.', runDir: 'unused', requirePostMutationVerification: true,
    toolCallLog: [{ step: 1, tool: 'file_write', target: 'math.mjs', exit_code: 0, stdout: 'written', stderr: '', verified: true }, command('npm test', 1, 2)],
  })
  assert.equal(artifacts.summary.verifierCompletionSatisfied, false)
  assert.equal(artifacts.summary.completionBlockingStatus, 'REQUIRED_VERIFIER_FAILED')
})

test('a final read-only git observation does not invalidate current Chat verification', () => {
  const artifacts = buildVerifierContractArtifacts({
    task: 'Run npm test before completing.', runDir: 'unused', requirePostMutationVerification: true,
    toolCallLog: [command('npm test', 0), { step: 2, tool: 'shell_exec', target: 'git diff --stat', exit_code: 0, stdout: '', stderr: '', verified: true }],
  })
  assert.equal(artifacts.summary.verifierCompletionSatisfied, true)
})

test('verifier plan creation extracts declared required commands', () => {
  const plan = buildVerifierPlan(
    'Verifier commands: npm run typecheck && npm test -- --run src/a.test.ts && npm run build',
  );

  assert.deepEqual(
    plan.map((item) => item.command),
    ['npm run typecheck', 'npm test -- --run src/a.test.ts', 'npm run build'],
  );
  assert.equal(
    plan.every((item) => item.required),
    true,
  );
  assert.equal(plan[0]?.source, 'user_required');
});

test('verifier plan creation extracts inline labeled commands from app tasks', () => {
  const plan = buildVerifierPlan(
    'AWEH-009. Verifier commands: npm run typecheck && npm test -- --run && npm run build. Expected outcome: component remains unchanged.',
  );

  assert.deepEqual(
    plan.map((item) => item.command),
    ['npm run typecheck', 'npm test -- --run', 'npm run build'],
  );
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

test('required verifier command-path matrix supports parsed aliases and exact unknown-option commands', () => {
  const plan = buildVerifierPlan(
    'Verifier commands: npm run build && npm test && node --test && tsc -b && vitest run && jest',
  );
  const reconciled = reconcileVerifierPlan(plan, [
    command('./node_modules/.bin/npm run build', 0),
    command('"/usr/bin/npm" test', 0),
    command('"/usr/bin/node" --test', 0),
    command('tsc -b', 0),
    command('"C:/tmp/vitest" run', 0),
    command('/usr/local/bin/jest', 0),
  ]);
  const summary = summarizeVerifierContract(reconciled);

  assert.equal(summary.requiredVerifierCount, 6);
  assert.deepEqual(
    reconciled.map((entry) => entry.state),
    ['passed', 'passed', 'passed', 'passed', 'passed', 'passed'],
  );
  assert.equal(summary.verifierCompletionSatisfied, true);
  assert.equal(summary.completionBlockingStatus, null);
});

test('command-path variants from plan and execution dedupe identical verifier keys', () => {
  const plan = buildVerifierPlan(
    'Verifier commands: npm test && ./node_modules/.bin/npm run test && npm test',
  );

  // Structural identity: npm test and path-prefixed npm run test share npm-test#full.
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.command, 'npm test');
});

test('verifier plan creation trims human cwd phrase from command text', () => {
  const plan = buildVerifierPlan(
    'The Node project is in app. Run npm test from app before completing.',
  );

  assert.deepEqual(
    plan.map((item) => item.command),
    ['npm test'],
  );
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
  assert.deepEqual(
    reconciled[0]?.executionHistory.map((item) => [item.step, item.state, item.selected]),
    [
      [3, 'failed', false],
      [5, 'passed', true],
    ],
  );
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
  const plan = buildVerifierPlan(
    'Verifier commands: npm run typecheck && npm test && npm run build',
  );
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
  assert.equal(
    summary.verifiers.find((item) => item.command === 'npm run lint')?.state,
    'skipped_optional',
  );
});

test('no required verifier reports explicit zero count', () => {
  const summary = summarizeVerifierContract(
    reconcileVerifierPlan(buildVerifierPlan('Create a file.'), []),
  );

  assert.equal(summary.requiredVerifierCount, 0);
  assert.equal(summary.verifierCompletionSatisfied, true);
});

test('buildVerifierPlan merges additional required verifiers from scope resolution', () => {
  const plan = buildVerifierPlan('Fix src/math.js only.', ['npm test']);
  assert.deepEqual(
    plan.map((item) => item.command),
    ['npm test'],
  );
  assert.equal(plan[0]?.source, 'user_required');
});

test('targeted run does not satisfy full-suite required verifier', () => {
  const plan = buildVerifierPlan('Run npm test before completing.');
  const summary = summarizeVerifierContract(
    reconcileVerifierPlan(plan, [command('npm test -- src/add.test.ts', 0)]),
  );

  assert.equal(summary.verifierCompletionSatisfied, false);
  assert.equal(summary.completionBlockingStatus, 'REQUIRED_VERIFIER_MISSING');
  assert.deepEqual(summary.missingRequiredVerifiers, ['npm test']);
});

test('full suite satisfies targeted required verifier (directional coverage)', () => {
  const plan = buildVerifierPlan(
    'Verifier commands: npm test -- --run src/add.test.ts',
  );
  const summary = summarizeVerifierContract(
    reconcileVerifierPlan(plan, [command('npm test', 0)]),
  );

  assert.equal(summary.verifierCompletionSatisfied, true);
  assert.equal(summary.completionBlockingStatus, null);
  assert.equal(summary.verifiers[0]?.state, 'passed');
});

test('full and targeted npm test remain distinct plan entries', () => {
  const plan = buildVerifierPlan(
    'Verifier commands: npm test && npm test -- src/a.test.ts',
  );
  assert.equal(plan.length, 2);
  assert.equal(plan[0]?.command, 'npm test');
  assert.equal(plan[1]?.command, 'npm test -- src/a.test.ts');
});

test('buildVerifierContractArtifacts honors additional required verifiers', () => {
  const artifacts = buildVerifierContractArtifacts({
    task: 'Fix src/math.js only.',
    toolCallLog: [command('npm test', 0)],
    runDir: '/tmp/run',
    additionalRequiredVerifiers: ['npm test'],
  });
  assert.equal(artifacts.summary.verifierCompletionSatisfied, true);
  assert.equal(artifacts.summary.requiredVerifierCount, 1);
});

// Execution argv parsing is platform-specific; unknown flags need exact identity.
test('platform paths and unknown-option aliases retain strict execution identity', () => {
  const summarize = (required: string, actual: string) => summarizeVerifierContract(
    reconcileVerifierPlan(buildVerifierPlan(`Verifier commands: ${required}`), [command(actual, 0)]),
  ).verifierCompletionSatisfied;
  assert.equal(summarize('npm run build', '.\\node_modules\\.bin\\npm run build'), process.platform === 'win32');
  assert.equal(summarize('tsc -b', '/opt/homebrew/bin/tsc -b'), false);
});
