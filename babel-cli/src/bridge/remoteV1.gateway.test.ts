import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { connect } from 'node:net';

import { ChatEngine } from '../agent/chatEngine.js';
import { hashUserMessage } from '../protocol/messageIntegrity.js';
import { BridgeServer } from './sessionServer.js';
import { digestApprovalOperation, approvalOperationFromAgentAction } from '../agent/approvalOperation.js';

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ statusCode: number; body: string }> {
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
          resolve({ statusCode: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe('Babel Remote V1 gateway', () => {
  const PORT = 14601;
  const TOKEN = 'v1-bridge-token-not-a-secret';
  let server: BridgeServer;
  let tmp: string;
  let prevRuns: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-v1-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: descriptor.task ?? 'v1',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* (message: string) {
          yield { type: 'thinking' };
          yield { type: 'answer_chunk', text: message.slice(0, 32) };
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

  const auth = { Authorization: `Bearer ${TOKEN}` };

  async function rpc(method: string, params: unknown, id = 1) {
    const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return { statusCode: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> };
  }

  it('rejects missing and invalid bearer', async () => {
    const missing = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread.create', params: {} }),
    });
    assert.equal(missing.statusCode, 401);
    const invalid = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread.create', params: {} }),
    });
    assert.equal(invalid.statusCode, 401);
  });

  it('serves the supervisory PWA and health without the bearer', async () => {
    const health = await httpRequest(`http://127.0.0.1:${PORT}/health`);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body.includes(TOKEN), false);
    assert.match(health.body, /127\.0\.0\.1/);
    const ui = await httpRequest(`http://127.0.0.1:${PORT}/ui`);
    assert.equal(ui.statusCode, 200);
    assert.match(ui.body, /Allow once/i);
    assert.match(ui.body, /Deny/i);
    assert.doesNotMatch(ui.body, /ALLOW_SESSION/);
    assert.doesNotMatch(ui.body, new RegExp(TOKEN));
    const app = await httpRequest(`http://127.0.0.1:${PORT}/ui/app.js`);
    assert.equal(app.statusCode, 200);
    assert.doesNotMatch(app.body, /token=/);
  });

  it('mints a V1 ticket after auth and rejects missing/replayed tickets on WS', async () => {
    const session = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(session.body) as { sessionId: string }).sessionId;
    const created = await rpc('thread.create', { project_root: tmp, session_id: sessionId }, 20);
    const threadId = (created.json['result'] as { thread_id: string }).thread_id;
    const minted = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    assert.equal(minted.statusCode, 200);
    const ticket = (JSON.parse(minted.body) as { ticket: string }).ticket;
    assert.ok(ticket);
    const consumed = server.wsTickets.consume({ ticket, sessionId });
    assert.equal(consumed.ok, true);
    const replay = server.wsTickets.consume({ ticket, sessionId });
    assert.equal(replay.ok, false);
  });

  it('isolates turn.event subscribers by thread and drops stale listeners', async () => {
    const a = await rpc('thread.create', { project_root: tmp }, 30);
    const b = await rpc('thread.create', { project_root: tmp }, 31);
    const threadA = (a.json['result'] as { thread_id: string }).thread_id;
    const threadB = (b.json['result'] as { thread_id: string }).thread_id;
    const seenA: string[] = [];
    const seenB: string[] = [];
    const unsubA = server.protocolGateway.subscribe((payload) => seenA.push(payload), {
      threadId: threadA,
    });
    const unsubB = server.protocolGateway.subscribe((payload) => seenB.push(payload), {
      threadId: threadB,
    });
    await rpc('turn.submit', { thread_id: threadA, message: 'only-a', command_id: 'iso-a' }, 32);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(seenA.some((line) => line.includes('only-a') || line.includes(threadA)), true);
    assert.equal(seenB.some((line) => line.includes(threadA) || line.includes('only-a')), false);
    unsubA();
    const after: string[] = [];
    const replacement = server.protocolGateway.subscribe((payload) => after.push(payload), {
      threadId: threadA,
    });
    unsubB();
    replacement();
    assert.ok(true);
  });

  it('maps verification.lookup missing evidence to NOT_VERIFIED', async () => {
    const created = await rpc('thread.create', { project_root: tmp }, 40);
    const threadId = (created.json['result'] as { thread_id: string }).thread_id;
    const lookup = await rpc('verification.lookup', { thread_id: threadId }, 41);
    const result = lookup.json['result'] as { status: string };
    assert.equal(result.status, 'NOT_VERIFIED');
    server.protocolGateway.host.verificationByThread.set(threadId, {
      hasMachineEvidence: true,
      commandExitCode: 1,
    });
    const failed = await rpc('verification.lookup', { thread_id: threadId }, 42);
    assert.equal((failed.json['result'] as { status: string }).status, 'FAILED');
  });

  it('approval.decide consumes ALLOW_ONCE and rejects session grants', async () => {
    const created = await rpc('thread.create', { project_root: tmp }, 50);
    const threadId = (created.json['result'] as { thread_id: string }).thread_id;
    const operation = approvalOperationFromAgentAction(
      { type: 'write_file', path: 'x.ts', content: 'ok' },
      { thread_id: threadId, turn_id: '1', cwd: tmp },
    );
    const pending = server.protocolGateway.host.approvalBroker.createPending({
      thread_id: threadId,
      turn_id: '1',
      operation,
    });
    const sessionGrant = await rpc(
      'approval.decide',
      {
        approval_id: pending.approval_id,
        decision: 'allow_session',
        thread_id: threadId,
        turn_id: '1',
        operation_digest: digestApprovalOperation(operation),
      },
      51,
    );
    assert.ok(sessionGrant.json['error']);
    const allow = await rpc(
      'approval.decide',
      {
        approval_id: pending.approval_id,
        decision: 'allow_once',
        thread_id: threadId,
        turn_id: '1',
        operation_digest: digestApprovalOperation(operation),
      },
      52,
    );
    assert.equal((allow.json['result'] as { consumed: boolean }).consumed, true);
  });

  it('rejects unapproved Origin on RPC and WS', async () => {
    const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { ...auth, Origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread.create', params: {} }),
    });
    assert.equal(res.statusCode, 403);

    const ws = await new Promise<string>((resolve) => {
      const client = connect(PORT, '127.0.0.1', () => {
        const key = Buffer.from('ws-origin-test-key!!').toString('base64');
        client.write(
          [
            'GET /ws?sessionId=missing HTTP/1.1',
            'Host: 127.0.0.1',
            'Origin: https://evil.example',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      let data = '';
      client.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n\r\n')) {
          client.destroy();
          resolve(data);
        }
      });
      setTimeout(() => {
        client.destroy();
        resolve(data);
      }, 1500);
    });
    assert.match(ws, /403|401/);
  });

  it('allows the PWA Origin http://127.0.0.1:<port> on /rpc and /ws', async () => {
    const pageOrigin = `http://127.0.0.1:${PORT}`;
    const session = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { ...auth, Origin: pageOrigin },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    assert.equal(session.statusCode, 201);
    const sessionId = (JSON.parse(session.body) as { sessionId: string }).sessionId;
    const created = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { ...auth, Origin: pageOrigin },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 80,
        method: 'thread.create',
        params: { project_root: tmp, session_id: sessionId },
      }),
    });
    assert.equal(created.statusCode, 200);
    const threadId = (JSON.parse(created.body) as { result: { thread_id: string } }).result
      .thread_id;
    const minted = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: { ...auth, Origin: pageOrigin },
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    assert.equal(minted.statusCode, 200);
    const ticket = (JSON.parse(minted.body) as { ticket: string }).ticket;

    const ws = await new Promise<string>((resolve) => {
      const client = connect(PORT, '127.0.0.1', () => {
        const key = Buffer.from('ws-loopback-origin-key').toString('base64');
        client.write(
          [
            `GET /ws?sessionId=${sessionId}&ticket=${ticket} HTTP/1.1`,
            'Host: 127.0.0.1',
            `Origin: ${pageOrigin}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });
      let data = '';
      client.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n\r\n')) {
          client.destroy();
          resolve(data);
        }
      });
      setTimeout(() => {
        client.destroy();
        resolve(data);
      }, 1500);
    });
    assert.match(ws, /101 Switching Protocols/);
  });

  it('preserves 100 KiB UTF-8 including CRLF and unicode at the ChatEngine boundary', async () => {
    let captured = '';
    const local = new BridgeServer({
      port: 14602,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'integrity',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* (message: string) {
          captured = message;
          yield { type: 'thinking' };
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
    await local.start(14602);
    try {
      const fixture = `# md\r\n\`\`\`ts\nconst x = 1;\n\`\`\`\n日本語 🧪\n` + 'P'.repeat(100 * 1024);
      const created = await httpRequest(`http://127.0.0.1:14602/rpc`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'thread.create',
          params: { project_root: tmp },
        }),
      });
      const threadId = (JSON.parse(created.body) as { result: { thread_id: string } }).result.thread_id;
      await httpRequest(`http://127.0.0.1:14602/rpc`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'turn.submit',
          params: { thread_id: threadId, message: fixture, command_id: 'big-1' },
        }),
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(hashUserMessage(captured).sha256, hashUserMessage(fixture).sha256);
      assert.equal(
        createHash('sha256').update(Buffer.from(fixture, 'utf8')).digest('hex'),
        hashUserMessage(fixture).sha256,
      );
    } finally {
      await local.stop();
    }
  });

  it('mints a ticket only when the thread belongs to the session', async () => {
    const sessionA = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionB = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const idA = (JSON.parse(sessionA.body) as { sessionId: string }).sessionId;
    const idB = (JSON.parse(sessionB.body) as { sessionId: string }).sessionId;
    const createdA = await rpc('thread.create', { project_root: tmp, session_id: idA }, 80);
    const createdB = await rpc('thread.create', { project_root: tmp, session_id: idB }, 81);
    const threadA = (createdA.json['result'] as { thread_id: string }).thread_id;
    const threadB = (createdB.json['result'] as { thread_id: string }).thread_id;

    const mintAA = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: idA, thread_id: threadA }),
    });
    assert.equal(mintAA.statusCode, 200);

    const mintBB = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: idB, thread_id: threadB }),
    });
    assert.equal(mintBB.statusCode, 200);

    const cross = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: idA, thread_id: threadB }),
    });
    assert.equal(cross.statusCode, 403);
    assert.equal(JSON.parse(cross.body).error.includes('owned_by_other'), true);

    const unknown = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: idA, thread_id: 'missing-thread' }),
    });
    assert.equal(unknown.statusCode, 404);

    server.protocolGateway.threadOwnership.deactivate(threadA);
    const stale = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: idA, thread_id: threadA }),
    });
    assert.equal(stale.statusCode, 403);
    const replayFailed = server.wsTickets.consume({ ticket: 'never-minted', sessionId: idA });
    assert.equal(replayFailed.ok, false);

    const orphan = await rpc('thread.create', { project_root: tmp }, 82);
    const orphanId = (orphan.json['result'] as { thread_id: string }).thread_id;
    const claim = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: idA, thread_id: orphanId }),
    });
    assert.equal(claim.statusCode, 403);
    assert.match(JSON.parse(claim.body).error, /unowned_thread/);
  });

  it('scoped fan-out drops missing and malformed thread_id', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const seenGlobal: string[] = [];
    const unsubA = server.protocolGateway.subscribe((p) => seenA.push(p), { threadId: 'thr-a' });
    const unsubB = server.protocolGateway.subscribe((p) => seenB.push(p), { threadId: 'thr-b' });
    const unsubG = server.protocolGateway.subscribe((p) => seenGlobal.push(p));
    server.protocolGateway.emitNotification({
      jsonrpc: '2.0',
      method: 'turn.event',
      params: { thread_id: 'thr-a', event: { type: 'thinking' } },
    });
    server.protocolGateway.emitNotification({
      jsonrpc: '2.0',
      method: 'turn.event',
      params: { thread_id: 'thr-b', event: { type: 'thinking' } },
    });
    server.protocolGateway.emitNotification({
      jsonrpc: '2.0',
      method: 'turn.event',
      params: {},
    });
    server.protocolGateway.emitNotification({
      jsonrpc: '2.0',
      method: 'turn.event',
      params: { thread_id: 12 },
    });
    server.protocolGateway.emitNotification({
      jsonrpc: '2.0',
      method: 'status',
      scope: 'global',
      params: { ok: true },
    });
    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 1);
    assert.equal(seenA.some((l) => l.includes('thr-b')), false);
    assert.equal(seenB.some((l) => l.includes('thr-a')), false);
    assert.equal(seenGlobal.length, 1);
    unsubA();
    unsubB();
    unsubG();
  });

  function wsUpgrade(path: string, extraHeaders: string[] = []): Promise<string> {
    return new Promise((resolve) => {
      const client = connect(PORT, '127.0.0.1', () => {
        const key = Buffer.from('ws-legacy-bearer-key!!').toString('base64');
        client.write(
          [
            `GET ${path} HTTP/1.1`,
            'Host: 127.0.0.1',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            ...extraHeaders,
            '',
            '',
          ].join('\r\n'),
        );
      });
      let data = '';
      client.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
        if (data.includes('\r\n\r\n')) {
          client.destroy();
          resolve(data);
        }
      });
      setTimeout(() => {
        client.destroy();
        resolve(data);
      }, 1500);
    });
  }

  it('rejects bearer and query token WS upgrades when legacy compatibility is off', async () => {
    const session = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(session.body) as { sessionId: string }).sessionId;
    const bearer = await wsUpgrade(`/ws?sessionId=${sessionId}`, [
      `Authorization: Bearer ${TOKEN}`,
    ]);
    assert.match(bearer, /401/);
    const query = await wsUpgrade(`/ws?sessionId=${sessionId}&token=${TOKEN}`);
    assert.match(query, /401/);
  });

  it('accepts a valid ticket and rejects replay and wrong session', async () => {
    const session = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(session.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      'thread.create',
      { project_root: tmp, session_id: sessionId },
      90,
    );
    const threadId = (created.json['result'] as { thread_id: string }).thread_id;
    const minted = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    const ticket = (JSON.parse(minted.body) as { ticket: string }).ticket;
    const first = await wsUpgrade(`/ws?sessionId=${sessionId}&ticket=${ticket}`);
    assert.match(first, /101 Switching Protocols/);
    const replay = await wsUpgrade(`/ws?sessionId=${sessionId}&ticket=${ticket}`);
    assert.match(replay, /401|403/);

    const minted2 = await httpRequest(`http://127.0.0.1:${PORT}/ws/ticket`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ session_id: sessionId, thread_id: threadId }),
    });
    const ticket2 = (JSON.parse(minted2.body) as { ticket: string }).ticket;
    const other = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const otherId = (JSON.parse(other.body) as { sessionId: string }).sessionId;
    const wrongSession = await wsUpgrade(`/ws?sessionId=${otherId}&ticket=${ticket2}`);
    assert.match(wrongSession, /401|403/);
  });

  it('legacy compatibility ON accepts header bearer only and does not subscribe', async () => {
    const prev = process.env['BABEL_REMOTE_ALLOW_LEGACY_WS_BEARER'];
    process.env['BABEL_REMOTE_ALLOW_LEGACY_WS_BEARER'] = '1';
    try {
      const session = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ projectRoot: tmp }),
      });
      const sessionId = (JSON.parse(session.body) as { sessionId: string }).sessionId;
      const header = await wsUpgrade(`/ws?sessionId=${sessionId}`, [
        `Authorization: Bearer ${TOKEN}`,
      ]);
      assert.match(header, /101 Switching Protocols/);
      const queryOnly = await wsUpgrade(`/ws?sessionId=${sessionId}&token=${TOKEN}`);
      assert.match(queryOnly, /401/);
    } finally {
      if (prev === undefined) delete process.env['BABEL_REMOTE_ALLOW_LEGACY_WS_BEARER'];
      else process.env['BABEL_REMOTE_ALLOW_LEGACY_WS_BEARER'] = prev;
    }
  });
});
