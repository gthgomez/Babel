import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  approvalOperationFromAgentAction,
  digestApprovalOperation,
  operationDigestMatches,
} from './approvalOperation.js';
import {
  applyApprovalDecision,
  buildApprovalRequest,
  createApprovalSession,
  isPreApproved,
} from './approvalRequests.js';

describe('approval operation digest', () => {
  it('binds write_file content and rejects mutation after digest', () => {
    const action = { type: 'write_file' as const, path: 'a.ts', content: 'hello' };
    const op = approvalOperationFromAgentAction(action, {
      thread_id: 't',
      turn_id: '1',
      cwd: '/proj',
    });
    const digest = digestApprovalOperation(op);
    action.content = 'mutated';
    const live = approvalOperationFromAgentAction(action, {
      thread_id: 't',
      turn_id: '1',
      cwd: '/proj',
    });
    assert.equal(operationDigestMatches(digest, live), false);
  });

  it('binds apply_patch body', () => {
    const a = approvalOperationFromAgentAction(
      { type: 'apply_patch', patch: 'diff --git a/x' },
      { thread_id: 't', turn_id: '1', cwd: '/proj' },
    );
    const b = approvalOperationFromAgentAction(
      { type: 'apply_patch', patch: 'diff --git a/y' },
      { thread_id: 't', turn_id: '1', cwd: '/proj' },
    );
    assert.notEqual(digestApprovalOperation(a), digestApprovalOperation(b));
  });

  it('allow_session does not grant the entire capability', () => {
    const state = createApprovalSession('t1');
    const writeA = buildApprovalRequest({
      thread_id: 't1',
      turn_id: '1',
      command: 'write src/a.ts',
      cwd: '/proj',
      capability: 'write',
      proposed_scope: 'write:src/a.ts',
      reason: 'write',
    });
    applyApprovalDecision(state, writeA, 'allow_session');
    assert.equal(isPreApproved(state, writeA), true);
    const writeB = buildApprovalRequest({
      thread_id: 't1',
      turn_id: '2',
      command: 'write src/b.ts',
      cwd: '/proj',
      capability: 'write',
      proposed_scope: 'write:src/b.ts',
      reason: 'write',
    });
    assert.equal(isPreApproved(state, writeB), false);
    // Bare capability keys must not over-grant even if injected.
    state.sessionAllows.add('write');
    assert.equal(isPreApproved(state, writeB), false);
  });

  it('benchmark authority still requires the live operation to match the bound digest', () => {
    const action = { type: 'write_file' as const, path: 'a.ts', content: 'hello' };
    const bound = approvalOperationFromAgentAction(action, {
      thread_id: 't',
      turn_id: '1',
      cwd: '/proj',
    });
    const digest = digestApprovalOperation(bound);
    action.path = 'b.ts';
    const live = approvalOperationFromAgentAction(action, {
      thread_id: 't',
      turn_id: '1',
      cwd: '/proj',
    });
    assert.equal(operationDigestMatches(digest, live), false);
  });
});
