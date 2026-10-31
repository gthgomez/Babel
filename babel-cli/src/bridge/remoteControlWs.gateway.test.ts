import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { connect } from 'node:net';

import { ChatEngine } from '../agent/chatEngine.js';
import { BridgeServer } from './sessionServer.js';
import { buildWsTextFrame, tryParseWsFrame } from './transport.js';

const PORT = 14680;
const TOKEN = 'ws-control-test-token-value-01';
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

async function pairCookie(label: string): Promise<string> {
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
  return cookie;
}

async function wsConnect(path: string): Promise<{
  send: (payload: string) => void;
  waitForMessage: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const client = connect(Number(PORT), '127.0.0.1', () => {
      const key = randomUUID().replace(/-/g, '') + '==';
      const upgradeReq = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: ${ORIGIN}`,
        '',
        '',
      ].join('\r\n');
      client.write(upgradeReq);
      let upgradeResponse = '';
      let upgraded = false;
      let buffer: Buffer = Buffer.alloc(0);
      client.on('data', (data: Buffer) => {
        if (!upgraded) {
          upgradeResponse += data.toString('utf8');
          if (!upgradeResponse.includes('\r\n\r\n')) return;
          upgraded = true;
          const headerEnd = upgradeResponse.indexOf('\r\n\r\n') + 4;
          buffer = Buffer.from(upgradeResponse.slice(headerEnd), 'utf8');
          resolve({
            send: (payload: string) => client.write(buildWsTextFrame(payload)),
            waitForMessage: () =>
              new Promise((res) => {
                const tryParse = () => {
                  const parsed = tryParseWsFrame(buffer);
                  if (parsed) {
                    buffer = parsed.remainder;
                    res(parsed.payload);
                    return;
                  }
                  const onChunk = (chunk: Buffer) => {
                    buffer = Buffer.concat([buffer, chunk]);
                    const p = tryParseWsFrame(buffer);
                    if (p) {
                      buffer = p.remainder;
                      client.off('data', onChunk);
                      res(p.payload);
                    }
                  };
                  client.on('data', onChunk);
                };
                tryParse();
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

describe('Remote control WebSocket gateway', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevHome: string | undefined;
  let prevRuns: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-ws-control-'));
    prevHome = process.env['HOME'];
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['HOME'] = tmp;
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({ inferenceOwner: 'external-harness',
          task: 'ws',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* (message: string) {
          yield { type: 'answer_chunk', text: message.slice(0, 4) };
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
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setupThread(cookie: string): Promise<{ sessionId: string; threadId: string }> {
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
    const threadId = (JSON.parse(created.body) as { result: { thread_id: string } }).result
      .thread_id;
    return { sessionId, threadId };
  }

  async function mintTicket(
    cookie: string,
    sessionId: string,
    threadId: string,
  ): Promise<string> {
    const res = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    return (JSON.parse(res.body) as { ticket: string }).ticket;
  }

  it('allows ticket-bound WS acquire, submit, and cancel with explicit epoch', async () => {
    const cookie = await pairCookie('ws-holder');
    const { sessionId, threadId } = await setupThread(cookie);
    const ticket = await mintTicket(cookie, sessionId, threadId);
    const ws = await wsConnect(
      `/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'control.acquire',
        params: { thread_id: threadId, force: false },
      }),
    );
    const acquireMsg = JSON.parse(await ws.waitForMessage()) as {
      result?: { epoch: number };
    };
    const epoch = acquireMsg.result?.epoch;
    assert.equal(typeof epoch, 'number');
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'turn.submit',
        params: {
          thread_id: threadId,
          message: 'via ws',
          command_id: 'ws-cmd-1',
          control_epoch: epoch,
        },
      }),
    );
    const submitMsg = JSON.parse(await ws.waitForMessage()) as { result?: unknown; error?: unknown };
    assert.ok(submitMsg.result);
    ws.close();
  });

  it('rejects WS mutation without control epoch for paired clients', async () => {
    const cookie = await pairCookie('ws-no-epoch');
    const { sessionId, threadId } = await setupThread(cookie);
    await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'control.acquire',
        params: { thread_id: threadId },
      }),
    });
    const ticket = await mintTicket(cookie, sessionId, threadId);
    const ws = await wsConnect(
      `/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
    );
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'turn.submit',
        params: { thread_id: threadId, message: 'nope', command_id: 'ws-cmd-2' },
      }),
    );
    const denied = JSON.parse(await ws.waitForMessage()) as { error?: { data?: { control_error?: string } } };
    assert.equal(denied.error?.data?.control_error, 'epoch_required');
    ws.close();
  });

  it('denies paired force-acquire while another device holds the lease', async () => {
    const cookieA = await pairCookie('ws-device-a');
    const cookieB = await pairCookie('ws-device-b');
    const { sessionId, threadId } = await setupThread(cookieA);
    await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookieA, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'control.acquire',
        params: { thread_id: threadId },
      }),
    });
    const forceB = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookieB, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'control.acquire',
        params: { thread_id: threadId, force: true },
      }),
    });
    const body = JSON.parse(forceB.body) as { error?: { data?: { control_error?: string } } };
    assert.equal(body.error?.data?.control_error, 'held_by_other');
  });

  it('rejects ticket consumption after device revocation', async () => {
    const cookie = await pairCookie('ws-revoke');
    const auth = JSON.parse(
      (
        await httpRequest(`http://127.0.0.1:${PORT}/auth/session`, {
          headers: { Cookie: cookie },
        })
      ).body,
    ) as { deviceId: string };
    const { sessionId, threadId } = await setupThread(cookie);
    const ticket = await mintTicket(cookie, sessionId, threadId);
    await httpRequest(`http://127.0.0.1:${PORT}/pair/devices/${auth.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const wsUpgrade = await httpRequest(
      `http://127.0.0.1:${PORT}/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
      {
        method: 'GET',
        headers: {
          Origin: ORIGIN,
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': Buffer.from('babel-remote-ws-upgrade-test-nonce').toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      },
    );
    assert.notEqual(wsUpgrade.statusCode, 101);
    const rpcAfter = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 30,
        method: 'remote.capabilities',
        params: {},
      }),
    });
    assert.equal(rpcAfter.statusCode, 401);
  });

  it('unregisters paired device socket closers after each transport closes', async () => {
    const cookie = await pairCookie('ws-churn');
    const auth = JSON.parse(
      (
        await httpRequest(`http://127.0.0.1:${PORT}/auth/session`, {
          headers: { Cookie: cookie },
        })
      ).body,
    ) as { deviceId: string };
    const { sessionId, threadId } = await setupThread(cookie);
    let peak = 0;
    for (let i = 0; i < 5; i++) {
      const ticket = await mintTicket(cookie, sessionId, threadId);
      const ws = await wsConnect(
        `/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
      );
      peak = Math.max(peak, server.testDeviceSocketCloserCount(auth.deviceId));
      ws.close();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    assert.ok(peak <= 1, `socket closer registry grew to ${peak}`);
    const ticket = await mintTicket(cookie, sessionId, threadId);
    await wsConnect(
      `/ws?sessionId=${encodeURIComponent(sessionId)}&ticket=${encodeURIComponent(ticket)}`,
    );
    assert.equal(server.testDeviceSocketCloserCount(auth.deviceId), 1);
    await httpRequest(`http://127.0.0.1:${PORT}/pair/devices/${auth.deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(server.testDeviceSocketCloserCount(auth.deviceId), 0);
  });
});
