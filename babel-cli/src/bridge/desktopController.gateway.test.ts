import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import {
  computeDesktopControllerProof,
  DESKTOP_CLIENT_ID_HEADER,
  DESKTOP_PROOF_HEADER,
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { BridgeServer } from './sessionServer.js';

const TOKEN = 'desktop-controller-gateway-token';
const ORIGIN = 'http://127.0.0.1';

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

describe('Desktop controller shared-session gateway', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevRuns: string | undefined;
  let port = 0;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-desktop-controller-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) =>
        new ChatEngine({
          task: descriptor.task ?? 'desktop',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        }),
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

  const desktopHeaders = {
    [DESKTOP_CLIENT_ID_HEADER]: desktopId,
    [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
    Origin: ORIGIN,
  };

  async function desktopRpc(method: string, params: Record<string, unknown>, id = 1) {
    const res = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const body = JSON.parse(res.body) as {
      result?: Record<string, unknown>;
      error?: { code: string | number; message: string };
    };
    if (res.statusCode !== 200 || body.error) {
      throw new Error(
        `RPC ${method} failed (${res.statusCode}): ${JSON.stringify(body.error ?? body)}`,
      );
    }
    return body.result ?? {};
  }

  async function pairCookie(label: string): Promise<string> {
    const ch = await httpRequest(`http://127.0.0.1:${port}/pair/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const { challengeId } = JSON.parse(ch.body) as { challengeId: string };
    await httpRequest(`http://127.0.0.1:${port}/pair/request`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ challenge_id: challengeId, device_label: label }),
    });
    await httpRequest(`http://127.0.0.1:${port}/pair/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ challenge_id: challengeId }),
    });
    const st = await httpRequest(
      `http://127.0.0.1:${port}/pair/status?challenge_id=${encodeURIComponent(challengeId)}`,
      { headers: { Origin: ORIGIN } },
    );
    const cookie = st.headers['set-cookie'];
    assert.ok(cookie);
    return cookie;
  }

  it('rejects desktop id header without proof on loopback', async () => {
    const forged = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        [DESKTOP_CLIENT_ID_HEADER]: desktopId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'remote.catalog',
        params: {},
      }),
    });
    assert.equal(forged.statusCode, 401);
  });

  it('authenticates loopback desktop controller without host bearer', async () => {
    const denied = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'remote.catalog',
        params: {},
      }),
    });
    assert.equal(denied.statusCode, 401);
    const sessionRes = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    assert.equal(sessionRes.statusCode, 201);
  });

  it('remote-priority lease: paired device can take desktop-held lease', async () => {
    const sessionRes = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const { sessionId } = JSON.parse(sessionRes.body) as { sessionId: string };
    const created = await desktopRpc('thread.create', {
      project_root: tmp,
      session_id: sessionId,
    });
    const threadId = created.thread_id as string;
    assert.ok(threadId);
    const desktopLease = await desktopRpc('control.acquire', { thread_id: threadId, force: false });
    assert.equal(desktopLease.holder_client_id, desktopId);

    const cookie = await pairCookie('remote priority phone');
    const takeover = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'control.acquire',
        params: { thread_id: threadId, force: false },
      }),
    });
    const takeoverBody = JSON.parse(takeover.body) as {
      result?: { holder_client_id: string };
      error?: { code: string; message: string };
    };
    assert.equal(
      takeoverBody.error?.code,
      undefined,
      `expected remote takeover, got ${JSON.stringify(takeoverBody)}`,
    );
    assert.match(takeoverBody.result?.holder_client_id ?? '', /^device:/);

    const cookieB = await pairCookie('second phone');
    const blocked = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookieB, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'control.acquire',
        params: { thread_id: threadId, force: false },
      }),
    });
    const blockedBody = JSON.parse(blocked.body) as {
      error?: { code: string | number; data?: { control_error?: string } };
    };
    assert.equal(blockedBody.error?.data?.control_error, 'held_by_other');
  });

  it('host bearer force remains emergency takeover only', async () => {
    const sessionRes = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const { sessionId } = JSON.parse(sessionRes.body) as { sessionId: string };
    const created = await desktopRpc('thread.create', {
      project_root: tmp,
      session_id: sessionId,
    });
    const threadId = created.thread_id as string;
    assert.ok(threadId);
    const cookie = await pairCookie('force target');
    await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'control.acquire',
        params: { thread_id: threadId, force: false },
      }),
    });
    const forced = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'control.acquire',
        params: { thread_id: threadId, force: true },
      }),
    });
    const forcedBody = JSON.parse(forced.body) as { result?: { holder_client_id: string } };
    assert.ok(forcedBody.result?.holder_client_id?.startsWith('host:'));
  });
});
