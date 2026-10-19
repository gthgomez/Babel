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

type HostRunEvent = Record<string, unknown>;

function createHostRunEventGate() {
  const events: HostRunEvent[] = [];
  const waiters: Array<{
    predicate: (event: HostRunEvent, all: HostRunEvent[]) => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const matches = (
    predicate: (event: HostRunEvent, all: HostRunEvent[]) => boolean,
  ): boolean => events.some((entry, index) => predicate(entry, events.slice(0, index + 1)));

  const flushWaiters = () => {
    const pending = waiters.splice(0, waiters.length);
    for (const waiter of pending) {
      if (matches(waiter.predicate)) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  };

  const write = (event: HostRunEvent) => {
    events.push(event);
    flushWaiters();
  };

  const waitFor = (
    predicate: (event: HostRunEvent, all: HostRunEvent[]) => boolean,
    label: string,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      if (matches(predicate)) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for host-run event: ${label}`)),
        20_000,
      );
      waiters.push({
        predicate,
        resolve,
        reject,
        timer,
      });
    });

  return { events, write, waitFor };
}

type RpcOpCounters = { reached: number; aborted: number; completed: number };

function createRpcOpCounters(): RpcOpCounters {
  return { reached: 0, aborted: 0, completed: 0 };
}

type PrimarySocketHolder = { socket: WebSocket | null };

function createPrimarySocketHolder(): PrimarySocketHolder {
  return { socket: null };
}

function closePrimarySocket(holder: PrimarySocketHolder): void {
  try {
    holder.socket?.close();
  } catch {
    /* ignore */
  }
}

function makeTrackingWebSocket(holder: PrimarySocketHolder): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      holder.socket = this;
    }
  } as typeof WebSocket;
}

function createAbortAwareRpcHang(
  rpcMethod: string,
  whenHang: () => boolean,
  counters: RpcOpCounters,
  baseFetch: typeof fetch,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (whenHang() && url.includes('/rpc') && body.includes(`"${rpcMethod}"`)) {
      counters.reached += 1;
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error(`${rpcMethod} missing abort signal`));
          return;
        }
        if (signal.aborted) {
          counters.aborted += 1;
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            counters.aborted += 1;
            reject(signal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
      counters.completed += 1;
    }
    return baseFetch(input, init);
  };
}

function hangRpcWhenEmergency(
  emergencyAcked: () => boolean,
  rpcMethod: string,
  baseFetch: typeof fetch,
  counters?: RpcOpCounters,
): typeof fetch {
  const stats = counters ?? createRpcOpCounters();
  return createAbortAwareRpcHang(rpcMethod, emergencyAcked, stats, baseFetch);
}

async function waitForRpcCounter(
  counters: RpcOpCounters,
  field: keyof RpcOpCounters,
  expected: number,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && counters[field] < expected) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    counters[field],
    expected,
    `Timed out waiting for RPC counter ${label} (${field}=${counters[field]}, expected ${expected})`,
  );
}

function withDelayedWsTicket(delayMs: number, baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (String(input).includes('/ws/ticket')) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return baseFetch(input, init);
  };
}

function wrapFetchForSettledCatalogAfterEmergency(
  baseFetch: typeof fetch,
  emergencyAcked: () => boolean,
  threadId: string,
): typeof fetch {
  return async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (emergencyAcked() && body.includes('"remote.catalog"')) {
      const response = await baseFetch(input, init);
      const payload = (await response.json()) as {
        result?: { sessions?: Array<Record<string, unknown>> };
      };
      if (payload.result?.sessions) {
        payload.result.sessions = payload.result.sessions.map((session) => {
          if (threadId !== '*' && session.thread_id !== threadId) return session;
          return {
            ...session,
            status: 'completed',
            active_turn: false,
            active_turn_id: undefined,
          };
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: payload.result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return baseFetch(input, init);
  };
}

function makeDisconnectFirstOpenWebSocket(armed: () => boolean): typeof WebSocket {
  let opens = 0;
  return class extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('open', () => {
        opens += 1;
        if (opens === 1 && armed()) {
          this.close();
        }
      });
    }
  } as typeof WebSocket;
}

function makeRecoveryStallWebSocket(stallRecoveryConnect: () => boolean): typeof WebSocket {
  const RealWebSocket = WebSocket;
  let openCount = 0;
  const RecoveryStallWebSocket = function (
    url: string | URL,
    protocols?: string | string[],
  ): WebSocket {
    openCount += 1;
    if (stallRecoveryConnect() && openCount > 1) {
      return {
        addEventListener() {},
        removeEventListener() {},
        close() {},
      } as unknown as WebSocket;
    }
    return new RealWebSocket(url, protocols);
  };
  return RecoveryStallWebSocket as unknown as typeof WebSocket;
}

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

describe('shared host-run emergency stop lifecycle', { concurrency: 1 }, () => {
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

  it('observes persisted cancelled terminal and releases active turn after emergency ack', async () => {
    const stdin = new PassThrough();
    const gate = createHostRunEventGate();
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'cooperative cancel',
        runId: 'emergency-persisted-cancel',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
      },
      gate.write,
    );

    await gate.waitFor((event) => event.type === 'run_start', 'run_start');
    await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );
    await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
    await gate.waitFor((event) => event.type === 'cancelled', 'authoritative_cancelled_stream');

    const code = await runPromise;
    assert.equal(code, 0);
    assert.equal(gate.events.filter((e) => e.type === 'cancelled').length, 1);
    assert.equal(gate.events.some((e) => e.type === 'run_error'), false);

    const client = new HttpProtocolClient({
      baseUrl: `http://127.0.0.1:${port}`,
      desktopClientId: desktopId,
      desktopProofKey,
    });
    const catalog = await client.call<
      'remote.catalog',
      Record<string, never>,
      { sessions: Array<{ thread_id: string; active_turn: boolean; active_turn_id?: number }> }
    >('remote.catalog', {});
    const session =
      catalog.sessions.find((row) => row.active_turn === false) ?? catalog.sessions.at(-1);
    assert.ok(session?.thread_id);
    const turnId = session.active_turn_id ?? 1;
    const terminal = await hostTurnTerminal(
      port,
      desktopId,
      desktopProofKey,
      session.thread_id,
      turnId,
    );
    assert.equal(terminal?.event_type, 'cancelled');
    assert.equal(terminal?.turn_id, turnId);

    const row = await hostCatalogRow(port, desktopId, desktopProofKey, session.thread_id);
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

describe('shared host-run emergency observation errors (mocked authoritative backend)', { concurrency: 1 }, () => {
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

  it('fails closed when approval.lookup never resolves after emergency ack', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-approval-hang-'));
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
          task: 'approval-hang',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const primarySocketHolder = createPrimarySocketHolder();
    const approvalCounters = createRpcOpCounters();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = hangRpcWhenEmergency(
      () => emergencyAcked,
      'approval.lookup',
      baseFetch,
      approvalCounters,
    );

    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'approval hang',
          runId: 'emergency-approval-hang',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: class extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              primarySocketHolder.socket = this;
            }
          } as typeof WebSocket,
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 500,
          emergencyObservationPassLimit: 4,
          emergencyPerOpRpcTimeoutOnlyForLabel: 'approval.lookup',
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            try {
              closePrimarySocket(primarySocketHolder);
            } catch {
              /* ignore */
            }
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      await waitForRpcCounter(
        approvalCounters,
        'reached',
        1,
        'approval.lookup hang after emergency ack',
      );

      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await Promise.race([
        runPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('host-run hung on approval.lookup')), 2_000),
        ),
      ]);

      assert.equal(code, 1);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
      assert.equal(approvalCounters.aborted, 1);
      assert.equal(approvalCounters.completed, 0);
      assert.ok(
        gate.events.some(
          (e) =>
            e.type === 'run_error' &&
            String((e as { error?: string }).error).includes('approval.lookup'),
        ),
      );
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('times out ws transport reopen before approval.lookup when ticket setup is delayed without label isolation', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-approval-ticket-race-'));
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
          task: 'approval-ticket-race',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const primarySocketHolder = createPrimarySocketHolder();
    const approvalCounters = createRpcOpCounters();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = hangRpcWhenEmergency(
      () => emergencyAcked,
      'approval.lookup',
      withDelayedWsTicket(50, baseFetch),
      approvalCounters,
    );

    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'approval ticket race',
          runId: 'emergency-approval-ticket-race',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: makeTrackingWebSocket(primarySocketHolder),
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 500,
          emergencyObservationPassLimit: 4,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            closePrimarySocket(primarySocketHolder);
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      await gate.waitFor((event) => event.type === 'run_error', 'ws_reopen_timeout_run_error');

      const code = await Promise.race([
        runPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('host-run hung on ticket race')), 3_000),
        ),
      ]);

      assert.equal(code, 1);
      assert.equal(approvalCounters.reached, 0);
      assert.equal(approvalCounters.aborted, 0);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
      assert.ok(
        gate.events.some(
          (e) =>
            e.type === 'run_error' &&
            String((e as { error?: string }).error).includes('ws transport reopen'),
        ),
      );
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('still reaches approval.lookup hang when ticket setup is delayed but per-op timeout is label-isolated', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-approval-ticket-isolated-'));
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
          task: 'approval-ticket-isolated',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const primarySocketHolder = createPrimarySocketHolder();
    const approvalCounters = createRpcOpCounters();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = hangRpcWhenEmergency(
      () => emergencyAcked,
      'approval.lookup',
      withDelayedWsTicket(50, baseFetch),
      approvalCounters,
    );

    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'approval ticket isolated',
          runId: 'emergency-approval-ticket-isolated',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: makeTrackingWebSocket(primarySocketHolder),
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 500,
          emergencyObservationPassLimit: 4,
          emergencyPerOpRpcTimeoutOnlyForLabel: 'approval.lookup',
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            closePrimarySocket(primarySocketHolder);
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      await waitForRpcCounter(
        approvalCounters,
        'reached',
        1,
        'approval.lookup hang with delayed ticket',
      );
      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await Promise.race([
        runPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('host-run hung on isolated ticket delay')), 3_000),
        ),
      ]);

      assert.equal(code, 1);
      assert.equal(approvalCounters.aborted, 1);
      assert.equal(approvalCounters.completed, 0);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
      assert.ok(
        gate.events.some(
          (e) =>
            e.type === 'run_error' &&
            String((e as { error?: string }).error).includes('approval.lookup'),
        ),
      );
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('aborts approval.lookup that started before emergency ack when the observation scope fires', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-approval-pre-ack-'));
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
          task: 'approval-pre-ack',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const approvalCounters = createRpcOpCounters();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = createAbortAwareRpcHang(
      'approval.lookup',
      () => true,
      approvalCounters,
      baseFetch,
    );

    const primarySocketHolder = createPrimarySocketHolder();
    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'approval pre-ack race',
          runId: 'emergency-approval-pre-ack',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: class extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              primarySocketHolder.socket = this;
            }
          } as typeof WebSocket,
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 75,
          emergencyObservationPassLimit: 4,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') emergencyAcked = true;
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      try {
        closePrimarySocket(primarySocketHolder);
      } catch {
        /* ignore */
      }
      const reachedDeadline = Date.now() + 3_000;
      while (Date.now() < reachedDeadline && approvalCounters.reached < 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(approvalCounters.reached, 1);
      assert.equal(emergencyAcked, false);

      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await Promise.race([
        runPromise,
        new Promise<number>((_, reject) =>
          setTimeout(
            () => reject(new Error('host-run hung on pre-ack approval.lookup')),
            2_000,
          ),
        ),
      ]);

      assert.equal(code, 1);
      assert.equal(approvalCounters.aborted, 1);
      assert.equal(approvalCounters.completed, 0);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('fails closed when ws ticket mint never completes after emergency ack', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-ticket-hang-'));
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
          task: 'ticket-hang',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles — recovery must observe ticket hang */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const ticketCounters = createRpcOpCounters();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (emergencyAcked && url.includes('/ws/ticket')) {
        ticketCounters.reached += 1;
        await new Promise<void>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('ws ticket missing abort signal'));
            return;
          }
          if (signal.aborted) {
            ticketCounters.aborted += 1;
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              ticketCounters.aborted += 1;
              reject(signal.reason ?? new Error('aborted'));
            },
            { once: true },
          );
        });
        ticketCounters.completed += 1;
      }
      return baseFetch(input, init);
    };
    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    const primarySocketHolder = createPrimarySocketHolder();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'ticket hang',
          runId: 'emergency-ticket-hang',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: class extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              primarySocketHolder.socket = this;
            }
          } as typeof WebSocket,
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 75,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            setTimeout(() => {
              try {
                closePrimarySocket(primarySocketHolder);
              } catch {
                /* ignore */
              }
            }, 5);
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      const ticketDeadline = Date.now() + 5_000;
      while (Date.now() < ticketDeadline && ticketCounters.reached < 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(ticketCounters.reached, 1);
      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await runPromise;

      assert.equal(code, 1);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
      assert.ok(gate.events.some((e) => e.type === 'run_error'));
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('preserves authoritative terminal when it arrives before the observation deadline', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-terminal-race-'));
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
      engineFactory: (descriptor) => cooperativeCancelEngine(descriptor, 'terminal-race'),
    });
    await server.start(0);
    const port = server.port;

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'terminal race',
        runId: 'emergency-terminal-race',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        WebSocketImpl: class extends WebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            this.addEventListener('open', () => setTimeout(() => this.close(), 5));
          }
        } as typeof WebSocket,
        emergencyObservationDeadlineMs: 2_000,
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
        setTimeout(() => reject(new Error('host-run hung on terminal race')), 10_000),
      ),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(code, 0);
    assert.equal(events.filter((e) => e.type === 'cancelled').length, 1);
    assert.equal(events.filter((e) => e.type === 'run_error').length, 0);

    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('fails closed when history.lookup never resolves after emergency ack', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-history-hang-'));
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
          task: 'history-hang',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const primarySocketHolder = createPrimarySocketHolder();
    const historyCounters = createRpcOpCounters();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = hangRpcWhenEmergency(
      () => emergencyAcked,
      'history.lookup',
      wrapFetchForSettledCatalogAfterEmergency(baseFetch, () => emergencyAcked, '*'),
      historyCounters,
    );
    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'history hang',
          runId: 'emergency-history-hang',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: class extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              primarySocketHolder.socket = this;
            }
          } as typeof WebSocket,
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 75,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            setTimeout(() => {
              try {
                closePrimarySocket(primarySocketHolder);
              } catch {
                /* ignore */
              }
            }, 5);
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      const historyDeadline = Date.now() + 5_000;
      while (Date.now() < historyDeadline && historyCounters.reached < 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(historyCounters.reached >= 1);
      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await runPromise;
      assert.equal(code, 1);
      assert.ok(historyCounters.aborted >= 1);
      assert.equal(historyCounters.completed, 0);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
      const historyRunError = gate.events.find((e) => e.type === 'run_error');
      assert.ok(historyRunError);
      assert.ok(
        historyCounters.aborted >= 1 ||
          String((historyRunError as { error?: string }).error).includes('history.lookup'),
      );
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('fails closed when verification.lookup never resolves after emergency ack', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-verification-hang-'));
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
          task: 'verification-hang',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const primarySocketHolder = createPrimarySocketHolder();
    const verificationCounters = createRpcOpCounters();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (emergencyAcked && url.includes('/rpc')) {
        if (body.includes('"history.lookup"')) {
          const params = JSON.parse(body).params as { thread_id: string; turn_id?: number };
          const turnId = params.turn_id ?? 1;
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                turn_terminal: {
                  turn_id: turnId,
                  event_type: 'done',
                  outcome: 'VERIFIED_COMPLETE',
                  answer: 'fixture',
                  status: 'completed',
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (body.includes('"verification.lookup"')) {
          return hangRpcWhenEmergency(
            () => true,
            'verification.lookup',
            wrapFetchForSettledCatalogAfterEmergency(baseFetch, () => true, '*'),
            verificationCounters,
          )(input, init);
        }
        return wrapFetchForSettledCatalogAfterEmergency(baseFetch, () => emergencyAcked, '*')(
          input,
          init,
        );
      }
      return baseFetch(input, init);
    };

    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'verification hang',
          runId: 'emergency-verification-hang',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: class extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              primarySocketHolder.socket = this;
            }
          } as typeof WebSocket,
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 75,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            setTimeout(() => {
              try {
                closePrimarySocket(primarySocketHolder);
              } catch {
                /* ignore */
              }
            }, 5);
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      const verificationDeadline = Date.now() + 5_000;
      while (Date.now() < verificationDeadline && verificationCounters.reached < 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(verificationCounters.reached >= 1);
      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await runPromise;
      assert.equal(code, 1);
      assert.ok(verificationCounters.aborted >= 1);
      assert.equal(verificationCounters.completed, 0);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
      const verificationRunError = gate.events.find((e) => e.type === 'run_error');
      assert.ok(verificationRunError);
      assert.ok(
        verificationCounters.aborted >= 1 ||
          String((verificationRunError as { error?: string }).error).includes(
            'verification.lookup',
          ),
      );
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('fails closed when WebSocket open never completes during recovery after emergency ack', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-ws-open-hang-'));
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
          task: 'ws-open-hang',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles — avoid competing cancelled terminal */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const primarySocketHolder = createPrimarySocketHolder();
    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'ws open hang',
          runId: 'emergency-ws-open-hang',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          WebSocketImpl: (() => {
            const RecoveryStall = makeRecoveryStallWebSocket(() => emergencyAcked);
            return function (url: string | URL, protocols?: string | string[]) {
              const socket = new RecoveryStall(url, protocols);
              primarySocketHolder.socket = socket;
              return socket;
            } as unknown as typeof WebSocket;
          })(),
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 75,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            setTimeout(() => {
              try {
                closePrimarySocket(primarySocketHolder);
              } catch {
                /* ignore */
              }
            }, 5);
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await runPromise;
      assert.equal(code, 1);
      assert.equal(gate.events.some((e) => e.type === 'cancelled'), false);
      assert.ok(
        gate.events.some(
          (e) =>
            e.type === 'run_error' &&
            (String((e as { error?: string }).error).includes('ws transport reopen') ||
              String((e as { error?: string }).error).includes('WebSocket transport observation')),
        ),
      );
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  it('does not emit cancelled after observation run_error settles', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-no-late-cancel-'));
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
          task: 'no-late-cancel',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* never settles — observation error must not be replaced by cancelled */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    const port = server.port;

    let emergencyAcked = false;
    const primarySocketHolder = createPrimarySocketHolder();
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = hangRpcWhenEmergency(
      () => emergencyAcked,
      'history.lookup',
      wrapFetchForSettledCatalogAfterEmergency(baseFetch, () => emergencyAcked, '*'),
    );
    const gate = createHostRunEventGate();
    const stdin = new PassThrough();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'no late cancel',
          runId: 'emergency-no-late-cancel',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          fetchImpl,
          WebSocketImpl: class extends WebSocket {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              primarySocketHolder.socket = this;
            }
          } as typeof WebSocket,
          observationRpcTimeoutMs: 25,
          emergencyObservationDeadlineMs: 75,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') {
            emergencyAcked = true;
            setTimeout(() => {
              try {
                closePrimarySocket(primarySocketHolder);
              } catch {
                /* ignore */
              }
            }, 5);
          }
        },
      );

      await gate.waitFor((event) => event.type === 'run_start', 'run_start');
      await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
      await gate.waitFor((event) => event.type === 'run_error', 'observation_run_error');

      const code = await runPromise;
      assert.equal(code, 1);
      const runErrorCount = gate.events.filter((e) => e.type === 'run_error').length;
      const cancelledCount = gate.events.filter((e) => e.type === 'cancelled').length;
      assert.equal(runErrorCount, 1);
      assert.equal(cancelledCount, 0);

      await new Promise<void>((resolve, reject) => {
        let ticks = 0;
        const pump = () => {
          ticks += 1;
          if (ticks >= 64) {
            resolve();
            return;
          }
          setImmediate(pump);
        };
        setImmediate(pump);
        setTimeout(() => reject(new Error('late-cancel drain timed out')), 5_000);
      });

      assert.equal(gate.events.filter((e) => e.type === 'cancelled').length, 0);
      assert.equal(gate.events.filter((e) => e.type === 'run_error').length, 1);
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env['BABEL_CONFIG_DIR'];
      delete process.env['BABEL_RUNS_DIR'];
    }
  });

  for (const scenario of [
    {
      name: 'failed',
      streamType: 'run_error',
      exitCode: 1,
      terminalYield: { type: 'failed' as const, error: 'live failed during pre-ack approval' },
    },
    {
      name: 'cancelled',
      streamType: 'cancelled',
      exitCode: 0,
      terminalYield: { type: 'cancelled' as const },
    },
    {
      name: 'done',
      streamType: 'run_complete',
      exitCode: 0,
      terminalYield: { type: 'done' as const, answer: 'live done during pre-ack approval' },
    },
  ]) {
    it(`aborts pending pre-ACK approval when live ${scenario.name} terminal arrives on socket`, async () => {
      const tmp = mkdtempSync(join(tmpdir(), `babel-emergency-live-${scenario.name}-`));
      const configDir = join(tmp, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
      process.env['BABEL_CONFIG_DIR'] = configDir;
      process.env['BABEL_RUNS_DIR'] = tmp;

      const terminalGate: { release: (() => void) | null } = { release: null };
      const server = new BridgeServer({
        authToken: TOKEN,
        allowedWorkspaceRoot: tmp,
        allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
        enforceControlLease: true,
        desktopControllerClientId: desktopId,
        desktopControllerProofKey: desktopProofKey,
        engineFactory: (descriptor) => {
          const engine = new ChatEngine({
            task: `live-${scenario.name}-during-pre-ack`,
            projectRoot: descriptor.projectRoot,
            executionProfile: 'chat',
          });
          engine.submitMessageStream = async function* () {
            yield { type: 'thinking' };
            await new Promise<void>((resolve) => {
              terminalGate.release = resolve;
            });
            yield scenario.terminalYield;
          } as ChatEngine['submitMessageStream'];
          return engine;
        },
      });
      await server.start(0);
      const port = server.port;

      const approvalCounters = createRpcOpCounters();
      const baseFetch = globalThis.fetch.bind(globalThis);
      const fetchImpl = createAbortAwareRpcHang(
        'approval.lookup',
        () => true,
        approvalCounters,
        baseFetch,
      );

      const primarySocketHolder = createPrimarySocketHolder();
      const gate = createHostRunEventGate();
      const stdin = new PassThrough();
      try {
        const runPromise = executeSharedProtocolHostRun(
          {
            port,
            projectRoot: tmp,
            task: `live ${scenario.name} pre-ack`,
            runId: `emergency-live-${scenario.name}-pre-ack`,
            desktopClientId: desktopId,
            desktopProofKey,
            stdin,
            fetchImpl,
            WebSocketImpl: class extends WebSocket {
              constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                primarySocketHolder.socket = this;
              }
            } as typeof WebSocket,
            observationRpcTimeoutMs: 25,
            emergencyObservationDeadlineMs: 75,
            emergencyObservationPassLimit: 4,
          },
          gate.write,
        );

        await gate.waitFor((event) => event.type === 'run_start', 'run_start');
        await gate.waitFor((event) => event.type === 'thought', 'turn_stream_active');
        try {
          closePrimarySocket(primarySocketHolder);
        } catch {
          /* ignore */
        }
        const approvalDeadline = Date.now() + 3_000;
        while (Date.now() < approvalDeadline && approvalCounters.reached < 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(approvalCounters.reached >= 1);

        stdin.write(
          `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
        );
        await gate.waitFor((event) => event.type === 'emergency_stop', 'emergency_stop');
        terminalGate.release?.();

        const code = await Promise.race([
          runPromise,
          new Promise<number>((_, reject) =>
            setTimeout(
              () => reject(new Error(`host-run hung after live ${scenario.name} terminal`)),
              2_000,
            ),
          ),
        ]);

        assert.equal(code, scenario.exitCode);
        assert.ok(approvalCounters.aborted >= 1);
        assert.equal(approvalCounters.completed, 0);
        assert.equal(
          gate.events.filter((e) => e.type === scenario.streamType).length,
          1,
          `expected one ${scenario.streamType}`,
        );
        assert.equal(
          gate.events.filter((e) =>
            ['run_complete', 'run_error', 'cancelled'].includes(String(e.type)),
          ).length,
          1,
          'exactly one terminal stream event',
        );
      } finally {
        await server.stop();
        rmSync(tmp, { recursive: true, force: true });
        delete process.env['BABEL_CONFIG_DIR'];
        delete process.env['BABEL_RUNS_DIR'];
      }
    });
  }
});
