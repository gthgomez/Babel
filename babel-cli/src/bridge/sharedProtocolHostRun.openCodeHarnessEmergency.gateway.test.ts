/**
 * OpenCode harness descriptor emergency host-run matrix (real subprocess fixtures).
 * Mirrors mocked chat-engine observation contracts: bounded recovery, no fabricated cancel.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';

import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { BridgeServer } from './sessionServer.js';
import {
  executeSharedProtocolHostRun,
  type SharedProtocolHostRunOptions,
} from './sharedProtocolHostRun.js';

type HostRunWebSocketCtor = NonNullable<SharedProtocolHostRunOptions['WebSocketImpl']>;

const TOKEN = 'opencode-harness-emergency-token';
const HANG_PEER = fileURLToPath(
  new URL('../../test/fixtures/opencode-acp-prompt-hang-peer.mjs', import.meta.url),
);
const OC_VERSION = fileURLToPath(
  new URL('../../test/fixtures/opencode-version.mjs', import.meta.url),
);

type HostRunEvent = Record<string, unknown>;

function createHostRunEventGate() {
  const events: HostRunEvent[] = [];
  const waiters: Array<{
    predicate: (event: HostRunEvent) => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const write = (event: HostRunEvent) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (events.some(waiter.predicate)) {
        clearTimeout(waiter.timer);
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        waiter.resolve();
      }
    }
  };

  const waitFor = (predicate: (event: HostRunEvent) => boolean, label: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (events.some(predicate)) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for host-run event: ${label}`)),
        25_000,
      );
      waiters.push({ predicate, resolve, reject, timer });
    });

  return { events, write, waitFor };
}

type PrimarySocketHolder = { socket: WebSocket | null };

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

async function startOpenCodeHarnessBridge(
  peerEnv: Record<string, string>,
  desktopId: string,
  desktopProofKey: string,
): Promise<{ server: BridgeServer; tmp: string; port: number }> {
  const tmp = mkdtempSync(join(tmpdir(), 'babel-oc-harness-emergency-'));
  const configDir = join(tmp, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
  process.env['BABEL_CONFIG_DIR'] = configDir;
  process.env['BABEL_RUNS_DIR'] = tmp;

  const server = new BridgeServer({
    authToken: TOKEN,
    allowedWorkspaceRoot: tmp,
    allowedOrigins: ['http://127.0.0.1:*'],
    enforceControlLease: true,
    desktopControllerClientId: desktopId,
    desktopControllerProofKey: desktopProofKey,
    openCodeTestLaunch: {
      command: process.execPath,
      args: [HANG_PEER],
      env: peerEnv,
    },
    openCodeInstallProbe: async () => ({
      state: 'verified' as const,
      executable: OC_VERSION,
      version: '1.0.0',
    }),
  });
  await server.start(0);
  return { server, tmp, port: server.port };
}

async function cleanup(server: BridgeServer, tmp: string, stdin: PassThrough): Promise<void> {
  try {
    stdin.end();
    stdin.destroy();
  } catch {
    /* ignore */
  }
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env['BABEL_CONFIG_DIR'];
  delete process.env['BABEL_RUNS_DIR'];
}

describe('OpenCode harness host-run emergency observation (subprocess fixtures)', { concurrency: 1 }, () => {
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  it('fails closed without fabricated cancelled when owned child ignores cancel and transport is lost', async () => {
    const { server, tmp, port } = await startOpenCodeHarnessBridge(
      { BABEL_OPENCODE_FIXTURE_IGNORE_CANCEL: '1' },
      desktopId,
      desktopProofKey,
    );
    const stdin = new PassThrough();
    const primarySocketHolder: PrimarySocketHolder = { socket: null };
    const gate = createHostRunEventGate();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'opencode never settles',
          runId: 'oc-harness-never-settle',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          harnessAdapterId: 'opencode',
          WebSocketImpl: makeTrackingWebSocket(
            primarySocketHolder,
          ) as unknown as HostRunWebSocketCtor,
          emergencyObservationPassLimit: 2,
          emergencyObservationDeadlineMs: 3_000,
          observationRpcTimeoutMs: 500,
        },
        (event) => {
          gate.write(event);
          if (event.type === 'emergency_stop') closePrimarySocket(primarySocketHolder);
        },
      );

      await gate.waitFor(
        (e) => e.type === 'thought' || e.type === 'thinking',
        'turn_stream_active',
      );
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );

      const code = await runPromise;
      const events = gate.events;
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
    } finally {
      await cleanup(server, tmp, stdin);
    }
  });

  it('fails closed on observation RPC timeout without fabricated cancelled (open primary transport)', async () => {
    const { server, tmp, port } = await startOpenCodeHarnessBridge(
      { BABEL_OPENCODE_FIXTURE_IGNORE_CANCEL: '1' },
      desktopId,
      desktopProofKey,
    );
    const stdin = new PassThrough();
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

    const gate = createHostRunEventGate();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'opencode rpc hang',
          runId: 'oc-harness-rpc-hang',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          harnessAdapterId: 'opencode',
          fetchImpl,
          observationRpcTimeoutMs: 200,
          emergencyObservationDeadlineMs: 5_000,
        },
        gate.write,
      );

      await gate.waitFor(
        (e) => e.type === 'thought' || e.type === 'thinking',
        'turn_stream_active',
      );
      hangLookup = true;
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );

      const code = await runPromise;
      const events = gate.events;
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
    } finally {
      await cleanup(server, tmp, stdin);
    }
  });

  it('observes delayed harness cancelled on the primary transport without recovery wake', async () => {
    const { server, tmp, port } = await startOpenCodeHarnessBridge(
      { BABEL_OPENCODE_FIXTURE_CANCEL_SETTLE_DELAY_MS: '350' },
      desktopId,
      desktopProofKey,
    );
    const stdin = new PassThrough();
    const gate = createHostRunEventGate();
    try {
      const runPromise = executeSharedProtocolHostRun(
        {
          port,
          projectRoot: tmp,
          task: 'opencode delayed cancel',
          runId: 'oc-harness-delayed-cancel',
          desktopClientId: desktopId,
          desktopProofKey,
          stdin,
          harnessAdapterId: 'opencode',
        },
        gate.write,
      );

      await gate.waitFor(
        (e) => e.type === 'thought' || e.type === 'thinking',
        'turn_stream_active',
      );
      stdin.write(
        `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
      );
      await gate.waitFor((e) => e.type === 'emergency_stop', 'emergency_stop');

      const code = await runPromise;
      const events = gate.events;
      assert.equal(code, 0);
      assert.equal(events.filter((e) => e.type === 'emergency_stop').length, 1);
      assert.equal(events.filter((e) => e.type === 'cancelled').length, 1);
      assert.equal(events.some((e) => e.type === 'run_error'), false);
      const ackAt = events.findIndex((e) => e.type === 'emergency_stop');
      const cancelledAt = events.findIndex((e) => e.type === 'cancelled');
      assert.ok(ackAt >= 0 && cancelledAt > ackAt);
    } finally {
      await cleanup(server, tmp, stdin);
    }
  });
});
