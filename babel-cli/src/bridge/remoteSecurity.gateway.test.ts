import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ChatEngine } from '../agent/chatEngine.js';
import {
  approvalOperationFromAgentAction,
  digestApprovalOperation,
} from '../agent/approvalOperation.js';
import { BridgeServer } from './sessionServer.js';
import { DevicePairingService } from './devicePairing.js';

const PORT = 14670;
const TOKEN = 'remote-security-token-fixed-value';
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

async function rpc(
  cookieOrBearer: { cookie?: string; bearer?: string },
  method: string,
  params: Record<string, unknown>,
  id = 1,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (cookieOrBearer.bearer) headers.Authorization = `Bearer ${cookieOrBearer.bearer}`;
  if (cookieOrBearer.cookie) headers.Cookie = cookieOrBearer.cookie;
  const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function pairPhone(label: string): Promise<string> {
  const challengeRes = await httpRequest(`http://127.0.0.1:${PORT}/pair/challenge`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const challenge = JSON.parse(challengeRes.body) as { challengeId: string };
  await httpRequest(`http://127.0.0.1:${PORT}/pair/request`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
    body: JSON.stringify({ challenge_id: challenge.challengeId, device_label: label }),
  });
  await httpRequest(`http://127.0.0.1:${PORT}/pair/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ challenge_id: challenge.challengeId }),
  });
  const statusRes = await httpRequest(
    `http://127.0.0.1:${PORT}/pair/status?challenge_id=${encodeURIComponent(challenge.challengeId)}`,
    { headers: { Origin: ORIGIN } },
  );
  const cookie = statusRes.headers['set-cookie'];
  assert.ok(cookie);
  return cookie;
}

describe('Remote security and failure gateway', () => {
  let server: BridgeServer;
  let tmp: string;
  let prevHome: string | undefined;
  let prevRuns: string | undefined;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-security-'));
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
        const engine = new ChatEngine({
          task: descriptor.task ?? 'sec',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* (message: string) {
          yield { type: 'answer_chunk', text: message.slice(0, 8) };
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

  it('advertises enforced exclusive remote control on production gateway', async () => {
    const body = await rpc({ bearer: TOKEN }, 'remote.capabilities', {});
    const result = body.result as {
      control_lease_enforced?: boolean;
      exclusive_remote_control?: boolean;
    };
    assert.equal(result.control_lease_enforced, true);
    assert.equal(result.exclusive_remote_control, true);
  });

  it('ignores paired force-acquire while another client holds the lease', async () => {
    const cookieA = await pairPhone('force-a');
    const cookieB = await pairPhone('force-b');
    const sessionRes = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookieA, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(sessionRes.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      { cookie: cookieA },
      'thread.create',
      { project_root: tmp, session_id: sessionId },
      10,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    const authA = JSON.parse(
      (await httpRequest(`http://127.0.0.1:${PORT}/auth/session`, { headers: { Cookie: cookieA } })).body,
    ) as { deviceId: string };
    const held = await rpc({ cookie: cookieA }, 'control.acquire', { thread_id: threadId }, 11);
    assert.ok(held.result);
    const displaced = await rpc(
      { cookie: cookieB },
      'control.acquire',
      { thread_id: threadId, force: true },
      12,
    );
    const err = displaced.error as { data?: { control_error?: string } } | undefined;
    assert.equal(err?.data?.control_error, 'held_by_other');
    const status = await rpc({ cookie: cookieA }, 'control.status', { thread_id: threadId }, 13);
    const st = status.result as { holder_client_id?: string; held?: boolean };
    assert.equal(st.held, true);
    assert.equal(st.holder_client_id, `device:${authA.deviceId}`);
  });

  it('rejects paired-device RPC without allowed Origin (CSRF)', async () => {
    const cookie = await pairPhone('csrf-phone');
    const res = await httpRequest(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'remote.capabilities',
        params: {},
      }),
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects stale control epochs and duplicate command_id payload changes', async () => {
    const cookie = await pairPhone('epoch-phone');
    const sessionRes = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessionId = (JSON.parse(sessionRes.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      { cookie },
      'thread.create',
      { project_root: tmp, session_id: sessionId },
      2,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    const acquired = await rpc({ cookie }, 'control.acquire', { thread_id: threadId }, 3);
    const epoch = (acquired.result as { epoch: number }).epoch;
    const first = await rpc(
      { cookie },
      'turn.submit',
      {
        thread_id: threadId,
        message: 'hello',
        command_id: 'sec-cmd-1',
        control_epoch: epoch,
      },
      4,
    );
    assert.ok(first.result);
    const stale = await rpc(
      { cookie },
      'turn.submit',
      {
        thread_id: threadId,
        message: 'hello again',
        command_id: 'sec-cmd-1',
        control_epoch: epoch - 1,
      },
      5,
    );
    assert.ok(stale.error);
    await rpc({ bearer: TOKEN }, 'control.acquire', { thread_id: threadId, force: true }, 6);
    const mutated = await rpc(
      { bearer: TOKEN },
      'turn.submit',
      { thread_id: threadId, message: 'HELLO', command_id: 'sec-cmd-1' },
      7,
    );
    assert.ok(mutated.error);
    const replay = await rpc(
      { bearer: TOKEN },
      'turn.submit',
      { thread_id: threadId, message: 'hello', command_id: 'sec-cmd-1' },
      8,
    );
    assert.deepEqual(replay.result, first.result);
  });

  it('rejects stale approval digests and replays', async () => {
    const { RemoteApprovalBroker } = await import('./remoteApproval.js');
    const threadId = 'thr-approval-sec';
    const operation = approvalOperationFromAgentAction(
      { type: 'write_file', path: 'x.ts', content: '1' },
      { thread_id: threadId, turn_id: '1', cwd: tmp },
    );
    const digest = digestApprovalOperation(operation);
    const localBroker = new RemoteApprovalBroker();
    const created = localBroker.createPending({
      thread_id: threadId,
      turn_id: '1',
      operation,
      now: 1,
    });
    const staleDigest = await localBroker.decide({
      approval_id: created.approval_id,
      decision: 'allow_once',
      thread_id: threadId,
      turn_id: '1',
      operation_digest: 'deadbeef',
      now: 1,
    });
    assert.equal(staleDigest.ok, false);
    const ok = localBroker.decide({
      approval_id: created.approval_id,
      decision: 'allow_once',
      thread_id: threadId,
      turn_id: '1',
      operation_digest: digest,
      now: 1,
    });
    assert.equal(ok.ok, true);
    const replay = localBroker.decide({
      approval_id: created.approval_id,
      decision: 'allow_once',
      thread_id: threadId,
      turn_id: '1',
      operation_digest: digest,
      now: 2,
    });
    assert.equal(replay.ok, false);
  });

  it('invalidates paired sessions after device revocation', async () => {
    const cookie = await pairPhone('revoke-phone');
    const authRes = await httpRequest(`http://127.0.0.1:${PORT}/auth/session`, {
      headers: { Cookie: cookie },
    });
    const auth = JSON.parse(authRes.body) as { deviceId?: string };
    const deviceId = auth.deviceId;
    assert.ok(deviceId);
    const del = await httpRequest(`http://127.0.0.1:${PORT}/pair/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(del.statusCode, 200);
    const res = await httpRequest(`http://127.0.0.1:${PORT}/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({ projectRoot: tmp }),
    });
    assert.equal(res.statusCode, 401);
  });

  it('restores persisted device sessions after pairing service restart', async () => {
    const cookie = await pairPhone('persist-phone');
    const secret = TOKEN;
    const reloaded = new DevicePairingService(secret);
    const token = cookie.split('=')[1]?.split(';')[0];
    assert.ok(token);
    const verified = reloaded.verifySessionToken(decodeURIComponent(token));
    assert.equal(verified.ok, true);
  });
});
