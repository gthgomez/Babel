import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  approvalOperationFromAgentAction,
  digestApprovalOperation,
} from '../agent/approvalOperation.js';
import { requestChatActionApproval, requestMcpApproval } from '../agent/chatApproval.js';
import {
  RemoteApprovalBroker,
  remoteMcpIsFailClosed,
  runOnRemoteSurface,
} from './remoteApproval.js';

function writeOp(content = 'hello', path = 'a.ts') {
  return approvalOperationFromAgentAction(
    { type: 'write_file', path, content },
    { thread_id: 'thr-a', turn_id: '1', cwd: '/proj' },
  );
}

describe('RemoteApprovalBroker', () => {
  it('ALLOW_ONCE executes the exact pending operation once and rejects replay/mutation/wrong identity/session grants', async () => {
    const broker = new RemoteApprovalBroker(60_000);
    const now = 10_000;
    const operation = writeOp();
    const pending = broker.createPending({
      thread_id: 'thr-a',
      turn_id: '1',
      operation,
      now,
    });
    const digest = digestApprovalOperation(operation);

    const session = broker.decide({
      approval_id: pending.approval_id,
      decision: 'allow_session',
      thread_id: 'thr-a',
      turn_id: '1',
      operation_digest: digest,
      now,
    });
    assert.equal(session.ok, false);
    if (!session.ok) assert.equal(session.error, 'session_grant_forbidden');

    const wrongThread = broker.decide({
      approval_id: pending.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-b',
      turn_id: '1',
      operation_digest: digest,
      now,
    });
    assert.equal(wrongThread.ok, false);

    const wrongTurn = broker.decide({
      approval_id: pending.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '9',
      operation_digest: digest,
      now,
    });
    assert.equal(wrongTurn.ok, false);

    const mutated = broker.decide({
      approval_id: pending.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '1',
      operation_digest: digestApprovalOperation(writeOp('MUTATED')),
      now,
    });
    assert.equal(mutated.ok, false);
    if (!mutated.ok) assert.equal(mutated.error, 'digest_mismatch');

    const first = broker.decide({
      approval_id: pending.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '1',
      operation_digest: digest,
      now,
    });
    assert.equal(first.ok, true);
    if (first.ok) assert.equal(first.record.state, 'consumed');

    const replay = broker.decide({
      approval_id: pending.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '1',
      operation_digest: digest,
      now,
    });
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.error, 'replay');
  });

  it('DENY, expiry, cancel, and cross-applied approvals fail closed', () => {
    const broker = new RemoteApprovalBroker(100);
    const now = 1;
    const a = broker.createPending({
      thread_id: 'thr-a',
      turn_id: '1',
      operation: writeOp('a', 'a.ts'),
      now,
    });
    const b = broker.createPending({
      thread_id: 'thr-a',
      turn_id: '2',
      operation: writeOp('b', 'b.ts'),
      now,
    });

    const deny = broker.decide({
      approval_id: a.approval_id,
      decision: 'deny',
      thread_id: 'thr-a',
      turn_id: '1',
      now,
    });
    assert.equal(deny.ok, true);
    if (deny.ok) assert.equal(deny.record.state, 'denied');

    const cross = broker.decide({
      approval_id: b.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '1',
      operation_digest: a.digest,
      now,
    });
    assert.equal(cross.ok, false);

    const expired = broker.decide({
      approval_id: b.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '2',
      now: now + 1_000,
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.error, 'expired');

    const c = broker.createPending({
      thread_id: 'thr-a',
      turn_id: '3',
      operation: writeOp('c', 'c.ts'),
      now,
    });
    assert.equal(broker.cancelTurn('thr-a', '3'), 1);
    const afterCancel = broker.decide({
      approval_id: c.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '3',
      now,
    });
    assert.equal(afterCancel.ok, false);
    if (!afterCancel.ok) assert.equal(afterCancel.error, 'cancelled');
  });

  it('ALLOW_ONCE fails closed when the live action mutates after requestAllowOnce', async () => {
    const broker = new RemoteApprovalBroker();
    const action = { type: 'write_file' as const, path: 'a.ts', content: 'hello' };
    const allowed = runOnRemoteSurface(
      {
        broker,
        threadId: 'thr-a',
        turnId: '1',
        failClosedMcp: true,
        cwd: '/proj',
      },
      () =>
        broker.requestAllowOnce({
          action,
          thread_id: 'thr-a',
          turn_id: '1',
          cwd: '/proj',
        }),
    );

    let pending = broker.listPending('thr-a')[0];
    for (let i = 0; i < 40 && !pending; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      pending = broker.listPending('thr-a')[0];
    }
    assert.ok(pending);

    action.content = 'MUTATED';
    const decided = broker.decide({
      approval_id: pending.approval_id,
      decision: 'allow_once',
      thread_id: 'thr-a',
      turn_id: '1',
      operation_digest: pending.digest,
    });
    assert.equal(decided.ok, false);
    if (!decided.ok) assert.equal(decided.error, 'digest_mismatch');
    assert.equal(await allowed, false);
  });

  it('remote MCP is fail-closed on the remote surface', async () => {
    const broker = new RemoteApprovalBroker();
    const allowed = await runOnRemoteSurface(
      {
        broker,
        threadId: 'thr-a',
        turnId: '1',
        failClosedMcp: true,
        cwd: '/proj',
      },
      async () => {
        assert.equal(remoteMcpIsFailClosed(), true);
        return requestMcpApproval({ type: 'mcp_request', server: 'fs', query: 'x' });
      },
    );
    assert.equal(allowed, false);
    assert.equal(remoteMcpIsFailClosed(), false);
  });
});
