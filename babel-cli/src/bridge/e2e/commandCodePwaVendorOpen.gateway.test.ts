import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  computeDesktopControllerProof,
  DESKTOP_CLIENT_ID_HEADER,
  DESKTOP_PROOF_HEADER,
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from '../desktopControllerAuth.js';
import { BridgeServer } from '../sessionServer.js';

const PORT = 14655;
const TOKEN = 'cc-pwa-open-token-not-secret';
const ORIGIN = 'http://127.0.0.1';
const PEER = fileURLToPath(new URL('../../../test/fixtures/command-code-acp-peer.mjs', import.meta.url));
const VERSION_FIXTURE = fileURLToPath(
  new URL('../../../test/fixtures/command-code-version.mjs', import.meta.url),
);
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test/fixtures/commandCodePwaVendorOpen.browser.js',
);

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', ...options.headers },
      },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[key] = value;
            else if (Array.isArray(value) && value[0]) headers[key] = value[0];
          }
          resolve({ statusCode: res.statusCode ?? 0, body, headers });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function pairedHeaders(cookie: string): Record<string, string> {
  return { Cookie: cookie, Origin: ORIGIN };
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  id: number,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function pairPhone(label: string): Promise<string> {
  const challengeRes = await httpRequest(`http://127.0.0.1:${PORT}/pair/challenge`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const challenge = JSON.parse(challengeRes.body) as { challengeId: string };
  await httpRequest(`http://127.0.0.1:${PORT}/pair/request`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
    body: JSON.stringify({ challenge_id: challenge.challengeId, device_label: label }),
  });
  await httpRequest(`http://127.0.0.1:${PORT}/pair/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ challenge_id: challenge.challengeId }),
  });
  const statusRes = await httpRequest(
    `http://127.0.0.1:${PORT}/pair/status?challenge_id=${encodeURIComponent(challenge.challengeId)}`,
    { headers: { Origin: ORIGIN } },
  );
  const cookie = statusRes.headers['set-cookie'];
  assert.ok(cookie);
  return cookie;
}

describe('Command Code PWA cold restart journey (browser e2e)', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevHome: string | undefined;
  let prevPlaywrightBrowsers: string | undefined;
  let prevRuns: string | undefined;
  let prevCliExecutable: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  function headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${TOKEN}`,
      [DESKTOP_CLIENT_ID_HEADER]: desktopId,
      [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
      Origin: ORIGIN,
    };
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-cc-pwa-open-'));
    const agentHome = homedir();
    prevHome = process.env['HOME'];
    prevRuns = process.env['BABEL_RUNS_DIR'];
    prevCliExecutable = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    prevPlaywrightBrowsers = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = join(agentHome, '.cache', 'ms-playwright');
    process.env['HOME'] = join(tmp, 'pair-home');
    process.env['BABEL_RUNS_DIR'] = tmp;
    process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = VERSION_FIXTURE;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*', `http://127.0.0.1:${PORT}`],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      commandCodeTestLaunch: { command: process.execPath, args: [PEER] },
      commandCodeInstallProbe: async () => ({
        state: 'verified' as const,
        executable: VERSION_FIXTURE,
        version: '1.0.0',
      }),
    });
    await server.start(PORT);
  });

  after(async () => {
    await server.stop();
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevPlaywrightBrowsers === undefined) delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
    else process.env['PLAYWRIGHT_BROWSERS_PATH'] = prevPlaywrightBrowsers;
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    if (prevCliExecutable === undefined) delete process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    else process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = prevCliExecutable;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('catalog picker → open/history → reconnect → immediate continue on same native session', async () => {
    const nativeId = 'sess_fixture_preload';
    const sess = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: nativeId,
      },
      1,
      headers(),
    );
    const seedThread = (created.result as { thread_id: string }).thread_id;
    await rpc('control.acquire', { thread_id: seedThread, force: false }, 2, headers());
    await rpc(
      'harness.command_code.open',
      { thread_id: seedThread, project_root: tmp, harness_native_session_id: nativeId },
      3,
      headers(),
    );
    await server.commandCodeRegistry.evictProject(tmp);

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const fixtureBody = readFileSync(FIXTURE_PATH, 'utf8');
    const scriptUrl = `http://127.0.0.1:${PORT}/ui/commandCodePwaVendorOpen.browser.js`;
    try {
      await page.route(scriptUrl, (route) => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: fixtureBody });
      });
      await page.goto(`http://127.0.0.1:${PORT}/ui/`, { waitUntil: 'networkidle' });
      await page.waitForFunction('globalThis.BabelRemoteApp');
      await page.addScriptTag({ url: scriptUrl });
      const result = await page.evaluate(
        async (input: {
          token: string;
          root: string;
          nativeId: string;
          seedThread: string;
          transportSessionId: string;
        }) => {
          const host = globalThis as typeof globalThis & {
            runCommandCodePwaColdRestartJourney: (input: {
              token: string;
              root: string;
              nativeId: string;
              seedThread: string;
              transportSessionId: string;
            }) => Promise<{
              pickerFromCatalog: boolean;
              resumedSameThread: boolean;
              continuationSeen: boolean;
              staleLeak: boolean;
              historyBeforePrompt: string;
            }>;
          };
          return host.runCommandCodePwaColdRestartJourney(input);
        },
        {
          token: TOKEN,
          root: tmp,
          nativeId,
          seedThread,
          transportSessionId,
        },
      );
      assert.equal(result.pickerFromCatalog, true);
      assert.ok(result.historyBeforePrompt.includes('fixture:history-replay'));
      assert.equal(result.resumedSameThread, true);
      assert.equal(result.continuationSeen, true);
      assert.equal(result.staleLeak, false);
    } finally {
      await browser.close();
    }
  });

  it('paired controller acquires lease and opens saved Command Code history from catalog', async () => {
    const nativeId = 'sess_fixture_paired_open';
    const sess = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: nativeId,
      },
      10,
      headers(),
    );
    const seedThread = (created.result as { thread_id: string }).thread_id;
    await rpc(
      'harness.command_code.open',
      { thread_id: seedThread, project_root: tmp, harness_native_session_id: nativeId },
      12,
      headers(),
    );
    const hostLease = await rpc('control.status', { thread_id: seedThread }, 13, headers());
    const hostLeaseResult = hostLease.result as { held?: boolean; epoch?: number };
    if (hostLeaseResult?.held && typeof hostLeaseResult.epoch === 'number') {
      await rpc(
        'control.release',
        { thread_id: seedThread, control_epoch: hostLeaseResult.epoch },
        14,
        headers(),
      );
    }
    await server.commandCodeRegistry.evictProject(tmp);

    const pairCookie = await pairPhone('pwa-cc-open');
    const acquired = await rpc(
      'control.acquire',
      { thread_id: seedThread, force: false },
      20,
      pairedHeaders(pairCookie),
    );
    assert.ok(
      acquired.result,
      `paired control.acquire must succeed before open: ${JSON.stringify(acquired.error ?? acquired)}`,
    );
    const epoch = (acquired.result as { epoch?: number }).epoch;
    assert.ok(typeof epoch === 'number');
    const pairedOpen = await rpc(
      'harness.command_code.open',
      {
        thread_id: seedThread,
        project_root: tmp,
        harness_native_session_id: nativeId,
        control_epoch: epoch,
      },
      21,
      pairedHeaders(pairCookie),
    );
    assert.ok(pairedOpen.result, 'paired harness.command_code.open must succeed');
    const history = await rpc('history.lookup', { thread_id: seedThread }, 22, pairedHeaders(pairCookie));
    const cells = (history.result as { cells?: unknown[] })?.cells ?? [];
    assert.ok(cells.length >= 2, 'paired history.lookup must return replay cells');
    const released = await rpc(
      'control.release',
      { thread_id: seedThread, control_epoch: epoch },
      23,
      pairedHeaders(pairCookie),
    );
    assert.ok(released.result, 'paired control.release must succeed before browser leg');

    const cookiePair = pairCookie.split(';')[0] ?? '';
    const eq = cookiePair.indexOf('=');
    assert.ok(eq > 0);
    const cookieName = cookiePair.slice(0, eq);
    const cookieValue = cookiePair.slice(eq + 1);

    const pairedSession = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Cookie: pairCookie, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const pairedTransportSessionId = (JSON.parse(pairedSession.body) as { sessionId: string }).sessionId;

    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    const page = await context.newPage();
    const fixtureBody = readFileSync(FIXTURE_PATH, 'utf8');
    const scriptUrl = `http://127.0.0.1:${PORT}/ui/commandCodePwaVendorOpen.browser.js`;
    try {
      await page.route(scriptUrl, (route) => {
        route.fulfill({ status: 200, contentType: 'text/javascript', body: fixtureBody });
      });
      await page.goto(`http://127.0.0.1:${PORT}/ui/`, { waitUntil: 'networkidle' });
      await page.waitForFunction('globalThis.BabelRemoteApp');
      await page.addScriptTag({ url: scriptUrl });
      const result = await page.evaluate(
        async (input: {
          root: string;
          nativeId: string;
          seedThread: string;
          transportSessionId: string;
        }) => {
          const host = globalThis as typeof globalThis & {
            runCommandCodePwaPairedVendorOpenJourney: (input: {
              root: string;
              nativeId: string;
              seedThread: string;
              transportSessionId: string;
            }) => Promise<{
              authKind: string;
              controlEpoch: number | null;
              resumedSameThread: boolean;
            }>;
          };
          return host.runCommandCodePwaPairedVendorOpenJourney(input);
        },
        {
          root: tmp,
          nativeId,
          seedThread,
          transportSessionId: pairedTransportSessionId,
        },
      );
      assert.equal(result.authKind, 'paired');
      assert.ok(typeof result.controlEpoch === 'number', 'paired create/open must acquire control lease');
      assert.equal(result.resumedSameThread, true);
    } finally {
      await browser.close();
    }
  });
});
