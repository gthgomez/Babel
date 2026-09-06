import assert from 'node:assert/strict';
import test from 'node:test';
import { exactAction, observeClaudeRecovery, RecoveryObservation } from './recovery-observation.js';

test('records exact-action retry and recovery independently of semantic correctness', () => {
  const observation = new RecoveryObservation();
  observation.start('1', 'run_command', 'node --test test.js');
  observation.complete('1', false, 'expected 2; received 3');
  observation.modelFacing('run_command', 'node --test test.js', 'status: error\ndetail:\nexpected 2; received 3');
  observation.start('2', 'edit', 'src/math.js');
  observation.complete('2', true);
  observation.start('3', 'run_command', 'node --test test.js');
  observation.complete('3', true);
  assert.deepEqual(observation.snapshot(), {
    failures: [{ category: 'TOOL_FAILURE', diagnostic: 'expected 2; received 3', action: 'run_command: node --test test.js' }],
    retries: 1, recoverySuccess: true, actionableDiagnostics: true,
  });
});

test('narrower command and different tool cannot count as exact-action recovery', () => {
  const observation = new RecoveryObservation();
  observation.start('1', 'run_command', 'node --test test.js');
  observation.complete('1', false, 'assertion failure');
  observation.start('2', 'run_command', 'node --test --test-name-pattern=passing test.js');
  observation.complete('2', true);
  observation.start('3', 'other_tool', 'node --test test.js');
  observation.complete('3', true);
  assert.equal(observation.snapshot().retries, 0);
  assert.equal(observation.snapshot().recoverySuccess, false);
});

test('missing or truncated model-facing observation never establishes retained diagnostics', () => {
  const observation = new RecoveryObservation();
  assert.equal(observation.snapshot().retries, 'UNKNOWN');
  observation.complete('unmatched', false, 'missing call identity');
  assert.equal(observation.snapshot().failures.length, 0);
  observation.start('1', 'Bash', 'test');
  observation.complete('1', false, 'error: complete actionable detail');
  observation.modelFacing('Bash', 'test', 'error:');
  observation.modelFacing('Bash', 'different action', 'error: complete actionable detail');
  assert.equal(observation.snapshot().actionableDiagnostics, 'UNKNOWN');
});

test('parallel execution before first failure is not a retry and duplicate events do not inflate counts', () => {
  const observation = new RecoveryObservation();
  observation.start('1', 'Bash', 'test');
  observation.start('2', 'Bash', 'test');
  observation.complete('1', false, 'failure');
  observation.complete('2', true);
  assert.equal(observation.snapshot().recoverySuccess, false);
  observation.start('3', 'Bash', 'test');
  observation.start('3', 'Bash', 'test');
  observation.complete('3', true);
  observation.complete('3', false, 'duplicate');
  assert.equal(observation.snapshot().retries, 1);
  assert.equal(observation.snapshot().failures.length, 1);
});

function tool(id: string, command: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } };
}
function result(id: string, isError: boolean): Record<string, unknown> {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'Expected 2 but got 3' : 'passed' }] } };
}

test('Claude correlates stream IDs and requires subsequent assistant evidence for visibility', () => {
  const failed = [tool('a', 'test'), result('a', true)];
  assert.equal(observeClaudeRecovery(failed).actionableDiagnostics, 'UNKNOWN');
  const recovered = observeClaudeRecovery([...failed, tool('b', 'test'), result('b', false)]);
  assert.equal(recovered.retries, 1);
  assert.equal(recovered.recoverySuccess, true);
  assert.equal(recovered.actionableDiagnostics, true);
});

test('unknown completion cannot establish recovery; later failures leave recovery incomplete', () => {
  const observation = new RecoveryObservation();
  observation.start('1', 'Bash', 'test'); observation.complete('1', false, 'failed');
  observation.start('2', 'Bash', 'test'); observation.complete('2', 'UNKNOWN');
  assert.equal(observation.snapshot().recoverySuccess, false);
  observation.start('3', 'Bash', 'test'); observation.complete('3', true);
  observation.start('4', 'Bash', 'test'); observation.complete('4', false, 'failed again');
  assert.equal(observation.snapshot().recoverySuccess, false);
});

test('action identity preserves all parameters with stable object key ordering', () => {
  assert.equal(exactAction({ b: 2, a: 1 }), exactAction({ a: 1, b: 2 }));
  assert.notEqual(exactAction({ command: 'test', timeout: 1 }), exactAction({ command: 'test', timeout: 2 }));
});
