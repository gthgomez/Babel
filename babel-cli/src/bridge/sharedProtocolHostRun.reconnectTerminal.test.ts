import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createDeterministicBridgeEngineFactory } from './deterministicBridgeEngine.js';
import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { BridgeServer } from './sessionServer.js';
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'reconnect-terminal-token';

describe('shared host-run reconnect terminal reconciliation', () => {
  let server: BridgeServer;
  let tmp: string;
  let port = 0;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-reconnect-terminal-'));
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: createDeterministicBridgeEngineFactory(),
    });
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reconciles run_complete when the socket closes on open before submit settles', async () => {
    class EarlyCloseWebSocket extends WebSocket {
      #closed = false;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('open', () => {
          if (!this.#closed) {
            this.#closed = true;
            setTimeout(() => this.close(), 5);
          }
        });
      }
    }

    const events: Record<string, unknown>[] = [];
    const code = await executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'complete during reconnect gap',
        runId: 'gap-run',
        desktopClientId: desktopId,
        desktopProofKey,
        WebSocketImpl: EarlyCloseWebSocket as typeof WebSocket,
      },
      (event) => events.push(event),
    );

    assert.equal(code, 0);
    const complete = events.find((e) => e.type === 'run_complete') as {
      result?: { reconciled_from_host?: boolean };
    };
    assert.ok(complete, JSON.stringify(events.map((e) => e.type)));
    assert.equal(complete.result?.reconciled_from_host, true);
    assert.equal(
      events.filter((e) => e.type === 'run_complete').length,
      1,
      'must not require a duplicate synthetic terminal event',
    );
  });

  it('reconciles run_complete when the turn finishes during reconnect subscription', async () => {
    let connection = 0;
    class ReconnectRaceWebSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        connection += 1;
        this.addEventListener('open', () => {
          if (connection === 1) {
            setTimeout(() => this.close(), 15);
          }
        });
      }
    }

    const events: Record<string, unknown>[] = [];
    const code = await executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'finish during reconnect subscription',
        runId: 'during-open-run',
        desktopClientId: desktopId,
        desktopProofKey,
        WebSocketImpl: ReconnectRaceWebSocket as typeof WebSocket,
      },
      (event) => events.push(event),
    );

    assert.equal(code, 0);
    const complete = events.find((e) => e.type === 'run_complete') as {
      result?: { reconciled_from_host?: boolean };
    };
    assert.ok(complete, JSON.stringify(events.map((e) => e.type)));
    assert.equal(
      events.filter((e) => e.type === 'run_complete').length,
      1,
      'turn must settle exactly once when completion races reconnect subscription',
    );
  });
});
