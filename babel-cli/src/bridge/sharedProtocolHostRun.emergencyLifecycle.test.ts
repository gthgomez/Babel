import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { HttpProtocolClient } from './httpProtocolClient.js';
import { BridgeServer } from './sessionServer.js';
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'emergency-lifecycle-token';

function cooperativeCancelEngine(descriptor: { projectRoot: string }, taskLabel: string): ChatEngine {
  const engine = new ChatEngine({
    task: taskLabel,
    projectRoot: descriptor.projectRoot,
    executionProfile: 'chat',
  });
  engine.submitMessageStream = async function* () {
    yield { type: 'thinking' };
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const cancelled = (engine as unknown as { _cancelled?: boolean })._cancelled === true;
      if (cancelled) {
        yield { type: 'cancelled' };
        return;
      }
    }
  } as ChatEngine['submitMessageStream'];
  return engine;
}

async function hostCatalogRow(
  port: number,
  desktopId: string,
  desktopProofKey: string,
  threadId: string,
) {
  const client = new HttpProtocolClient({
    baseUrl: `http://127.0.0.1:${port}`,
    desktopClientId: desktopId,
    desktopProofKey,
  });
  const catalog = await client.call<'remote.catalog', Record<string, never>, { sessions: Array<{
    thread_id: string;
    active_turn: boolean;
    active_turn_id?: number;
    status: string;
  }> }>('remote.catalog', {});
  return catalog.sessions.find((session) => session.thread_id === threadId) ?? null;
}

async function hostTurnTerminal(
  port: number,
  desktopId: string,
  desktopProofKey: string,
  threadId: string,
  turnId: number,
) {
  const client = new HttpProtocolClient({
    baseUrl: `http://127.0.0.1:${port}`,
    desktopClientId: desktopId,
    desktopProofKey,
  });
  const history = await client.call<
    'history.lookup',
    { thread_id: string; turn_id: number; limit: number },
    { turn_terminal?: { turn_id: number; event_type: string } | null }
  >('history.lookup', { thread_id: threadId, turn_id: turnId, limit: 50 });
  return history.turn_terminal ?? null;
}

describe('shared host-run emergency stop lifecycle', () => {
  let server: BridgeServer;
  let tmp: string;
  let configDir: string;
  let port = 0;
  let prevConfigDir: string | undefined;
  let prevRuns: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-lifecycle-'));
    configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
    prevConfigDir = process.env['BABEL_CONFIG_DIR'];
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_CONFIG_DIR'] = configDir;
    process.env['BABEL_RUNS_DIR'] = tmp;

    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => cooperativeCancelEngine(descriptor, 'emergency-lifecycle'),
    });
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await server.stop();
    if (prevConfigDir === undefined) delete process.env['BABEL_CONFIG_DIR'];
    else process.env['BABEL_CONFIG_DIR'] = prevConfigDir;
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  class EarlyCloseWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('open', () => {
        setTimeout(() => this.close(), 8);
      });
    }
  }

  it('observes persisted cancelled terminal and releases active turn after emergency ack', async () => {
    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'cooperative cancel',
        runId: 'emergency-persisted-cancel',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        WebSocketImpl: EarlyCloseWebSocket as typeof WebSocket,
      },
      (event) => events.push(event),
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung after emergency ack')), 20_000),
      ),
    ]);

    assert.equal(code, 0);
    assert.ok(events.some((e) => e.type === 'emergency_stop'));
    const cancelled = events.filter((e) => e.type === 'cancelled');
    assert.equal(cancelled.length, 1, JSON.stringify(events.map((e) => e.type)));

    const client = new HttpProtocolClient({
      baseUrl: `http://127.0.0.1:${port}`,
      desktopClientId: desktopId,
      desktopProofKey,
    });
    const catalog = await client.call<'remote.catalog', Record<string, never>, { sessions: Array<{ thread_id: string }> }>(
      'remote.catalog',
      {},
    );
    const threadId = catalog.sessions[0]?.thread_id;
    assert.ok(threadId);
    const terminal = await hostTurnTerminal(port, desktopId, desktopProofKey, threadId, 1);
    assert.equal(terminal?.event_type, 'cancelled');
    assert.equal(terminal?.turn_id, 1);

    const row = await hostCatalogRow(port, desktopId, desktopProofKey, threadId);
    assert.equal(row?.active_turn, false);
  });

  it('rejects invalid emergency token without emergency ack or terminal settlement', async () => {
    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'reject token',
        runId: 'emergency-reject',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
      },
      (event) => events.push(event),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: 'wrong' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(events.some((e) => e.type === 'control.rejected'));
    assert.equal(events.some((e) => e.type === 'emergency_stop'), false);
    assert.equal(events.some((e) => e.type === 'cancelled'), false);

    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );
    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung after valid emergency')), 20_000),
      ),
    ]);
    assert.equal(code, 0);
  });

  it('preserves authoritative failure when the turn fails before emergency ack', async () => {
    await server.stop();
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'fail-before-emergency',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'failed', error: 'deterministic failure before emergency' };
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    port = server.port;

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const code = await executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'fail fast',
        runId: 'emergency-after-failure',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
      },
      (event) => events.push(event),
    );

    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(code, 1);
    assert.ok(events.some((e) => e.type === 'run_error'));
    assert.equal(events.some((e) => e.type === 'emergency_stop'), false);
    assert.equal(events.filter((e) => e.type === 'cancelled').length, 0);
  });
});

describe('shared host-run emergency observation errors (mocked authoritative backend)', () => {
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  it('does not fabricate cancelled when the engine never settles after emergency ack', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-mock-'));
    const configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
    process.env['BABEL_CONFIG_DIR'] = configDir;
    process.env['BABEL_RUNS_DIR'] = tmp;

    const server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'never-settles',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* ignore cancel — simulates owner still running */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'still active after ack',
        runId: 'emergency-still-active',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        WebSocketImpl: class extends WebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener('open', () => setTimeout(() => this.close(), 5));
          }
        } as typeof WebSocket,
        emergencyObservationPassLimit: 2,
        emergencyObservationDeadlineMs: 3_000,
        observationRpcTimeoutMs: 500,
      },
      (event) => events.push(event),
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung with active catalog')), 25_000),
      ),
    ]);

    assert.equal(code, 1);
    assert.ok(events.some((e) => e.type === 'emergency_stop'));
    assert.equal(events.some((e) => e.type === 'cancelled'), false);
    assert.ok(
      events.some(
        (e) =>
          e.type === 'run_error' &&
          String((e as { error?: string }).error).includes(
            'authoritative turn terminal was not observed',
          ),
      ),
    );

    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves unrelated failed events after emergency ack', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-failed-'));
    const configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
    process.env['BABEL_CONFIG_DIR'] = configDir;
    process.env['BABEL_RUNS_DIR'] = tmp;

    const serverWithFailure = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'failed-after-ack',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          for (let i = 0; i < 80; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            if ((engine as unknown as { _cancelled?: boolean })._cancelled === true) break;
          }
          yield { type: 'failed', error: 'disk corruption unrelated to cancellation' };
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await serverWithFailure.start(0);
    const failurePort = serverWithFailure.port;

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port: failurePort,
        projectRoot: tmp,
        task: 'failed after ack',
        runId: 'emergency-failed-after-ack',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
      },
      (event) => events.push(event),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung on failed after ack')), 20_000),
      ),
    ]);

    assert.equal(code, 1);
    assert.ok(events.some((e) => e.type === 'emergency_stop'));
    assert.ok(
      events.some(
        (e) =>
          e.type === 'run_error' &&
          String((e as { error?: string }).error).includes('disk corruption'),
      ),
    );
    assert.equal(events.filter((e) => e.type === 'cancelled').length, 0);

    await serverWithFailure.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('finalizes and wakes the observer when post-ack reconciliation throws', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-reconcile-'));
    const configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
    process.env['BABEL_CONFIG_DIR'] = configDir;
    process.env['BABEL_RUNS_DIR'] = tmp;

    const server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'reconcile-error',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* ignore cancel — reconcile error must surface before fabricated terminal */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (
        url.includes('/rpc') &&
        (body.includes('remote.catalog') || body.includes('history.lookup'))
      ) {
        throw new Error('catalog lookup failed during emergency reconciliation');
      }
      return baseFetch(input, init);
    };

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'reconcile throws',
        runId: 'emergency-reconcile-error',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        fetchImpl,
        WebSocketImpl: class extends WebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener('open', () => setTimeout(() => this.close(), 5));
          }
        } as typeof WebSocket,
        observationRpcTimeoutMs: 500,
      },
      (event) => events.push(event),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung after reconcile error')), 15_000),
      ),
    ]);

    assert.equal(code, 1);
    assert.ok(
      events.some(
        (e) =>
          e.type === 'run_error' &&
          String((e as { error?: string }).error).includes('catalog lookup failed'),
      ),
    );
    assert.equal(events.some((e) => e.type === 'cancelled'), false);

    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('fails closed on a never-resolving observation RPC and wakes waiters without cancelled', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-rpc-hang-'));
    const configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
    process.env['BABEL_CONFIG_DIR'] = configDir;
    process.env['BABEL_RUNS_DIR'] = tmp;

    const server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'rpc-hang',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles — observation must fail closed */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let hangLookup = false;
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (hangLookup && url.includes('/rpc') && body.includes('history.lookup')) {
        await new Promise<void>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('history.lookup observation RPC timed out after 200ms')),
            200,
          );
        });
      }
      return baseFetch(input, init);
    };

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'rpc hang',
        runId: 'emergency-rpc-hang',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        fetchImpl,
        observationRpcTimeoutMs: 200,
        emergencyObservationDeadlineMs: 5_000,
      },
      (event) => events.push(event),
    );

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === 'thought' || e.type === 'thinking')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    hangLookup = true;
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung on never-resolving RPC')), 15_000),
      ),
    ]);

    assert.equal(code, 1);
    assert.ok(events.some((e) => e.type === 'emergency_stop'));
    assert.equal(events.some((e) => e.type === 'cancelled'), false);
    assert.ok(
      events.some(
        (e) =>
          e.type === 'run_error' &&
          (String((e as { error?: string }).error).includes('observation RPC timed out') ||
            String((e as { error?: string }).error).includes(
              'authoritative turn terminal was not observed',
            )),
      ),
    );

    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });
});
