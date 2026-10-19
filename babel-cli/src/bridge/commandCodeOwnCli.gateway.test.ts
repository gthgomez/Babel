import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';

import {
  computeDesktopControllerProof,
  DESKTOP_CLIENT_ID_HEADER,
  DESKTOP_PROOF_HEADER,
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { globalCommandCodeAcpRuntime } from './commandCodeAcpRuntime.js';
import { BridgeServer } from './sessionServer.js';

const TOKEN = 'command-code-gateway-token';
const ORIGIN = 'http://127.0.0.1';
const PEER = fileURLToPath(new URL('../../test/fixtures/command-code-acp-peer.mjs', import.meta.url));

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

async function rpc(
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
  id = 1,
): Promise<Record<string, unknown>> {
  const res = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

let server: BridgeServer;
let port = 0;
let tmp = '';
let tmpB = '';
let prevRuns: string | undefined;
let prevPeer: string | undefined;
let prevPeerArgs: string | undefined;
let prevPermission: string | undefined;
const desktopId = mintDesktopControllerClientId();
const desktopProofKey = mintDesktopControllerProofKey();

function desktopHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    [DESKTOP_CLIENT_ID_HEADER]: desktopId,
    [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
    Origin: ORIGIN,
  };
}

async function runTurn(
  threadId: string,
  transportSessionId: string,
  message: string,
  options?: { approve?: boolean },
): Promise<{ events: Record<string, unknown>[]; terminal?: Record<string, unknown> }> {
  const ticketRes = await httpRequest(`http://127.0.0.1:${port}/ws/ticket`, {
    method: 'POST',
    headers: { ...desktopHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: transportSessionId, thread_id: threadId }),
  });
  const ticketBody = JSON.parse(ticketRes.body) as { ticket?: string };
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?sessionId=${encodeURIComponent(transportSessionId)}&ticket=${encodeURIComponent(ticketBody.ticket ?? '')}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const events: Record<string, unknown>[] = [];
  let approvalId: string | undefined;
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as { method?: string; params?: Record<string, unknown> };
    if (frame.method === 'turn.event' && frame.params?.event) {
      events.push(frame.params.event as Record<string, unknown>);
    }
    if (frame.method === 'permission.request' && frame.params) {
      approvalId = String(frame.params.approval_id ?? '');
      if (options?.approve && approvalId) {
        void rpc(desktopHeaders(), 'approval.decide', {
          thread_id: threadId,
          turn_id: String(frame.params.turn_id ?? ''),
          approval_id: approvalId,
          decision: 'allow_once',
          operation_digest: frame.params.operation_digest,
        });
      }
    }
  });
  const submit = await rpc(desktopHeaders(), 'turn.submit', { thread_id: threadId, message }, 50);
  assert.ok(submit.result);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 8_000);
    const check = () => {
      const terminal = events.find((e) =>
        e.type === 'done' || e.type === 'failed' || e.type === 'cancelled',
      );
      if (terminal) {
        clearTimeout(timer);
        resolve();
      }
    };
    ws.on('message', () => check());
    check();
  });
  ws.close();
  const terminal = events.find((e) => e.type === 'done' || e.type === 'failed' || e.type === 'cancelled');
  return terminal ? { events, terminal } : { events };
}

describe('command code own-CLI gateway integration', () => {
  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-cc-gw-a-'));
    tmpB = mkdtempSync(join(tmpdir(), 'babel-cc-gw-b-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    prevPeer = process.env['BABEL_COMMAND_CODE_ACP_COMMAND'];
    prevPeerArgs = process.env['BABEL_COMMAND_CODE_ACP_ARGS'];
    prevPermission = process.env['BABEL_COMMAND_CODE_FIXTURE_PERMISSION'];
    process.env['BABEL_COMMAND_CODE_ACP_COMMAND'] = process.execPath;
    process.env['BABEL_COMMAND_CODE_ACP_ARGS'] = JSON.stringify([PEER]);
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
    });
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await globalCommandCodeAcpRuntime.closeAll();
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    if (prevPeer === undefined) delete process.env['BABEL_COMMAND_CODE_ACP_COMMAND'];
    else process.env['BABEL_COMMAND_CODE_ACP_COMMAND'] = prevPeer;
    if (prevPeerArgs === undefined) delete process.env['BABEL_COMMAND_CODE_ACP_ARGS'];
    else process.env['BABEL_COMMAND_CODE_ACP_ARGS'] = prevPeerArgs;
    if (prevPermission === undefined) delete process.env['BABEL_COMMAND_CODE_FIXTURE_PERMISSION'];
    else process.env['BABEL_COMMAND_CODE_FIXTURE_PERMISSION'] = prevPermission;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  });

  it('advertises harness adapters on remote.capabilities', async () => {
    const body = await rpc(desktopHeaders(), 'remote.capabilities', {});
    const harness = body.result as { harness_adapters?: { descriptor: { id: string } }[] };
    assert.ok(Array.isArray(harness.harness_adapters));
    const commandCode = harness.harness_adapters?.find((row) => row.descriptor.id === 'command-code');
    assert.ok(commandCode);
  });

  it('runs two turns on the same command-code thread via real ACP child', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      desktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        provider: 'fixture-provider',
        model: 'fixture-model',
      },
      2,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 3);
    const first = await runTurn(threadId, transportSessionId, 'hello command code');
    assert.equal(first.terminal?.type, 'done');
    assert.match(String((first.terminal as { answer?: string }).answer ?? ''), /fixture:hello command code/);
    const second = await runTurn(threadId, transportSessionId, 'second turn');
    assert.equal(second.terminal?.type, 'done');
    assert.match(String((second.terminal as { answer?: string }).answer ?? ''), /fixture:second turn/);
  });

  it('maps ACP permission prompts through approval.decide', async () => {
    process.env['BABEL_COMMAND_CODE_FIXTURE_PERMISSION'] = '1';
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      desktopHeaders(),
      'thread.create',
      { project_root: tmp, session_id: transportSessionId, harness_adapter_id: 'command-code' },
      10,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 11);
    const turn = await runTurn(threadId, transportSessionId, 'needs approval', { approve: true });
    assert.equal(turn.terminal?.type, 'done');
    delete process.env['BABEL_COMMAND_CODE_FIXTURE_PERMISSION'];
  });

  it('isolates command-code runtimes per registered workspace root', async () => {
    const serverB = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmpB,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: false,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
    });
    await serverB.start(0);
    const portB = serverB.port;
    const headers = desktopHeaders();
    const sessA = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const sessB = await httpRequest(`http://127.0.0.1:${portB}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectRoot: tmpB }),
    });
    const sessionA = (JSON.parse(sessA.body) as { sessionId: string }).sessionId;
    const sessionB = (JSON.parse(sessB.body) as { sessionId: string }).sessionId;
    const threadA = (
      await rpc(headers, 'thread.create', {
        project_root: tmp,
        session_id: sessionA,
        harness_adapter_id: 'command-code',
      }, 20)
    ).result as { thread_id: string };
    const createdB = await httpRequest(`http://127.0.0.1:${portB}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'thread.create',
        params: {
          project_root: tmpB,
          session_id: sessionB,
          harness_adapter_id: 'command-code',
        },
      }),
    });
    const threadB = (JSON.parse(createdB.body) as { result: { thread_id: string } }).result;
    assert.notEqual(threadA.thread_id, threadB.thread_id);
    await serverB.stop();
    await globalCommandCodeAcpRuntime.evictProject(tmpB);
  });
});
