import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { getRemoteSurface } from './remoteApproval.js';
import { BridgeServer } from './sessionServer.js';
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'transport-recovery-token';

describe('shared host-run transport recovery with authoritative approval lookup', () => {
  let server: BridgeServer;
  let tmp: string;
  let port = 0;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-transport-recovery-'));
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'transport-recovery',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          const surface = getRemoteSurface();
          if (!surface) {
            yield { type: 'failed', error: 'no surface' };
            return;
          }
          const allowInput = {
            action: { type: 'write_file' as const, path: 'held.txt', content: 'x' },
            thread_id: surface.threadId,
            turn_id: surface.turnId,
            cwd: surface.cwd,
            ...(surface.notify ? { notify: surface.notify } : {}),
          };
          const allowed = await surface.broker.requestAllowOnce(allowInput);
          yield {
            type: allowed ? 'done' : 'failed',
            answer: allowed ? 'ok' : undefined,
            error: allowed ? undefined : 'denied',
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
  });

  after(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits approval.pending and reconciled approval after transport loss without resubmitting the task', async () => {
    class ClosingWebSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { method?: string };
            if (message.method === 'permission.request') {
              setTimeout(() => this.close(), 25);
            }
          } catch {
            /* ignore */
          }
        });
      }
    }

    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'hold approval across transport loss',
        runId: 'transport-run',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        WebSocketImpl: ClosingWebSocket as typeof WebSocket,
      },
      (event) => events.push(event),
    );

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (
        events.some((e) => e.type === 'approval.required') &&
        events.some(
          (e) => e.type === 'approval.pending' && (e as { authoritative?: boolean }).authoritative,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(events.some((e) => e.type === 'approval.required'));
    assert.ok(
      events.some((e) => e.type === 'approval.pending' && (e as { authoritative?: boolean }).authoritative),
      'transport loss must surface authoritative approval.pending',
    );
    assert.ok(events.some((e) => e.type === 'transport.disconnected'));

    stdin.write(`${JSON.stringify({ decision: 'reconcile_pending_approval' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(events.some((e) => e.type === 'approval.reconciled'));

    const binding = (
      events.find((e) => e.type === 'approval.reconciled') as {
        item?: { approval?: Record<string, unknown> };
      }
    )?.item?.approval;
    assert.ok(binding);
    stdin.write(
      `${JSON.stringify({ decision: 'allow_once', approval: binding })}\n`,
    );
    const code = await runPromise;
    assert.equal(code, 0);
    assert.ok(events.some((e) => e.type === 'run_complete'));
    assert.equal(
      events.some((e) => e.type === 'run_error' && String((e as { error?: string }).error).includes('transport')),
      false,
      'reconciled recovery must not terminate with transport run_error',
    );
  });
});
