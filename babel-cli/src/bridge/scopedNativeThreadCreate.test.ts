import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProtocolGateway } from './protocolGateway.js';
import { NativeCommandJournal } from './commandJournal.js';
import { createScopedNativeThread, type ScopedNativePrincipal } from './scopedNativeThreadCreate.js';
import { closeProtocolHostState } from '../protocol/client/host.js';
import { IntegrationRpcResponseSchema, NATIVE_THREAD_ID_PATTERN } from '../protocol/remoteContract.js';

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
    resolveTransportSession: (input: { sessionId: string; acpCredential: string }) =>
      input.acpCredential === 'synthetic-acp-token' && input.sessionId === 'transport-session-1'
        ? { ...session, transportSessionId: input.sessionId } : null,
    resolveProject: (projectId: string) => projectId === 'project-1'
      ? { projectId, canonicalRoot: projectRoot, generation: 1 } : null,
    currentHostInstance: gateway.instanceId, gateway: wrappedGateway, journal,
  };
  const input = {
    acpCredential: 'synthetic-acp-token', transportSessionId: 'transport-session-1',
    commandId: 'create-command-1', projectId: 'project-1',
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
    assert.equal(gateway.threadOwnership.ownerOf(threadId)?.sessionId, 'transport-session-1');
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

test('malformed native create success never settles and valid replies replay strictly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-scoped-native-strict-reply-'));
  const projectRoot = join(root, 'workspace');
  mkdirSync(projectRoot);
  const host = '11111111-1111-4111-8111-111111111111';
  const journal = new NativeCommandJournal(join(root, 'private', 'commands.sqlite'), {
    hostInstanceId: host, protectStoreDirectory: (directory) => mkdirSync(directory, { recursive: true, mode: 0o700 }),
  });
  const session = principal(host);
  const input = {
    acpCredential: 'synthetic-acp-token', transportSessionId: 'transport-session-1',
    commandId: '', projectId: 'project-1', sessionBinding: 'launch-1',
    expectedProjectGeneration: 1, expectedHostInstance: host,
  };
  const resolveTransportSession = (value: { sessionId: string; acpCredential: string }) =>
    value.acpCredential === 'synthetic-acp-token' && value.sessionId === 'transport-session-1'
      ? { ...session, transportSessionId: value.sessionId } : null;
  const resolveProject = (projectId: string) => projectId === 'project-1'
    ? { projectId, canonicalRoot: projectRoot, generation: 1 } : null;
  let dispatches = 0;
  type Gateway = Pick<ProtocolGateway, 'dispatchScopedNativeThreadCreate'>;
  type GatewayInput = Parameters<Gateway['dispatchScopedNativeThreadCreate']>[0];
  const depsFor = (gateway: Gateway) => ({ resolveTransportSession, resolveProject,
    currentHostInstance: host, gateway, journal });
  const malformed = [
    (value: GatewayInput) => ({ jsonrpc: '2.0', id: value.commandId,
      result: { thread_id: value.threadId, extra: 'unexpected' } }),
    (value: GatewayInput) => ({ jsonrpc: '2.0', id: value.commandId,
      result: { thread_id: value.threadId }, extra: 'unexpected' }),
    (value: GatewayInput) => ({ jsonrpc: '2.0', id: 'different-command',
      result: { thread_id: value.threadId } }),
    (value: GatewayInput) => ({ jsonrpc: '2.0', id: value.commandId,
      result: { command_id: value.commandId, fingerprint: 'a'.repeat(64), state: 'settled',
        thread_id: value.threadId, host_instance_id: host, registration_generation: 1, result: null } }),
    (value: GatewayInput) => ({ jsonrpc: '2.0', id: value.commandId,
      error: { code: -32602, message: 'synthetic', data: { reason: 'synthetic' } } }),
  ];
  try {
    for (const [index, variant] of malformed.entries()) {
      const commandId = `malformed-command-${index}`;
      const gateway = { dispatchScopedNativeThreadCreate: async (value: GatewayInput) => {
        dispatches += 1;
        return variant(value);
      } } as unknown as Gateway;
      const result = await createScopedNativeThread({ ...input, commandId }, depsFor(gateway));
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'reconcile_required');
      if (result.ok) return;
      assert.match(result.threadId ?? '', NATIVE_THREAD_ID_PATTERN);
      assert.equal(journal.lookup({ commandId, principalId: session.principalId, projectId: session.projectId })?.state,
        'unknown', 'malformed success is marked unknown, never settled');
      const retry = await createScopedNativeThread({ ...input, commandId }, depsFor(gateway));
      assert.equal(retry.ok, false);
      assert.equal(retry.reason, 'reconcile_required');
    }
    assert.equal(dispatches, malformed.length, 'malformed replies are never retried');

    const validCommand = 'valid-command';
    let validDispatches = 0;
    const validGateway = { dispatchScopedNativeThreadCreate: async (value: GatewayInput) => {
      validDispatches += 1;
      return { jsonrpc: '2.0', id: value.commandId, result: { thread_id: value.threadId } };
    } } as unknown as Gateway;
    const created = await createScopedNativeThread({ ...input, commandId: validCommand }, depsFor(validGateway));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(IntegrationRpcResponseSchema.safeParse(created.response).success, true,
      'settled response satisfies the strict negotiated envelope');
    const threadId = (created.response as { result: { thread_id: string } }).result.thread_id;
    assert.match(threadId, NATIVE_THREAD_ID_PATTERN);
    assert.equal(journal.lookup({ commandId: validCommand, principalId: session.principalId, projectId: session.projectId })?.state,
      'settled');
    const replay = await createScopedNativeThread({ ...input, commandId: validCommand }, depsFor(validGateway));
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.response, created.response);
    assert.equal(validDispatches, 1, 'known valid settlement replays without dispatch');

    const seededCommand = 'seeded-malformed-command';
    const seededThreadId = 'chat-0123456789ab';
    const reservation = journal.reserve({
      commandId: seededCommand, principalId: session.principalId, projectId: session.projectId,
      threadId: seededThreadId, hostInstanceId: host, registrationGeneration: 1,
      payload: { method: 'thread.create', projectId: session.projectId, projectGeneration: 1,
        projectRoot: realpathSync(projectRoot), sessionBinding: session.sessionBinding,
        principalGeneration: session.registrationGeneration },
    });
    assert.equal(reservation.ok, true);
    assert.equal(journal.settle({
      commandId: seededCommand, principalId: session.principalId, threadId: seededThreadId,
      result: { jsonrpc: '2.0', id: seededCommand,
        result: { thread_id: seededThreadId, extra: 'unexpected' } },
    }), true);
    let seededDispatches = 0;
    const seededGateway = { dispatchScopedNativeThreadCreate: async () => {
      seededDispatches += 1;
      throw new Error('seeded malformed record must not dispatch');
    } } as unknown as Gateway;
    const seeded = await createScopedNativeThread({ ...input, commandId: seededCommand }, depsFor(seededGateway));
    assert.equal(seeded.ok, false);
    assert.equal(seeded.reason, 'reconcile_required');
    assert.equal(seededDispatches, 0, 'malformed durable success is never replayed or redispatched');
    assert.equal(journal.lookup({ commandId: seededCommand, principalId: session.principalId, projectId: session.projectId })?.state,
      'settled', 'legacy settled row is not mutated, but is never emitted');
  } finally {
    journal.close();
    rmSync(root, { recursive: true, force: true });
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
    acpCredential: 'synthetic-acp-token', transportSessionId: 'transport-session-1',
    commandId: 'create-command-lost', projectId: 'project-1',
    sessionBinding: 'launch-1', expectedProjectGeneration: 1, expectedHostInstance: gateway.instanceId,
  };
  const deps = {
    resolveTransportSession: (value: { sessionId: string; acpCredential: string }) =>
      value.acpCredential === 'synthetic-acp-token' && value.sessionId === 'transport-session-1'
        ? { ...session, transportSessionId: value.sessionId } : null,
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
    assert.equal(gateway.threadOwnership.ownerOf(record!.threadId!)?.sessionId, 'transport-session-1');
  } finally {
    journal.close();
    closeProtocolHostState(gateway.host);
    rmSync(root, { recursive: true, force: true });
    if (priorRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = priorRuns;
  }
});
