import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { SessionDescriptor } from '../executor/contracts.js';
import {
  computeDesktopControllerProof,
  DESKTOP_CLIENT_ID_HEADER,
  DESKTOP_PROOF_HEADER,
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { CommandCodeAcpRuntimeRegistry } from './commandCodeAcpRuntime.js';
import { BridgeServer } from './sessionServer.js';
import { ensureThread, writeSessionDescriptor } from '../services/threadStore/index.js';

const TOKEN = 'cc-open-sidefx-token';
const ORIGIN = 'http://127.0.0.1';
const PEER = fileURLToPath(new URL('../../test/fixtures/command-code-acp-peer.mjs', import.meta.url));
const VERSION_FIXTURE = fileURLToPath(
  new URL('../../test/fixtures/command-code-version.mjs', import.meta.url),
);

class OpenInvocationRegistry extends CommandCodeAcpRuntimeRegistry {
  openSavedSessionCalls = 0;
  ensureSessionCalls = 0;
  persistReplayHistoryCalls = 0;

  override async ensureSession(descriptor: SessionDescriptor) {
    this.ensureSessionCalls += 1;
    return super.ensureSession(descriptor);
  }

  override persistReplayHistory(descriptor: SessionDescriptor): void {
    this.persistReplayHistoryCalls += 1;
    super.persistReplayHistory(descriptor);
  }

  override async openSavedSession(descriptor: SessionDescriptor): Promise<{ cell_count: number }> {
    this.openSavedSessionCalls += 1;
    return super.openSavedSession(descriptor);
  }
}

function commandCodeDescriptor(
  threadId: string,
  projectRoot: string,
  nativeId: string,
): SessionDescriptor {
  return {
    schemaVersion: 1,
    threadId,
    projectRoot,
    mode: 'chat',
    provider: 'default',
    model: 'default',
    policyProfile: 'safe_repo',
    createdAt: new Date().toISOString(),
    kernelVersion: 'executor-kernel-v1',
    contractVersion: 'executor-contract-v1',
    harness_adapter_id: 'command-code',
    harness_native_session_id: nativeId,
  };
}

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', ...options.headers },
      },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function rpc(
  rpcPort: number,
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
  id = 1,
): Promise<Record<string, unknown>> {
  const res = await httpRequest(`http://127.0.0.1:${rpcPort}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('harness.command_code.open side effects', () => {
  let server: BridgeServer;
  let registry: OpenInvocationRegistry;
  let port = 0;
  let tmp = '';
  let prevRuns: string | undefined;
  let prevCliExecutable: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  function desktopOnlyHeaders(): Record<string, string> {
    return {
      [DESKTOP_CLIENT_ID_HEADER]: desktopId,
      [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
      Origin: ORIGIN,
    };
  }

  function fullDesktopHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${TOKEN}`,
      ...desktopOnlyHeaders(),
    };
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-cc-open-fx-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    prevCliExecutable = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = VERSION_FIXTURE;
    registry = new OpenInvocationRegistry({
      testLaunch: { command: process.execPath, args: [PEER] },
    });
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      commandCodeRegistry: registry,
      commandCodeTestLaunch: { command: process.execPath, args: [PEER] },
      commandCodeInstallProbe: async () => ({
        state: 'verified' as const,
        executable: VERSION_FIXTURE,
        version: '1.0.0',
      }),
    });
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    if (prevCliExecutable === undefined) delete process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    else process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = prevCliExecutable;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('denies open with stale control_epoch and does not invoke registry openSavedSession', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: fullDesktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_preload',
      },
      1,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    const acquired = await rpc(
      port,
      desktopOnlyHeaders(),
      'control.acquire',
      { thread_id: threadId, force: false },
      2,
    );
    const epoch = (acquired.result as { epoch?: number }).epoch;
    assert.ok(typeof epoch === 'number');
    const before = registry.openSavedSessionCalls;
    const denied = await rpc(
      port,
      desktopOnlyHeaders(),
      'harness.command_code.open',
      {
        thread_id: threadId,
        project_root: tmp,
        harness_native_session_id: 'sess_fixture_preload',
        control_epoch: epoch + 99,
      },
      4,
    );
    assert.ok(denied.error, 'expected stale_epoch denial');
    assert.equal(registry.openSavedSessionCalls, before);
  });

  it('rejects mismatched native id with zero registry openSavedSession calls', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: fullDesktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_sidefx_a',
      },
      10,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(port, fullDesktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 11);
    const before = registry.openSavedSessionCalls;
    const denied = await rpc(
      port,
      fullDesktopHeaders(),
      'harness.command_code.open',
      {
        thread_id: threadId,
        project_root: tmp,
        harness_native_session_id: 'sess_fixture_sidefx_b',
      },
      12,
    );
    assert.ok(denied.error);
    assert.equal(registry.openSavedSessionCalls, before);
  });

  it('rejects open with project_root mismatch and zero registry calls', async () => {
    const subA = join(tmp, 'workspace-a');
    const subB = join(tmp, 'workspace-b');
    mkdirSync(subA, { recursive: true });
    mkdirSync(subB, { recursive: true });
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: fullDesktopHeaders(),
      body: JSON.stringify({ projectRoot: subA }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: subA,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_cross_root',
      },
      20,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(port, fullDesktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 21);
    const before = registry.openSavedSessionCalls;
    const denied = await rpc(
      port,
      fullDesktopHeaders(),
      'harness.command_code.open',
      {
        thread_id: threadId,
        project_root: subB,
        harness_native_session_id: 'sess_fixture_cross_root',
      },
      22,
    );
    assert.ok(denied.error);
    assert.equal(registry.openSavedSessionCalls, before);
  });

  it('rejects open while turn is active with zero registry calls', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: fullDesktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_active_turn',
      },
      30,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(port, fullDesktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 31);
    server.protocolGateway.host.activeTurns.set(threadId, {
      turnId: 1,
      generation: 1,
      cancelRequested: false,
      scheduled: true,
      settled: false,
    });
    const before = registry.openSavedSessionCalls;
    const denied = await rpc(
      port,
      fullDesktopHeaders(),
      'harness.command_code.open',
      {
        thread_id: threadId,
        project_root: tmp,
        harness_native_session_id: 'sess_fixture_active_turn',
      },
      32,
    );
    assert.ok(denied.error);
    assert.equal(registry.openSavedSessionCalls, before);
    server.protocolGateway.host.activeTurns.delete(threadId);
  });

  it('rejects open when native session belongs to another thread with zero registry calls', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: fullDesktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const owner = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_owner_a',
      },
      40,
    );
    const ownerThread = (owner.result as { thread_id: string }).thread_id;
    const other = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_owner_b',
      },
      41,
    );
    const otherThread = (other.result as { thread_id: string }).thread_id;
    await rpc(port, fullDesktopHeaders(), 'control.acquire', { thread_id: otherThread, force: false }, 42);
    const before = registry.openSavedSessionCalls;
    const denied = await rpc(
      port,
      fullDesktopHeaders(),
      'harness.command_code.open',
      {
        thread_id: otherThread,
        project_root: tmp,
        harness_native_session_id: 'sess_fixture_owner_a',
      },
      43,
    );
    assert.ok(denied.error);
    assert.equal(registry.openSavedSessionCalls, before);
    assert.notEqual(ownerThread, otherThread);
  });

  it('rejects open when dual persisted owners corrupt canonical authority with zero registry effects', async () => {
    const nativeId = 'sess_fixture_dual_open_corrupt';
    const t1 = 'thread-dual-open-a';
    const t2 = 'thread-dual-open-b';
    const host = server.protocolGateway.host;
    for (const threadId of [t1, t2]) {
      const descriptor = commandCodeDescriptor(threadId, tmp, nativeId);
      ensureThread(threadId, { project_root: tmp });
      writeSessionDescriptor(descriptor);
      host.descriptors.set(threadId, descriptor);
    }
    await rpc(port, fullDesktopHeaders(), 'control.acquire', { thread_id: t1, force: false }, 60);
    const beforeOpen = registry.openSavedSessionCalls;
    const beforeEnsure = registry.ensureSessionCalls;
    const beforeReplay = registry.persistReplayHistoryCalls;
    const denied = await rpc(
      port,
      fullDesktopHeaders(),
      'harness.command_code.open',
      {
        thread_id: t1,
        project_root: tmp,
        harness_native_session_id: nativeId,
      },
      61,
    );
    assert.ok(denied.error, 'expected corrupt dual-owner open denial');
    const message = (denied.error as { message?: string }).message ?? '';
    assert.match(message, /Multiple persisted/i);
    assert.equal(registry.openSavedSessionCalls, beforeOpen);
    assert.equal(registry.ensureSessionCalls, beforeEnsure);
    assert.equal(registry.persistReplayHistoryCalls, beforeReplay);
  });

  it('rejects thread.create alias for an already-owned persisted native session', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: fullDesktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const owner = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_alias_owner',
      },
      50,
    );
    assert.ok(owner.result);
    const alias = await rpc(
      port,
      fullDesktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_alias_owner',
      },
      51,
    );
    assert.ok(alias.error, 'expected alias thread.create rejection');
  });
});
