import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import { BridgeServer } from './sessionServer.js';

const PORT = 14650;
const TOKEN = 'browser-flow-token-not-secret';

describe('Babel Remote browser gateway flow', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevRuns: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-browser-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: descriptor.task ?? 'browser',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* (message: string) {
          yield { type: 'thinking' };
          yield { type: 'answer_chunk', text: message.slice(0, 16) };
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
    await server.start(PORT);
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('mirrors the PWA session bind path and receives turn.event over WebSocket', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${PORT}/ui/`);
      await page.addScriptTag({ url: `http://127.0.0.1:${PORT}/ui/remoteBrowserFlow.browser.js` });
      const result = await page.evaluate(async ({ token, root }) => {
        return window.runRemoteBrowserFlow({ token, root });
      }, { token: TOKEN, root: tmp });
      assert.ok(result.threadId);
      assert.ok(result.events.some((line) => line.includes('turn.event')));
      assert.ok(result.events.some((line) => line.includes('answer_chunk') || line.includes('browser integration')));
    } finally {
      await browser.close();
    }
  });

  it('rejects ticket mint for threads created without session_id (PWA defect regression)', async () => {
    const session = await fetch(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (await session.json() as { sessionId: string }).sessionId;
    const created = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: tmp },
      }),
    });
    const threadId = ((await created.json()) as { result: { thread_id: string } }).result.thread_id;
    const minted = await fetch(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    assert.equal(minted.status, 403);
  });
});
