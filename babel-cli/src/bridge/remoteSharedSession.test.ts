import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import type { RemoteCatalogResult } from './remoteCatalog.js';
import {
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { HttpProtocolClient } from './httpProtocolClient.js';
import { BridgeServer } from './sessionServer.js';
import type { ThreadCreateResult, ThreadResumeResult } from '../protocol/types.js';

const TOKEN = 'shared-host-token-not-secret';
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

describe('Babel Remote shared protocol host (Phase 2)', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevRuns: string | undefined;
  let port = 0;
  let desktop: HttpProtocolClient;
  let remoteCookie: string;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-shared-'));
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
          task: descriptor.task ?? 'shared',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        }),
    });
    await server.start(0);
    port = server.port;
    const base = `http://127.0.0.1:${port}`;
    desktop = new HttpProtocolClient({
      baseUrl: base,
      desktopClientId: desktopId,
      desktopProofKey,
    });

    const challengeRes = await httpRequest(`http://127.0.0.1:${port}/pair/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const challenge = JSON.parse(challengeRes.body) as { challengeId: string };
    await httpRequest(`http://127.0.0.1:${port}/pair/request`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ challenge_id: challenge.challengeId, device_label: 'shared remote' }),
    });
    await httpRequest(`http://127.0.0.1:${port}/pair/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ challenge_id: challenge.challengeId }),
    });
    const statusRes = await httpRequest(
      `http://127.0.0.1:${port}/pair/status?challenge_id=${encodeURIComponent(challenge.challengeId)}`,
      { headers: { Origin: ORIGIN } },
    );
    const cookieHeader = statusRes.headers['set-cookie'];
    assert.ok(cookieHeader);
    remoteCookie = cookieHeader;
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function remoteRpc<M extends string, P, R>(method: M, params: P, id = 1): Promise<R> {
    const res = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Cookie: remoteCookie, Origin: ORIGIN },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const body = JSON.parse(res.body) as { result?: R; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as R;
  }

  it('Scenario A: desktop-created thread appears in remote.catalog on the same host', async () => {
    const desktopSession = await desktop.createTransportSession(tmp);
    const created = await desktop.call<'thread.create', { project_root: string; session_id: string }, ThreadCreateResult>(
      'thread.create',
      {
        project_root: tmp,
        session_id: desktopSession,
      },
    );
    const threadId = created.thread_id;
    const catalog = await remoteRpc<'remote.catalog', Record<string, never>, RemoteCatalogResult>(
      'remote.catalog',
      {},
    );
    assert.ok(
      catalog.sessions.some((session: { thread_id: string }) => session.thread_id === threadId),
      `remote catalog missing desktop thread ${threadId}`,
    );
  });

  it('Scenario B: remote transport session can resume the shared thread on the same host', async () => {
    const desktopSession = await desktop.createTransportSession(tmp);
    const created = await desktop.call<
      'thread.create',
      { project_root: string; session_id: string; task: string },
      ThreadCreateResult
    >('thread.create', {
      project_root: tmp,
      session_id: desktopSession,
      task: 'shared ownership probe',
    });
    const threadId = created.thread_id;
    const remoteSessionRes = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: { Cookie: remoteCookie, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    assert.equal(remoteSessionRes.statusCode, 201);
    const remoteSession = (JSON.parse(remoteSessionRes.body) as { sessionId: string }).sessionId;
    const resumed = await remoteRpc<
      'thread.resume',
      { thread_id: string; session_id: string },
      ThreadResumeResult
    >('thread.resume', {
      thread_id: threadId,
      session_id: remoteSession,
    });
    assert.equal(resumed.thread_id, threadId);
    const minted = await httpRequest(`http://127.0.0.1:${port}/ws/ticket`, {
      method: 'POST',
      headers: { Cookie: remoteCookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: remoteSession, thread_id: threadId }),
    });
    assert.equal(minted.statusCode, 200);
  });
});
