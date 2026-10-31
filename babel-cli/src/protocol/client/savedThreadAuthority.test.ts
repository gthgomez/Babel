import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { ChatEngine } from '../../agent/chatEngine.js';
import { ProtocolGateway } from '../../bridge/protocolGateway.js';
import { loadSessionDescriptor } from '../../services/threadStore/sessionDescriptor.js';
import { closeProtocolHostState, createProtocolHostState, handleProtocolRequest } from './host.js';

test('saved-thread guards deny every remote operation before cache, engine, approval, or lease effects', async () => {
  const runs = mkdtempSync(join(tmpdir(), 'babel-saved-thread-authority-'));
  const priorRuns = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = runs;
  const allowedRoot = join(runs, 'allowed');
  const outsideRoot = join(runs, 'outside');
  mkdirSync(allowedRoot);
  mkdirSync(outsideRoot);
  const seed = createProtocolHostState({ executeWithoutNotifications: true });
  const seeded = await handleProtocolRequest({
    jsonrpc: '2.0', id: 1, method: 'thread.create',
    params: { project_root: outsideRoot, task: 'persisted outside thread' },
  }, seed);
  assert.ok('result' in seeded);
  const threadId = (seeded as { result: { thread_id: string } }).result.thread_id;
  const descriptor = loadSessionDescriptor(threadId);
  assert.ok(descriptor);
  await closeProtocolHostState(seed);

  let engineFactoryCalls = 0;
  const host = createProtocolHostState({
    executeWithoutNotifications: true,
    remoteSurface: true,
    projectRootGuard: (root) => {
      if (resolve(root) !== resolve(allowedRoot)) throw new Error('outside root');
      return resolve(root);
    },
    engineFactory: () => {
      engineFactoryCalls += 1;
      throw new Error('engine must not be constructed');
    },
  });
  const hostRequests = [
    ['thread.resume', { thread_id: threadId, project_root: allowedRoot }],
    ['history.lookup', { thread_id: threadId }],
    ['turn.submit', { thread_id: threadId, message: 'must not run' }],
    ['turn.cancel', { thread_id: threadId, turn_id: '1' }],
    ['workspace.changes', { thread_id: threadId }],
    ['verification.lookup', { thread_id: threadId }],
    ['approval.lookup', { thread_id: threadId }],
    ['approval.decide', { thread_id: threadId, approval_id: 'approval-outside', decision: 'allow_once' }],
  ] as const;
  try {
    for (const [index, [method, params]] of hostRequests.entries()) {
      const response = await handleProtocolRequest({
        jsonrpc: '2.0', id: index + 2, method, params,
      } as never, host);
      assert.ok('error' in response, `${method} should be denied`);
      assert.equal(response.error.message, 'Saved thread is not available in this workspace.');
    }
    assert.equal(engineFactoryCalls, 0);
    assert.equal(host.engines.size, 0);
    assert.equal(host.restoreReports.size, 0);
    assert.equal(host.approvalBroker.listPending(threadId).length, 0);
    assert.equal(host.activeTurns.size, 0);

    // A warmed descriptor cache must not replace persisted identity evidence.
    host.descriptors.set(threadId, descriptor);
    const cached = await handleProtocolRequest({
      jsonrpc: '2.0', id: 20, method: 'history.lookup', params: { thread_id: threadId },
    }, host);
    assert.ok('error' in cached);
    assert.equal(host.engines.size, 0);

    const gateway = new ProtocolGateway({ allowedWorkspaceRoot: allowedRoot, enforceControlLease: true });
    gateway.threadOwnership.bind(threadId, 'device:fixture');
    const leaseBefore = gateway.controlLeases.status(threadId);
    const gatewayRequests = [
      { method: 'thread.resume', params: { thread_id: threadId, project_root: allowedRoot } },
      { method: 'history.lookup', params: { thread_id: threadId } },
      { method: 'turn.submit', params: { thread_id: threadId, message: 'must not run' } },
      { method: 'workspace.changes', params: { thread_id: threadId } },
      { method: 'verification.lookup', params: { thread_id: threadId } },
      { method: 'approval.lookup', params: { thread_id: threadId } },
      { method: 'approval.decide', params: { thread_id: threadId, approval_id: 'approval-outside', decision: 'allow_once' } },
      { method: 'control.status', params: { thread_id: threadId } },
      { method: 'control.acquire', params: { thread_id: threadId, client_id: 'device:fixture' } },
      { method: 'control.renew', params: { thread_id: threadId, client_id: 'device:fixture', control_epoch: 1 } },
      { method: 'control.release', params: { thread_id: threadId, client_id: 'device:fixture', control_epoch: 1 } },
    ];
    for (const [index, request] of gatewayRequests.entries()) {
      const response = await gateway.dispatch(JSON.stringify({ jsonrpc: '2.0', id: index + 30, ...request }));
      assert.ok('error' in response, `${request.method} should be denied`);
      assert.equal(response.error.message, 'Saved thread is not available in this workspace.');
    }
    gateway.host.descriptors.set(threadId, descriptor);
    const cachedGateway = await gateway.dispatch(JSON.stringify({
      jsonrpc: '2.0', id: 49, method: 'turn.submit',
      params: { thread_id: threadId, message: 'cached descriptor must not authorize' },
    }));
    assert.ok('error' in cachedGateway);
    assert.equal(cachedGateway.error.message, 'Saved thread is not available in this workspace.');
    const mint = gateway.authorizeTicketMint({ sessionId: 'device:fixture', threadId });
    assert.deepEqual(mint, { ok: false, error: 'unowned_thread' });
    assert.deepEqual(gateway.controlLeases.status(threadId), leaseBefore);
    assert.equal(gateway.host.engines.size, 0);
    assert.equal(gateway.host.restoreReports.size, 0);

    const owningGateway = new ProtocolGateway({ allowedWorkspaceRoot: outsideRoot });
    const allowed = await owningGateway.dispatch(JSON.stringify({
      jsonrpc: '2.0', id: 50, method: 'thread.resume',
      params: { thread_id: threadId, project_root: outsideRoot },
    }));
    assert.ok('result' in allowed, 'the workspace matching the persisted root may resume');
    await closeProtocolHostState(owningGateway.host);
    await closeProtocolHostState(gateway.host);
  } finally {
    await closeProtocolHostState(host);
    if (priorRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = priorRuns;
    rmSync(runs, { recursive: true, force: true });
  }
});
