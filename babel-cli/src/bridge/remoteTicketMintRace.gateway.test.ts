import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BridgeServer } from './sessionServer.js';

const PORT = 14691;
const TOKEN = 'ticket-mint-race-token-value';
const ORIGIN = 'http://127.0.0.1';

function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
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
        res.on('data', (c: Buffer) => {
          body += c.toString('utf8');
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v) && v[0]) headers[k] = v[0];
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

function postTicketWithDelayedBody(input: {
  cookie: string;
  body: string;
  pauseAfterBytes: number;
  duringPause: () => Promise<void>;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const full = input.body;
    const first = full.slice(0, input.pauseAfterBytes);
    const rest = full.slice(input.pauseAfterBytes);
    const req = request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/ws/ticket',
        method: 'POST',
        headers: {
          Cookie: input.cookie,
          Origin: ORIGIN,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(full),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => {
          body += c.toString('utf8');
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.write(first);
    void input.duringPause().then(() => {
      req.write(rest);
      req.end();
    });
  });
}

describe('WS ticket mint principal binding', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevHome: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-ticket-race-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: true,
    });
    await server.start(PORT);
  });

  after(async () => {
    await server.stop();
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function pairCookie(label: string): Promise<{ cookie: string; deviceId: string }> {
    const ch = await httpRequest(`http://127.0.0.1:${PORT}/pair/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const { challengeId } = JSON.parse(ch.body) as { challengeId: string };
    await httpRequest(`http://127.0.0.1:${PORT}/pair/request`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ challenge_id: challengeId, device_label: label }),
    });
    await httpRequest(`http://127.0.0.1:${PORT}/pair/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ challenge_id: challengeId }),
    });
    const st = await httpRequest(
      `http://127.0.0.1:${PORT}/pair/status?challenge_id=${encodeURIComponent(challengeId)}`,
      { headers: { Origin: ORIGIN } },
    );
    const cookie = st.headers['set-cookie'];
    assert.ok(cookie);
    const auth = JSON.parse(
      (await httpRequest(`http://127.0.0.1:${PORT}/auth/session`, { headers: { Cookie: cookie } })).body,
    ) as { deviceId: string };
    return { cookie, deviceId: auth.deviceId };
  }

  it('rejects ticket mint when device is revoked while the body is still arriving', async () => {
    const { cookie, deviceId } = await pairCookie('mint-race');
    const sess = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: tmp, session_id: sessionId },
      }),
    });
    const threadId = (JSON.parse(created.body) as { result: { thread_id: string } }).result.thread_id;
    const body = JSON.stringify({ session_id: sessionId, thread_id: threadId });
    const mintRes = await postTicketWithDelayedBody({
      cookie,
      body,
      pauseAfterBytes: Math.max(1, Math.floor(body.length / 2)),
      duringPause: async () => {
        await httpRequest(`http://127.0.0.1:${PORT}/pair/devices/${deviceId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
      },
    });
    assert.ok(mintRes.statusCode === 401 || mintRes.statusCode === 403);
    assert.doesNotMatch(mintRes.body, /"ticket":/);
  });

  it('rejects ticket mint when the paired session expires during body read', async () => {
    const { cookie, deviceId } = await pairCookie('mint-expire');
    const sess = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'thread.create',
        params: { project_root: tmp, session_id: sessionId },
      }),
    });
    const threadId = (JSON.parse(created.body) as { result: { thread_id: string } }).result.thread_id;
    const body = JSON.stringify({ session_id: sessionId, thread_id: threadId });
    const mintRes = await postTicketWithDelayedBody({
      cookie,
      body,
      pauseAfterBytes: Math.max(1, Math.floor(body.length / 2)),
      duringPause: async () => {
        await httpRequest(`http://127.0.0.1:${PORT}/pair/devices/${deviceId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
      },
    });
    assert.ok(mintRes.statusCode === 401 || mintRes.statusCode === 403);
  });
});
