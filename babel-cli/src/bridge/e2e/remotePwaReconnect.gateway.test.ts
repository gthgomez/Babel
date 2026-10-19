import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { createDeterministicBridgeEngineFactory } from '../deterministicBridgeEngine.js';
import { BridgeServer } from '../sessionServer.js';

const PORT = 14651;
const TOKEN = 'pwa-reconnect-token-not-secret';
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/remotePwaReconnect.browser.js',
);

describe('Babel Remote production PWA reconnect (browser)', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevRuns: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-pwa-reconnect-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*', `http://127.0.0.1:${PORT}`],
      engineFactory: createDeterministicBridgeEngineFactory(),
    });
    await server.start(PORT);
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reconnects with history replay and catalog attachment without resubmitting the task', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const helperBody = readFileSync(FIXTURE_PATH, 'utf8');
    const helperUrl = `http://127.0.0.1:${PORT}/ui/remotePwaReconnect.browser.js`;
    try {
      await page.route(helperUrl, (route) => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: helperBody });
      });
      await page.goto(`http://127.0.0.1:${PORT}/ui/`, { waitUntil: 'networkidle' });
      await page.waitForFunction('globalThis.BabelRemoteApp');
      await page.addScriptTag({ url: helperUrl });
      const result = await page.evaluate(
        async ({ token, root }: { token: string; root: string }) => {
          const host = globalThis as typeof globalThis & {
            runRemotePwaReconnectFlow: (input: { token: string; root: string }) => Promise<{
              threadId: string;
              host: string;
              turn: string;
              historyCells: number;
              historyReplayed: boolean;
              catalogStatus: string;
              activeTurn: boolean;
            }>;
          };
          return host.runRemotePwaReconnectFlow({ token, root });
        },
        { token: TOKEN, root: tmp },
      );
      assert.ok(result.threadId);
      assert.ok(result.historyReplayed, 'history.lookup must replay committed cells after reconnect');
      assert.equal(result.host, 'ONLINE');
      assert.notEqual(result.turn, 'UNKNOWN');
      assert.ok(['idle', 'running', 'completed', 'waiting_approval'].includes(result.catalogStatus));
    } finally {
      await browser.close();
    }
  });
});
