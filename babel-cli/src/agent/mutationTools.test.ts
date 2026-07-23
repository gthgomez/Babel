/**
 * T0.1 / T0.2 — mutation and verifier tool identity helpers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isDirectMutationTool,
  isSuccessfulDirectMutation,
  isVerifierAttemptTool,
  DIRECT_MUTATION_TOOLS,
} from './mutationTools.js';

describe('isDirectMutationTool', () => {
  test('recognizes all direct mutation tools including str_replace', () => {
    for (const tool of DIRECT_MUTATION_TOOLS) {
      assert.equal(isDirectMutationTool(tool), true, tool);
    }
  });

  test('rejects non-mutation tools', () => {
    assert.equal(isDirectMutationTool('read_file'), false);
    assert.equal(isDirectMutationTool('grep'), false);
    assert.equal(isDirectMutationTool('run_command'), false);
    assert.equal(isDirectMutationTool('sub_agent'), false);
  });
});

describe('isSuccessfulDirectMutation', () => {
  test('str_replace success counts', () => {
    assert.equal(isSuccessfulDirectMutation('str_replace'), true);
    assert.equal(isSuccessfulDirectMutation('str_replace', undefined), true);
  });

  test('policy-blocked str_replace does not count', () => {
    assert.equal(isSuccessfulDirectMutation('str_replace', 'blocked'), false);
  });

  test('failed str_replace (anchor miss) does not count', () => {
    assert.equal(
      isSuccessfulDirectMutation('str_replace', 'str_replace: old_str not found'),
      false,
    );
  });
});

describe('isVerifierAttemptTool', () => {
  test('includes run_command used by chat tools', () => {
    assert.equal(isVerifierAttemptTool('run_command'), true);
    assert.equal(isVerifierAttemptTool('test_run'), true);
    assert.equal(isVerifierAttemptTool('shell_exec'), true);
  });

  test('rejects non-verifier tools', () => {
    assert.equal(isVerifierAttemptTool('write_file'), false);
    assert.equal(isVerifierAttemptTool('str_replace'), false);
  });
});
