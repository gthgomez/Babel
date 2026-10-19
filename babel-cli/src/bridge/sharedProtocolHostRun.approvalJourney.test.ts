import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
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

const TOKEN = 'approval-journey-token';

describe('shared host-run approval journey (broker → NDJSON → stdin decide)', () => {
  let server: BridgeServer;
  let tmp: string;
  let port = 0;
  let prevRuns: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-approval-journey-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
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
          task: 'approval-journey',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          const surface = getRemoteSurface();
          if (!surface) {
            yield { type: 'failed', error: 'remote surface missing' };
            return;
          }
          const allowInput = {
            action: { type: 'write_file' as const, path: 'approval-journey.txt', content: 'probe' },
            thread_id: surface.threadId,
            turn_id: surface.turnId,
            cwd: surface.cwd,
            ...(surface.notify ? { notify: surface.notify } : {}),
          };
          const allowed = await surface.broker.requestAllowOnce(allowInput);
          if (!allowed) {
            yield { type: 'failed', error: 'approval denied' };
            return;
          }
          yield {
            type: 'done',
            answer: 'approved',
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
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('completes after approval.required and fenced allow_once on stdin', async () => {
    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    let approvalBinding: Record<string, unknown> | null = null;
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'trigger approval',
        runId: 'approval-run-1',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
      },
      (event) => {
        events.push(event);
        if (event.type === 'approval.required' && event.item && typeof event.item === 'object') {
          const item = event.item as { approval?: Record<string, unknown> };
          if (item.approval) approvalBinding = item.approval;
        }
      },
    );

    const deadline = Date.now() + 20_000;
    while (!approvalBinding && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(approvalBinding, 'expected approval.required from broker notify');
    stdin.write(
      `${JSON.stringify({ decision: 'allow_once', approval: approvalBinding })}\n`,
    );
    const code = await runPromise;
    assert.equal(code, 0);
    assert.ok(events.some((e) => e.type === 'run_complete'));
  });
});
