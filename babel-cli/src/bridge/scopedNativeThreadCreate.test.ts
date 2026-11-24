import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProtocolGateway } from './protocolGateway.js';
import { NativeCommandJournal } from './commandJournal.js';
import { createScopedNativeThread, type ScopedNativePrincipal } from './scopedNativeThreadCreate.js';
import { closeProtocolHostState } from '../protocol/client/host.js';

function principal(hostInstanceId: string, overrides: Partial<ScopedNativePrincipal> = {}): ScopedNativePrincipal {
  return { principalId: 'principal-1', projectId: 'project-1', sessionBinding: 'launch-1',
    registrationGeneration: 1, projectGeneration: 1, hostInstanceId, ...overrides };
}

test('scoped create binds one native thread to its ACP principal and same-command retry does not redispatch', async () => {
  const priorRuns = process.env['BABEL_RUNS_DIR'];
  const root = mkdtempSync(join(tmpdir(), 'babel-scoped-native-create-'));
  const projectRoot = join(root, 'workspace');
  mkdirSync(projectRoot);
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  const gateway = new ProtocolGateway({ allowedWorkspaceRoot: root, remoteSurface: true, enforceControlLease: true });
  const journal = new NativeCommandJournal(join(root, 'private', 'commands.sqlite'), {
    hostInstanceId: gateway.instanceId, protectStoreDirectory: (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
  });
  let dispatches = 0;
  const wrappedGateway = { dispatchScopedNativeThreadCreate: async (input: Parameters<ProtocolGateway['dispatchScopedNativeThreadCreate']>[0]) => {
    dispatches += 1; return gateway.dispatchScopedNativeThreadCreate(input);
  } };
  const session = principal(gateway.instanceId);
  const deps = {
    resolvePrincipal: (credential: string) => credential === 'synthetic-acp-token' ? session : null,
    resolveProject: (projectId: string) => projectId === 'project-1'
      ? { projectId, canonicalRoot: projectRoot, generation: 1 } : null,
    currentHostInstance: gateway.instanceId, gateway: wrappedGateway, journal,
  };
  const input = {
    acpCredential: 'synthetic-acp-token', commandId: 'create-command-1', projectId: 'project-1',
    sessionBinding: 'launch-1', expectedProjectGeneration: 1, expectedHostInstance: gateway.instanceId,
  };
  try {
    const wrongProject = await createScopedNativeThread({ ...input, projectId: 'project-other' }, deps);
    assert.deepEqual(wrongProject, { ok: false, reason: 'project_scope_denied' });
    const staleHost = await createScopedNativeThread({ ...input, expectedHostInstance: 'old-instance' }, deps);
    assert.deepEqual(staleHost, { ok: false, reason: 'stale_host_instance' });
    assert.equal(dispatches, 0, 'invalid scope is denied before gateway dispatch');
    const created = await createScopedNativeThread(input, deps);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.replayed, false);
    const threadId = (created.response as { result: { thread_id: string } }).result.thread_id;
    assert.equal(gateway.threadOwnership.ownerOf(threadId)?.sessionId, 'principal-1');
    const retry = await createScopedNativeThread(input, deps);
    assert.equal(retry.ok, true);
    if (retry.ok) {
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.response, created.response);
    }
    assert.equal(dispatches, 1);
  } finally {
    journal.close();
    closeProtocolHostState(gateway.host);
    rmSync(root, { recursive: true, force: true });
    if (priorRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = priorRuns;
  }
});

test('lost thread-create reply is journaled unknown and never automatically replayed', async () => {
  const priorRuns = process.env['BABEL_RUNS_DIR'];
  const root = mkdtempSync(join(tmpdir(), 'babel-scoped-native-lost-reply-'));
  const projectRoot = join(root, 'workspace');
  mkdirSync(projectRoot);
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs');
  const gateway = new ProtocolGateway({ allowedWorkspaceRoot: root, remoteSurface: true, enforceControlLease: true });
  const journal = new NativeCommandJournal(join(root, 'private', 'commands.sqlite'), {
    hostInstanceId: gateway.instanceId, protectStoreDirectory: (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
  });
  let dispatches = 0;
  const lostReplyGateway = { dispatchScopedNativeThreadCreate: async (input: Parameters<ProtocolGateway['dispatchScopedNativeThreadCreate']>[0]) => {
    dispatches += 1;
    await gateway.dispatchScopedNativeThreadCreate(input);
    throw new Error('synthetic transport reply loss after native admission');
  } };
  const session = principal(gateway.instanceId);
  const input = {
    acpCredential: 'synthetic-acp-token', commandId: 'create-command-lost', projectId: 'project-1',
    sessionBinding: 'launch-1', expectedProjectGeneration: 1, expectedHostInstance: gateway.instanceId,
  };
  const deps = {
    resolvePrincipal: (credential: string) => credential === 'synthetic-acp-token' ? session : null,
    resolveProject: (projectId: string) => projectId === 'project-1'
      ? { projectId, canonicalRoot: projectRoot, generation: 1 } : null,
    currentHostInstance: gateway.instanceId, gateway: lostReplyGateway, journal,
  };
  try {
    const first = await createScopedNativeThread(input, deps);
    assert.equal(first.ok, false);
    assert.equal(first.reason, 'reconcile_required');
    const second = await createScopedNativeThread(input, deps);
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'reconcile_required');
    assert.equal(dispatches, 1);
    const record = journal.lookup({ commandId: input.commandId, principalId: session.principalId, projectId: session.projectId });
    assert.equal(record?.state, 'unknown');
    assert.ok(record?.threadId);
    assert.equal(first.threadId, record?.threadId);
    assert.equal(gateway.threadOwnership.ownerOf(record!.threadId!)?.sessionId, 'principal-1');
  } finally {
    journal.close();
    closeProtocolHostState(gateway.host);
    rmSync(root, { recursive: true, force: true });
    if (priorRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = priorRuns;
  }
});
