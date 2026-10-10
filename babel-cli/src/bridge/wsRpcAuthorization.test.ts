import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authorizeThreadScopedWsRpc } from './wsRpcAuthorization.js';

describe('authorizeThreadScopedWsRpc', () => {
  const ctx = { bridgeSessionId: 'sess-a', subscribedThreadId: 'thr-a' };

  it('allows turn.submit for the subscribed thread', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'turn.submit',
      params: { thread_id: 'thr-a', message: 'hi', command_id: 'c1' },
    });
    assert.equal(authorizeThreadScopedWsRpc(raw, ctx).ok, true);
  });

  it('rejects cross-thread turn.submit', () => {
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'turn.submit',
      params: { thread_id: 'thr-b', message: 'hi', command_id: 'c1' },
    });
    const result = authorizeThreadScopedWsRpc(raw, ctx);
    assert.equal(result.ok, false);
  });

  it('requires session_id on thread.create', () => {
    const missing = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'thread.create',
      params: { project_root: '/tmp' },
    });
    assert.equal(authorizeThreadScopedWsRpc(missing, ctx).ok, false);
    const ok = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'thread.create',
      params: { project_root: '/tmp', session_id: 'sess-a' },
    });
    assert.equal(authorizeThreadScopedWsRpc(ok, ctx).ok, true);
  });
});
