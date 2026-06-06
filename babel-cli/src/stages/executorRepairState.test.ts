import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRepairState,
  fingerprintToolFailure,
  formatFailureFingerprint,
  recordRepairFailure,
} from './executorRepairState.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

function failedEntry(step: number, stderr: string): ToolCallLog {
  return {
    step,
    tool: 'shell_exec',
    target: 'python eval.py',
    exit_code: 1,
    stdout: '',
    stderr,
    verified: false,
  };
}

function failedEntryWithStdout(step: number, stdout: string): ToolCallLog {
  return {
    step,
    tool: 'shell_exec',
    target: 'python task_file/scripts/optimized_packer.py',
    exit_code: 1,
    stdout,
    stderr: '',
    verified: false,
  };
}

test('repair state fingerprints failing test ids', () => {
  const fingerprint = fingerprintToolFailure(
    failedEntry(4, 'FAILED ../tests/test_outputs.py::test_speedup[10] - AssertionError: too slow'),
  );

  assert.equal(fingerprint.command, 'python eval.py');
  assert.equal(fingerprint.testId, 'test_outputs.py::test_speedup[10]');
  assert.match(fingerprint.stderrSummary, /too slow/);
});

test('repair state requests replan on repeated same failure', () => {
  let state = createRepairState(3);
  let decision = recordRepairFailure(state, failedEntry(4, 'FAILED test_outputs.py::test_speedup[8] slow'));
  state = decision.state;
  decision = recordRepairFailure(state, failedEntry(6, 'FAILED test_outputs.py::test_speedup[8] slow'));

  assert.equal(decision.shouldHalt, false);
  assert.equal(decision.shouldReplan, true);
  assert.equal(decision.state.status, 'same_failure_repeated');
  assert.match(decision.condition ?? '', /Same recoverable failure repeated/);
});

test('repair state halts when budget is exhausted', () => {
  let state = createRepairState(2);
  state = recordRepairFailure(state, failedEntry(4, 'first')).state;
  const decision = recordRepairFailure(state, failedEntry(6, 'second'));

  assert.equal(decision.shouldHalt, true);
  assert.equal(decision.state.status, 'strategy_exhausted');
  assert.match(decision.condition ?? '', /budget exceeded/);
});

test('repair state fingerprint formatter includes stdout when stderr is empty', () => {
  const fingerprint = fingerprintToolFailure(
    failedEntryWithStdout(4, 'Usage: python optimized_packer.py <input_file> <output_file>'),
  );

  assert.match(fingerprint.stdoutSummary, /optimized_packer/);
  assert.match(formatFailureFingerprint(fingerprint), /stdout="Usage: python optimized_packer.py/);
});
