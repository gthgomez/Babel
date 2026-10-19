import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import type { ServerResponse } from 'node:http';

import type { BridgeClientContext } from './bridgeClientAuth.js';
import { pairingCookieToken } from './bridgeClientAuth.js';
import type { BridgeHttpPrincipalTestHooks, BridgeServerOptions } from './sessionServer.js';
import { BridgeServer } from './sessionServer.js';

const TOKEN = 'ticket-mint-race-token-value';
const ORIGIN = 'http://127.0.0.1';

let bridgePort = 0;

function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      {
        hostname: parsed.hostname,
        port: bridgePort,
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

/** Test-only subclass: simulates pre-fix behavior (no post-body principal revalidation). */
class MintServerWithoutPostAwaitGuard extends BridgeServer {
  protected override resolvePrincipalAfterBody(
    _req: IncomingMessage,
    _parsedUrl: Parameters<BridgeServer['resolvePrincipalAfterBody']>[1],
    principalBefore: BridgeClientContext,
    _scope: 'mint' | 'rpc',
    _res: ServerResponse,
  ): BridgeClientContext | null {
    return principalBefore;
  }
}

function createPrincipalBarrier(scope: 'mint' | 'rpc'): {
  hooks: BridgeHttpPrincipalTestHooks;
  waitUntilEntered: () => Promise<void>;
  release: () => void;
} {
  let entered = false;
  let releaseBarrier: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  return {
    hooks: {
      async afterInitialPrincipalAuthenticated(hookScope) {
        if (hookScope !== scope) return;
        entered = true;
        await gate;
      },
    },
    waitUntilEntered: async () => {
      const deadline = Date.now() + 5_000;
      while (!entered) {
        if (Date.now() > deadline) throw new Error('principal barrier not entered');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    release: () => releaseBarrier(),
  };
}

function postWithDelayedBody(input: {
  path: string;
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
        port: bridgePort,
        path: input.path,
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
    req.write(first, () => {
      setImmediate(() => {
        void input
          .duringPause()
          .then(() => {
            if (rest.length > 0) req.write(rest);
            req.end();
          })
          .catch(reject);
      });
    });
  });
}

function sessionTokenFromCookieHeader(cookieHeader: string): string {
  const token = pairingCookieToken({ headers: { cookie: cookieHeader } } as IncomingMessage);
  assert.ok(token);
  return token;
}

describe('HTTP principal barriers (mint + RPC)', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevHome: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-ticket-race-'));
    prevHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: true,
    });
    await server.start(0);
    bridgePort = server.port;
  });

  afterEach(async () => {
    if (server?.started) await server.stop();
  });

  after(async () => {
    if (server?.started) await server.stop();
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function pairCookie(label: string): Promise<{ cookie: string; deviceId: string }> {
    const ch = await httpRequest(`http://127.0.0.1:${bridgePort}/pair/challenge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const { challengeId } = JSON.parse(ch.body) as { challengeId: string };
    await httpRequest(`http://127.0.0.1:${bridgePort}/pair/request`, {
      method: 'POST',
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ challenge_id: challengeId, device_label: label }),
    });
    await httpRequest(`http://127.0.0.1:${bridgePort}/pair/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ challenge_id: challengeId }),
    });
    const st = await httpRequest(
      `http://127.0.0.1:${bridgePort}/pair/status?challenge_id=${encodeURIComponent(challengeId)}`,
      { headers: { Origin: ORIGIN } },
    );
    const cookie = st.headers['set-cookie'];
    assert.ok(cookie);
    const auth = JSON.parse(
      (await httpRequest(`http://127.0.0.1:${bridgePort}/auth/session`, { headers: { Cookie: cookie } })).body,
    ) as { deviceId: string };
    return { cookie, deviceId: auth.deviceId };
  }

  async function restartServer(
    options: BridgeServerOptions,
    ServerCtor: typeof BridgeServer = BridgeServer,
  ): Promise<void> {
    if (server?.started) await server.stop();
    server = new ServerCtor(options);
    await server.start(0);
    bridgePort = server.port;
  }

  async function mintContext(cookie: string) {
    const sess = await httpRequest(`http://127.0.0.1:${bridgePort}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await httpRequest(`http://127.0.0.1:${bridgePort}/rpc`, {
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
    return { sessionId, threadId };
  }

  it('E1: rejects ticket mint after post-initial-auth revoke once body completes', async () => {
    const barrier = createPrincipalBarrier('mint');
    await restartServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      httpPrincipalTestHooks: barrier.hooks,
    });

    const { cookie, deviceId } = await pairCookie('mint-barrier');
    const { sessionId, threadId } = await mintContext(cookie);
    const body = JSON.stringify({ session_id: sessionId, thread_id: threadId });
    const mintPromise = postWithDelayedBody({
      path: '/ws/ticket',
      cookie,
      body,
      pauseAfterBytes: 1,
      duringPause: async () => {
        await barrier.waitUntilEntered();
        const revoked = await httpRequest(`http://127.0.0.1:${bridgePort}/pair/devices/${deviceId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(revoked.statusCode, 200);
        barrier.release();
      },
    });
    const mintRes = await mintPromise;
    assert.ok(mintRes.statusCode === 401 || mintRes.statusCode === 403);
    assert.doesNotMatch(mintRes.body, /"ticket":/);
  });

  it('E1 regression: without post-body guard, mint succeeds after revoke (fail-before)', async () => {
    const barrier = createPrincipalBarrier('mint');
    await restartServer(
      {
        authToken: TOKEN,
        allowedWorkspaceRoot: tmp,
        allowedOrigins: ['http://127.0.0.1:*'],
        httpPrincipalTestHooks: barrier.hooks,
      },
      MintServerWithoutPostAwaitGuard,
    );

    const { cookie, deviceId } = await pairCookie('mint-vuln');
    const { sessionId, threadId } = await mintContext(cookie);
    const body = JSON.stringify({ session_id: sessionId, thread_id: threadId });
    const mintRes = await postWithDelayedBody({
      path: '/ws/ticket',
      cookie,
      body,
      pauseAfterBytes: 1,
      duringPause: async () => {
        await barrier.waitUntilEntered();
        await httpRequest(`http://127.0.0.1:${bridgePort}/pair/devices/${deviceId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        barrier.release();
      },
    });
    assert.equal(mintRes.statusCode, 200);
    assert.match(mintRes.body, /"ticket":/);
  });

  it('E1: rejects RPC after post-initial-auth revoke once body completes', async () => {
    const barrier = createPrincipalBarrier('rpc');
    await restartServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      httpPrincipalTestHooks: barrier.hooks,
    });

    const { cookie, deviceId } = await pairCookie('rpc-barrier');
    const rpcBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'remote.capabilities',
      params: {},
    });
    const rpcRes = await postWithDelayedBody({
      path: '/rpc',
      cookie,
      body: rpcBody,
      pauseAfterBytes: 1,
      duringPause: async () => {
        await barrier.waitUntilEntered();
        await httpRequest(`http://127.0.0.1:${bridgePort}/pair/devices/${deviceId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        barrier.release();
      },
    });
    assert.equal(rpcRes.statusCode, 401);
    const payload = JSON.parse(rpcRes.body) as { error?: { message?: string } };
    assert.match(payload.error?.message ?? '', /Authentication|required|revoked/i);
  });

  it('E2: rejects ticket mint when paired session expires but device stays authorized', async () => {
    const barrier = createPrincipalBarrier('mint');
    await restartServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      httpPrincipalTestHooks: barrier.hooks,
    });

    const { cookie, deviceId } = await pairCookie('mint-expire');
    const sessionToken = sessionTokenFromCookieHeader(cookie);
    const { sessionId, threadId } = await mintContext(cookie);
    const body = JSON.stringify({ session_id: sessionId, thread_id: threadId });
    const mintRes = await postWithDelayedBody({
      path: '/ws/ticket',
      cookie,
      body,
      pauseAfterBytes: 1,
      duringPause: async () => {
        await barrier.waitUntilEntered();
        assert.equal(server.devicePairing.isDeviceAuthorized(deviceId), true);
        assert.equal(server.devicePairing.expirePairedSessionByToken(sessionToken), true);
        assert.equal(server.devicePairing.isDeviceAuthorized(deviceId), true);
        barrier.release();
      },
    });
    assert.ok(mintRes.statusCode === 401 || mintRes.statusCode === 403);
    assert.doesNotMatch(mintRes.body, /"ticket":/);
  });
});
