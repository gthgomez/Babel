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

const TOKEN = 'catalog-await-token';

describe('shared host-run catalog await interleaving', () => {
  let server: BridgeServer;
  let tmp: string;
  let port = 0;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-catalog-await-'));
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

  it('emits exactly one terminal when completion races the second catalog await', async () => {
    let connection = 0;
    class CatalogAwaitWebSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        connection += 1;
        this.addEventListener('open', () => {
          if (connection === 1) {
            setTimeout(() => this.close(), 12);
          }
        });
      }
    }

    const events: Record<string, unknown>[] = [];
    const code = await executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'race catalog await',
        runId: 'catalog-await-run',
        desktopClientId: desktopId,
        desktopProofKey,
        WebSocketImpl: CatalogAwaitWebSocket as typeof WebSocket,
      },
      (event) => events.push(event),
    );

    assert.equal(code, 0);
    const terminals = events.filter((e) =>
      ['run_complete', 'run_error', 'cancelled'].includes(String(e.type)),
    );
    assert.equal(terminals.length, 1, JSON.stringify(events.map((e) => e.type)));
    assert.equal(terminals[0]?.type, 'run_complete');
  });
});
