import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../../agent/chatEngine.js';
import { BridgeServer } from '../sessionServer.js';

const PORT = 14650;
const TOKEN = 'browser-flow-token-not-secret';
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/remoteBrowserFlow.browser.js',
);

describe('Babel Remote browser gateway flow (e2e)', () => {
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
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*', `http://127.0.0.1:${PORT}`],
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
    const fixtureBody = readFileSync(FIXTURE_PATH, 'utf8');
    const scriptUrl = `http://127.0.0.1:${PORT}/ui/remoteBrowserFlow.browser.js`;
    try {
      await page.route(scriptUrl, (route) => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: fixtureBody });
      });
      await page.goto(`http://127.0.0.1:${PORT}/ui/`);
      await page.addScriptTag({ url: scriptUrl });
      const result = await page.evaluate(
        async ({ token, root }: { token: string; root: string }) => {
          const host = globalThis as typeof globalThis & {
            runRemoteBrowserFlow: (input: { token: string; root: string }) => Promise<{
              threadId: string;
              events: string[];
            }>;
          };
          return host.runRemoteBrowserFlow({ token, root });
        },
        { token: TOKEN, root: tmp },
      );
      assert.ok(result.threadId);
      assert.ok(result.events.some((line: string) => line.includes('turn.event')));
      assert.ok(
        result.events.some(
          (line: string) => line.includes('answer_chunk') || line.includes('browser integration'),
        ),
      );
    } finally {
      await browser.close();
    }
  });
});
