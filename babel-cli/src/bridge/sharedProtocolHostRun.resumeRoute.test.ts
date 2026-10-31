import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { BridgeServer } from './sessionServer.js';
import { assertResumeRouteCompatible, executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'resume-route-token';

describe('shared host-run resume route compatibility', () => {
  let server: BridgeServer;
  let tmp: string;
  let port = 0;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-resume-route-'));
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({ inferenceOwner: 'external-harness',
          task: 'resume-route',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield {
            type: 'done',
            answer: 'ok',
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

  it('allows production-style second turn when model and provider match the saved thread route', async () => {
    const events: Record<string, unknown>[] = [];
    const route = { provider: 'openrouter', model: 'deepseek/fixture' };
    const firstCode = await executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'first',
        runId: 'resume-route-1',
        desktopClientId: desktopId,
        desktopProofKey,
        ...route,
      },
      (event) => events.push(event),
    );
    assert.equal(firstCode, 0);
    const threadId = String(
      (events.find((e) => e.type === 'run_complete') as { result?: { session_id?: string } })
        ?.result?.session_id ?? '',
    );
    assert.ok(threadId);

    const secondEvents: Record<string, unknown>[] = [];
    const secondCode = await executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'second',
        runId: 'resume-route-2',
        resumeThreadId: threadId,
        desktopClientId: desktopId,
        desktopProofKey,
        ...route,
      },
      (event) => secondEvents.push(event),
    );
    assert.equal(secondCode, 0);
    assert.equal(
      (secondEvents.find((e) => e.type === 'run_complete') as { result?: { session_id?: string } })
        ?.result?.session_id,
      threadId,
    );
  });

  it('rejects a genuinely different model on resume before host RPC', () => {
    assert.throws(
      () =>
        assertResumeRouteCompatible(
          { provider: 'openrouter', model: 'saved-model' },
          { provider: 'openrouter', model: 'other-model' },
        ),
      /model does not match/,
    );
  });
});
