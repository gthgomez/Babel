/**
 * Mutation and verifier tool identity helpers.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isDirectMutationTool,
  assessMutationEffect,
  confirmedMutationPaths,
  isConfirmedDirectMutation,
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

  test('nonzero direct mutation exits do not count without an error string', () => {
    assert.equal(isSuccessfulDirectMutation('write_file', undefined, 1), false);
    assert.equal(isSuccessfulDirectMutation('apply_patch', '', 1), false);
  });

  test('zero exit direct mutations count when the executor confirms success', () => {
    assert.equal(isSuccessfulDirectMutation('write_file', undefined, 0), true);
    assert.equal(isSuccessfulDirectMutation('apply_patch', '', 0), true);
  });
});

describe('assessMutationEffect', () => {
  test('confirms a changed committed receipt', () => {
    assert.equal(assessMutationEffect({
      tool: 'write_file',
      exitCode: 0,
      mutationPaths: ['a.txt'],
      mutationReceipt: {
        status: 'committed',
        changedBytes: 3,
        preImageHashes: { 'a.txt': 'before' },
        postImageHashes: { 'a.txt': 'after' },
      },
    }).status, 'confirmed_change');
  });

  test('confirms a committed no-op instead of counting a write', () => {
    assert.equal(assessMutationEffect({
      tool: 'str_replace',
      exitCode: 0,
      mutationPaths: ['a.txt'],
      mutationReceipt: {
        status: 'committed',
        changedBytes: 0,
        preImageHashes: { 'a.txt': 'same' },
        postImageHashes: { 'a.txt': 'same' },
      },
    }).status, 'confirmed_no_change');
  });

  test('keeps failed or receipt-less mutations indeterminate', () => {
    assert.equal(assessMutationEffect({
      tool: 'run_command',
      exitCode: 1,
      mutationPaths: ['a.txt'],
    }).status, 'indeterminate');
    assert.equal(assessMutationEffect({ tool: 'write_file', exitCode: 0 }).status, 'indeterminate');
  });

  test('preserves explicit policy denial as not applicable', () => {
    assert.equal(assessMutationEffect({
      tool: 'apply_patch',
      exitCode: 1,
      error: 'blocked',
      policyBlocked: true,
    }).status, 'not_applicable');
  });

  test('fails closed on conflicting receipt evidence', () => {
    assert.equal(assessMutationEffect({
      tool: 'write_file',
      exitCode: 0,
      mutationReceipt: {
        status: 'committed',
        changedBytes: 4,
        preImageHashes: { 'a.txt': 'same' },
        postImageHashes: { 'a.txt': 'same' },
      },
    }).status, 'indeterminate');
    assert.equal(assessMutationEffect({
      tool: 'write_file',
      exitCode: 0,
      mutationReceipt: {
        status: 'committed',
        changedBytes: 0,
        preImageHashes: { 'a.txt': 'before' },
        postImageHashes: { 'a.txt': 'after' },
      },
    }).status, 'indeterminate');
  });
});

describe('isConfirmedDirectMutation', () => {
  test('rejects a successful transport result with an indeterminate effect', () => {
    assert.equal(isConfirmedDirectMutation('write_file', undefined, 'indeterminate'), false);
    assert.equal(isConfirmedDirectMutation('write_file', undefined, 'confirmed_no_change'), false);
    assert.equal(isConfirmedDirectMutation('write_file', undefined, 'confirmed_change'), true);
  });

  test('preserves all executor-reported paths for a confirmed mutation', () => {
    assert.deepEqual(confirmedMutationPaths({
      tool: 'apply_patch',
      target: 'a.ts',
      mutationPaths: ['a.ts', 'b.ts'],
      effectStatus: 'confirmed_change',
    }), ['a.ts', 'b.ts']);
    assert.deepEqual(confirmedMutationPaths({
      tool: 'apply_patch',
      target: 'a.ts',
      effectStatus: 'confirmed_no_change',
    }), []);
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
