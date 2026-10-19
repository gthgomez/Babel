import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
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
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'shared-host-run-journey-token';
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

function stubEngine(
  body: (message: string) => AsyncGenerator<Record<string, unknown>, void, unknown>,
): (descriptor: { projectRoot: string; task?: string }) => ChatEngine {
  return (descriptor) => {
    const engine = new ChatEngine({
      task: descriptor.task ?? 'journey',
      projectRoot: descriptor.projectRoot,
      executionProfile: 'chat',
    });
    engine.submitMessageStream = async function* (message: string) {
      yield* body(message);
    } as ChatEngine['submitMessageStream'];
    return engine;
  };
}

const zeroUsage = {
  totalCostUSD: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  modelBreakdown: {},
};

describe('shared protocol host-run production journeys', () => {
  let server: BridgeServer;
  let tmp: string;
  let port = 0;
  let prevRuns: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-host-run-journey-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: stubEngine((message) =>
        (async function* () {
          yield { type: 'answer_chunk', text: message.slice(0, 8) };
          yield { type: 'done', answer: message, usage: zeroUsage };
        })(),
      ),
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

  async function runHostTurn(
    options: {
      task: string;
      runId: string;
      resumeThreadId?: string;
      model?: string;
      provider?: string;
      commandId?: string;
      stdin?: NodeJS.ReadableStream;
      signal?: AbortSignal;
    },
  ): Promise<{ events: Record<string, unknown>[]; code: number }> {
    const events: Record<string, unknown>[] = [];
    const code = await executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: options.task,
        runId: options.runId,
        desktopClientId: desktopId,
        desktopProofKey,
        ...(options.resumeThreadId ? { resumeThreadId: options.resumeThreadId } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.commandId ? { commandId: options.commandId } : {}),
        ...(options.stdin ? { stdin: options.stdin } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (event) => events.push(event),
    );
    return { events, code };
  }

  it('two-turn desktop host-run keeps thread_id and exposes thread to paired PWA catalog', async () => {
    const first = await runHostTurn({ task: 'turn one shared owner', runId: 'journey-1' });
    assert.equal(first.code, 0);
    const complete = first.events.find((e) => e.type === 'run_complete') as {
      result?: { session_id?: string };
    };
    const threadId = complete?.result?.session_id;
    assert.ok(threadId);

    const cookie = await pairCookie('pwa catalog peer');
    const catalogRes = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'remote.catalog', params: {} }),
    });
    const catalogBody = JSON.parse(catalogRes.body) as {
      result?: { sessions: { thread_id: string }[] };
    };
    assert.ok(
      catalogBody.result?.sessions.some((s) => s.thread_id === threadId),
      'paired remote catalog must list the desktop thread',
    );

    const second = await runHostTurn({
      task: 'turn two same thread',
      runId: 'journey-2',
      resumeThreadId: threadId,
    });
    assert.equal(second.code, 0);
    const secondComplete = second.events.find((e) => e.type === 'run_complete') as {
      result?: { session_id?: string };
    };
    assert.equal(secondComplete?.result?.session_id, threadId);
  });

  it('streams tool and file events through the host-run NDJSON surface', async () => {
    await server.stop();
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: stubEngine(() =>
        (async function* () {
          yield { type: 'tool_start', tool: 'read_file', target: 'README.md', toolCallId: 't1' };
          yield { type: 'file_changed', path: 'README.md', additions: 2, deletions: 0 };
          yield { type: 'done', answer: 'ok', usage: zeroUsage };
        })(),
      ),
    });
    await server.start(0);
    port = server.port;

    const { events, code } = await runHostTurn({ task: 'tooling', runId: 'journey-tools' });
    assert.equal(code, 0);
    assert.ok(events.some((e) => e.type === 'tool.started'));
    assert.ok(events.some((e) => e.type === 'file.changed'));
  });

  it('passes command_id through to the protocol turn.submit path', async () => {
    await server.stop();
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: stubEngine((message) =>
        (async function* () {
          yield { type: 'done', answer: message, usage: zeroUsage };
        })(),
      ),
    });
    await server.start(0);
    port = server.port;
    const { code } = await runHostTurn({
      task: 'command id wiring',
      runId: 'journey-cmd',
      commandId: 'desktop-journey-cmd-1',
    });
    assert.equal(code, 0);
  });

  it('paired remote client can take control lease while desktop uses force:false only', async () => {
    const desktopHeaders = {
      [DESKTOP_CLIENT_ID_HEADER]: desktopId,
      [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
      Origin: ORIGIN,
    };
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'thread.create',
        params: { project_root: tmp, session_id: sessionId },
      }),
    });
    const threadId = (JSON.parse(created.body) as { result: { thread_id: string } }).result.thread_id;
    const desktopLease = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'control.acquire',
        params: { thread_id: threadId, force: false },
      }),
    });
    const desktopHolder = (JSON.parse(desktopLease.body) as { result: { holder_client_id: string } })
      .result.holder_client_id;
    assert.equal(desktopHolder, desktopId);

    const cookie = await pairCookie('remote priority during host-run');
    const takeover = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'control.acquire',
        params: { thread_id: threadId, force: false },
      }),
    });
    const remoteHolder = (JSON.parse(takeover.body) as { result: { holder_client_id: string } })
      .result.holder_client_id;
    assert.match(remoteHolder, /^device:/);
  });

  it('isolates provider/model on thread.create for separate host-run sessions', async () => {
    const modelA = await runHostTurn({
      task: 'route A',
      runId: 'journey-model-a',
      model: 'model-a-fixture',
      provider: 'fixture-provider-a',
    });
    const modelB = await runHostTurn({
      task: 'route B',
      runId: 'journey-model-b',
      model: 'model-b-fixture',
      provider: 'fixture-provider-b',
    });
    const threadA = (
      modelA.events.find((e) => e.type === 'run_complete') as { result?: { session_id?: string } }
    )?.result?.session_id;
    const threadB = (
      modelB.events.find((e) => e.type === 'run_complete') as { result?: { session_id?: string } }
    )?.result?.session_id;
    assert.ok(threadA && threadB);
    assert.notEqual(threadA, threadB);
  });
});
