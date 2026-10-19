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
import { BridgeServer } from './sessionServer.js';
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'emergency-lifecycle-token';

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
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'emergency-lifecycle',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* hold until host cancels the turn */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
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

  async function waitForEvent(
    events: Record<string, unknown>[],
    type: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === type)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${type}; saw ${events.map((e) => e.type).join(',')}`);
  }

  it('completes after emergency ack when the socket closes with no terminal frame', async () => {
    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'hold for emergency close',
        runId: 'emergency-close',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        WebSocketImpl: EarlyCloseWebSocket as typeof WebSocket,
      },
      (event) => events.push(event),
    );

    await waitForEvent(events, 'transport.disconnected');
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung after emergency ack + socket close')), 15_000),
      ),
    ]);

    assert.equal(code, 0);
    assert.ok(events.some((e) => e.type === 'emergency_stop'));
    assert.ok(
      events.some((e) => e.type === 'cancelled' || e.type === 'run_complete'),
      'must observe or reconcile a terminal outcome after emergency ack',
    );
  });

  it('rejects emergency stop with an invalid host token without settling the turn', async () => {
    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'reject bad emergency token',
        runId: 'emergency-reject',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        WebSocketImpl: EarlyCloseWebSocket as typeof WebSocket,
      },
      (event) => events.push(event),
    );

    await waitForEvent(events, 'transport.disconnected');
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: 'not-the-token' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      events.some(
        (e) =>
          e.type === 'control.rejected' &&
          String((e as { error?: string }).error).toLowerCase().includes('emergency'),
      ),
    );
    assert.equal(events.some((e) => e.type === 'emergency_stop'), false);

    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );
    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung after valid emergency')), 15_000),
      ),
    ]);
    assert.equal(code, 0);
  });

  it('preserves a failed terminal outcome when failure arrives before emergency ack', async () => {
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
        task: 'fail fast then emergency',
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
  });
});

describe('shared host-run emergency stop terminal ordering on live socket', () => {
  let server: BridgeServer;
  let tmp: string;
  let configDir: string;
  let port = 0;
  let prevConfigDir: string | undefined;
  let prevRuns: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-emergency-ordering-'));
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
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'emergency-ordering',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise<void>(() => {
            /* cancelled by emergency */
          });
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
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

  it('observes cancelled terminal on the socket after emergency ack', async () => {
    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'emergency with live socket',
        runId: 'emergency-live-socket',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
      },
      (event) => events.push(event),
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const code = await Promise.race([
      runPromise,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('host-run hung waiting for post-emergency terminal')), 15_000),
      ),
    ]);

    assert.equal(code, 0);
    const emergencyIdx = events.findIndex((e) => e.type === 'emergency_stop');
    const cancelledIdx = events.findIndex((e) => e.type === 'cancelled');
    assert.ok(emergencyIdx >= 0);
    assert.ok(cancelledIdx >= 0, JSON.stringify(events.map((e) => e.type)));
    assert.ok(cancelledIdx >= emergencyIdx, 'terminal must not precede emergency ack on this path');
  });

  it('defers emergency HTTP until after a terminal frame is already on the wire', async () => {
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
          task: 'complete-before-emergency',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'answer_chunk', text: 'done' };
          yield {
            type: 'done',
            answer: 'done',
            status: 'completed',
            usage: {
              totalCostUSD: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalTokens: 0,
              modelBreakdown: {},
            },
          };
        } as ChatEngine['submitMessageStream'];
        return engine;
      },
    });
    await server.start(0);
    port = server.port;

    let emergencyHttpEntered = false;
    let releaseEmergencyHttp: (() => void) | undefined;
    const emergencyHttpGate = new Promise<void>((resolve) => {
      releaseEmergencyHttp = resolve;
    });
    const baseFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = init?.headers;
      const auth =
        headers && typeof headers === 'object' && headers !== null
          ? String((headers as Record<string, string>)['Authorization'] ?? '')
          : '';
      if (auth === `Bearer ${TOKEN}`) {
        emergencyHttpEntered = true;
        await emergencyHttpGate;
      }
      return baseFetch(input, init);
    };

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'terminal before emergency http',
        runId: 'terminal-before-emergency-http',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        fetchImpl,
      },
      (event) => events.push(event),
    );

    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === 'run_complete')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(events.some((e) => e.type === 'run_complete'), 'terminal must arrive before emergency HTTP proceeds');
    assert.equal(emergencyHttpEntered, true, 'emergency HTTP must be blocked behind the gate');
    releaseEmergencyHttp?.();

    const code = await runPromise;
    assert.equal(code, 0);
    assert.equal(events.filter((e) => e.type === 'run_complete').length, 1);
  });
});
