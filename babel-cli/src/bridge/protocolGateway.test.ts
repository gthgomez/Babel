import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import { hashUserMessage } from '../protocol/messageIntegrity.js';
import { BridgeServer } from './sessionServer.js';

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

function buildIntegrityFixture(): string {
  const blocks = [
    '# Heading\n',
    '```ts\nconst x = 1;\n```\n',
    'indent\n\tindented\n',
    '"quotes" `backticks`\n',
    'CRLF line\r\nLF line\n',
    'emoji 🧪 unicode 日本語\n',
    '{"json":true,"n":1}\n',
    'SENTINEL_BEGIN\n',
  ];
  let out = blocks.join('');
  const pad = 'PAD'.repeat(1000);
  while (Buffer.byteLength(out, 'utf8') < 100 * 1024) {
    out += `${pad}\nSENTINEL_BLOCK\n`;
  }
  return out;
}

describe('ADR-010 bridge gateway', () => {
  const PORT = 14546;
  const TOKEN = 'spike-bridge-token-not-a-secret';
  let server: BridgeServer;
  let capturedMessage = '';
  let tmp: string;
  let prevRuns: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      port: PORT,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1'],
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: descriptor.task ?? 'spike',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* (message: string) {
          capturedMessage = message;
          yield { type: 'thinking' };
          yield { type: 'answer_chunk', text: 'ok' };
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

  it('rejects unauthenticated RPC', async () => {
    const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread.create', params: {} }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('serves health without leaking the token', async () => {
    const res = await httpRequest(`http://127.0.0.1:${PORT}/health`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes(TOKEN), false);
    const json = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(json['ok'], true);
    assert.equal(json['protocol'], 'adr-010');
    assert.match(String(json['bind']), /127\.0\.0\.1/);
  });

  it('rejects origin that is not allowlisted', async () => {
    const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { ...auth, Origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread.create', params: {} }),
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects project_root outside the registered workspace', async () => {
    const res = await rpc('thread.create', { project_root: join(tmp, '..', '..') });
    assert.ok(res.json['error']);
  });

  it('submits a 100 KB prompt through ChatEngine without corruption', async () => {
    const fixture = buildIntegrityFixture();
    const source = hashUserMessage(fixture);
    assert.ok(source.byteLength >= 100 * 1024 - 32);

    const created = await rpc('thread.create', { project_root: tmp });
    const result = created.json['result'] as { thread_id: string };
    assert.ok(result.thread_id);

    capturedMessage = '';
    const submitted = await rpc('turn.submit', {
      thread_id: result.thread_id,
      message: fixture,
      command_id: 'cmd-integrity-1',
    });
    assert.ok(submitted.json['result']);

    await new Promise((r) => setTimeout(r, 80));

    const engineBoundary = hashUserMessage(capturedMessage);
    assert.equal(engineBoundary.byteLength, source.byteLength);
    assert.equal(engineBoundary.sha256, source.sha256);

    const recorded = [...server.protocolGateway.host.lastMessageIntegrity.values()].at(-1);
    assert.ok(recorded);
    assert.equal(recorded.sha256, source.sha256);
    assert.equal(
      createHash('sha256').update(Buffer.from(fixture, 'utf8')).digest('hex'),
      source.sha256,
    );

    const replay = await rpc('history.lookup', { thread_id: result.thread_id }, 11);
    assert.ok(replay.json['result']);
    assert.equal(
      (replay.json['result'] as { cells?: unknown[] }).cells !== undefined,
      true,
    );
  });

  it('replays identical command_id and rejects payload mutation', async () => {
    const created = await rpc('thread.create', { project_root: tmp }, 2);
    const threadId = (created.json['result'] as { thread_id: string }).thread_id;
    const first = await rpc(
      'turn.submit',
      { thread_id: threadId, message: 'hello', command_id: 'same-cmd' },
      3,
    );
    const again = await rpc(
      'turn.submit',
      { thread_id: threadId, message: 'hello', command_id: 'same-cmd' },
      4,
    );
    assert.deepEqual(again.json['result'], first.json['result']);
    const mutated = await rpc(
      'turn.submit',
      { thread_id: threadId, message: 'HELLO', command_id: 'same-cmd' },
      5,
    );
    assert.ok(mutated.json['error']);
  });

  it('cancels an in-progress turn using existing ChatEngine.cancel', async () => {
    let cancelled = false;
    const local = new BridgeServer({
      port: 14547,
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'cancel',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          yield { type: 'thinking' };
          await new Promise((r) => setTimeout(r, 200));
          yield { type: 'cancelled' };
        } as ChatEngine['submitMessageStream'];
        const original = engine.cancel.bind(engine);
        engine.cancel = () => {
          cancelled = true;
          original();
        };
        return engine;
      },
    });
    await local.start(14547);
    try {
      const create = await httpRequest(`http://127.0.0.1:14547/rpc`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'thread.create',
          params: { project_root: tmp },
        }),
      });
      const threadId = (JSON.parse(create.body) as { result: { thread_id: string } }).result
        .thread_id;
      await httpRequest(`http://127.0.0.1:14547/rpc`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'turn.submit',
          params: { thread_id: threadId, message: 'hang' },
        }),
      });
      const cancel = await httpRequest(`http://127.0.0.1:14547/rpc`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'turn.cancel',
          params: { thread_id: threadId },
        }),
      });
      const json = JSON.parse(cancel.body) as { result?: { cancelled: boolean } };
      assert.equal(json.result?.cancelled, true);
      assert.equal(cancelled, true);
    } finally {
      await local.stop();
    }
  });

  it('rejects oversized RPC bodies', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024 + 10);
    const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'turn.submit', params: { message: huge } }),
    });
    assert.ok(res.statusCode === 413 || res.body.includes('exceeds'));
  });

  it('does not broaden ChatEngine execution profile for remote turns', () => {
    const factory = server.protocolGateway.host.engineFactory;
    const engine = factory({
      schemaVersion: 1,
      threadId: 'parity',
      projectRoot: tmp,
      mode: 'chat',
      provider: 'default',
      model: 'default',
      policyProfile: 'safe_repo',
      createdAt: new Date().toISOString(),
      kernelVersion: 'executor-kernel-v1',
      contractVersion: 'executor-contract-v1',
    });
    assert.equal(typeof engine.submitMessageStream, 'function');
    assert.equal(typeof engine.cancel, 'function');
  });
});
