import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { connect } from 'node:net';

import { BridgeServer } from './sessionServer.js';
import { buildWsTextFrame, tryParseWsFrame } from './transport.js';

const PORT = 14690;
const TOKEN = 'revoke-fanout-test-token-value';
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

async function wsConnect(path: string): Promise<{
  waitForMessage: (ms: number) => Promise<string | null>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const client = connect(Number(PORT), '127.0.0.1', () => {
      const key = randomUUID().replace(/-/g, '') + '==';
      client.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${PORT}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Origin: ${ORIGIN}`,
          '',
          '',
        ].join('\r\n'),
      );
      let buf = '';
      let buffer: Buffer = Buffer.alloc(0);
      client.on('data', (data: Buffer) => {
        if (!buf.includes('\r\n\r\n')) {
          buf += data.toString('utf8');
          if (!buf.includes('\r\n\r\n')) return;
          const headerEnd = buf.indexOf('\r\n\r\n') + 4;
          buffer = Buffer.from(buf.slice(headerEnd), 'utf8');
          resolve({
            waitForMessage: (ms: number) =>
              new Promise((res) => {
                const timer = setTimeout(() => res(null), ms);
                const tryRead = () => {
                  const parsed = tryParseWsFrame(buffer);
                  if (parsed) {
                    clearTimeout(timer);
                    buffer = parsed.remainder;
                    res(parsed.payload);
                    return;
                  }
                  const onChunk = (chunk: Buffer) => {
                    buffer = Buffer.concat([buffer, chunk]);
                    const p = tryParseWsFrame(buffer);
                    if (p) {
                      clearTimeout(timer);
                      client.off('data', onChunk);
                      buffer = p.remainder;
                      res(p.payload);
                    }
                  };
                  client.on('data', onChunk);
                };
                tryRead();
              }),
            close: () => {
              client.end();
              client.destroy();
            },
          });
        }
      });
      client.on('error', reject);
    });
  });
}

describe('Revoked device observation fan-out', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevHome: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-revoke-fanout-'));
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

  it('does not deliver thread events to a revoked device socket', async () => {
    const ch = await httpRequest(`http://127.0.0.1:${PORT}/pair/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const { challengeId } = JSON.parse(ch.body) as { challengeId: string };
    await httpRequest(`http://127.0.0.1:${PORT}/pair/request`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ challenge_id: challengeId, device_label: 'fanout-phone' }),
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
    const ticketRes = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    const ticket = (JSON.parse(ticketRes.body) as { ticket: string }).ticket;
    const ws = await wsConnect(
      `/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
    );

    await httpRequest(`http://127.0.0.1:${PORT}/pair/devices/${auth.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    const mintAfterRevoke = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    assert.equal(mintAfterRevoke.statusCode, 401);

    server.protocolGateway.emitNotification({
      jsonrpc: '2.0',
      method: 'turn.event',
      params: { thread_id: threadId, event: { type: 'thinking' } },
    });

    const leaked = await ws.waitForMessage(400);
    assert.equal(leaked, null);
    ws.close();
  });
});
