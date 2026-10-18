import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { BridgeServer } from './sessionServer.js';

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
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
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
            else if (Array.isArray(value) && value.length > 0 && value[0]) {
              headers[key] = value[0];
            }
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

describe('Bridge pairing integration', () => {
  const PORT = 14655;
  const TOKEN = 'pairing-admin-token-test-value';
  let server: BridgeServer;
  let tmp: string;
  let prevHome: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-bridge-pair-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
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

  it('serves the pairing landing page', async () => {
    const res = await httpRequest(`http://127.0.0.1:${PORT}/pair`);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /DEVICE PAIRING/);
  });

  it('rejects paired-cookie clients from host admin pairing routes', async () => {
    const challengeRes = await httpRequest(`http://127.0.0.1:${PORT}/pair/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(challengeRes.statusCode, 201);
    const challenge = JSON.parse(challengeRes.body) as { challengeId: string };
    await httpRequest(`http://127.0.0.1:${PORT}/pair/request`, {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1' },
      body: JSON.stringify({ challenge_id: challenge.challengeId, device_label: 'Test phone' }),
    });
    await httpRequest(`http://127.0.0.1:${PORT}/pair/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ challenge_id: challenge.challengeId }),
    });
    const statusRes = await httpRequest(
      `http://127.0.0.1:${PORT}/pair/status?challenge_id=${encodeURIComponent(challenge.challengeId)}`,
      { headers: { Origin: 'http://127.0.0.1' } },
    );
    assert.equal(statusRes.statusCode, 200);
    const cookie = statusRes.headers['set-cookie'];
    assert.ok(cookie);

    const adminAttempt = await httpRequest(`http://127.0.0.1:${PORT}/pair/challenge`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(adminAttempt.statusCode, 401);
  });

  it('requires control.acquire for paired-device mutations', async () => {
    const challengeRes = await httpRequest(`http://127.0.0.1:${PORT}/pair/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const challenge = JSON.parse(challengeRes.body) as { challengeId: string };
    await httpRequest(`http://127.0.0.1:${PORT}/pair/request`, {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1' },
      body: JSON.stringify({ challenge_id: challenge.challengeId, device_label: 'Lease phone' }),
    });
    await httpRequest(`http://127.0.0.1:${PORT}/pair/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ challenge_id: challenge.challengeId }),
    });
    const statusRes = await httpRequest(
      `http://127.0.0.1:${PORT}/pair/status?challenge_id=${encodeURIComponent(challenge.challengeId)}`,
      { headers: { Origin: 'http://127.0.0.1' } },
    );
    const cookie = statusRes.headers['set-cookie'];
    assert.ok(cookie);

    const sessionRes = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    assert.equal(sessionRes.statusCode, 201);
    const session = JSON.parse(sessionRes.body) as { sessionId: string };

    const createRpc = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: tmp, session_id: session.sessionId },
      }),
    });
    const created = JSON.parse(createRpc.body) as { result?: { thread_id?: string } };
    const threadId = created.result?.thread_id;
    assert.ok(threadId);

    const denied = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'turn.submit',
        params: { thread_id: threadId, message: 'hello', command_id: 'pair-lease-1' },
      }),
    });
    const deniedBody = JSON.parse(denied.body) as { error?: { data?: { control_error?: string } } };
    assert.equal(deniedBody.error?.data?.control_error, 'lease_required');
  });
});
