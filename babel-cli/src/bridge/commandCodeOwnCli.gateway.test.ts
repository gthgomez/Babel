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
import { BridgeServer } from './sessionServer.js';

const TOKEN = 'command-code-gateway-token';
const ORIGIN = 'http://127.0.0.1';
const PEER = fileURLToPath(new URL('../../test/fixtures/command-code-acp-peer.mjs', import.meta.url));
const VERSION_FIXTURE = fileURLToPath(
  new URL('../../test/fixtures/command-code-version.mjs', import.meta.url),
);

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

let server: BridgeServer;
let port = 0;
let tmp = '';
let tmpB = '';
let prevRuns: string | undefined;
let prevCliExecutable: string | undefined;
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

async function rpc(
  rpcPort: number,
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
  id = 1,
): Promise<Record<string, unknown>> {
  const res = await httpRequest(`http://127.0.0.1:${rpcPort}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

async function runTurn(
  rpcPort: number,
  threadId: string,
  transportSessionId: string,
  message: string,
  options?: { approve?: boolean },
): Promise<{ events: Record<string, unknown>[]; terminal?: Record<string, unknown> }> {
  const ticketRes = await httpRequest(`http://127.0.0.1:${rpcPort}/ws/ticket`, {
    method: 'POST',
    headers: { ...desktopHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: transportSessionId, thread_id: threadId }),
  });
  const ticketBody = JSON.parse(ticketRes.body) as { ticket?: string };
  const ws = new WebSocket(
    `ws://127.0.0.1:${rpcPort}/ws?sessionId=${encodeURIComponent(transportSessionId)}&ticket=${encodeURIComponent(ticketBody.ticket ?? '')}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const events: Record<string, unknown>[] = [];
  let sawPermission = false;
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as { method?: string; params?: Record<string, unknown> };
    if (frame.method === 'turn.event' && frame.params?.event) {
      events.push(frame.params.event as Record<string, unknown>);
    }
    if (frame.method === 'permission.request' && frame.params) {
      sawPermission = true;
      if (options?.approve) {
        void rpc(rpcPort, desktopHeaders(), 'approval.decide', {
          thread_id: threadId,
          turn_id: String(frame.params.turn_id ?? ''),
          approval_id: String(frame.params.approval_id ?? ''),
          decision: 'allow_once',
          operation_digest: frame.params.operation_digest,
        });
      }
    }
  });
  const submit = await rpc(rpcPort, desktopHeaders(), 'turn.submit', { thread_id: threadId, message }, 50);
  assert.ok(submit.result);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 12_000);
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
  if (options?.approve) assert.ok(sawPermission, 'expected permission.request notification');
  return terminal ? { events, terminal } : { events };
}

function verifiedInstallProbe() {
  return Promise.resolve({
    state: 'verified' as const,
    executable: VERSION_FIXTURE,
    version: '1.0.0',
  });
}

const PROMPT_ADMITTED_MARKER = 'fixture:prompt-admitted';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTurnEvent(
  events: Record<string, unknown>[],
  predicate: (event: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for turn event: ${label}`);
}

function promptAdmittedEvent(event: Record<string, unknown>): boolean {
  return (
    event.type === 'answer_chunk' &&
    String((event as { text?: string }).text ?? '').includes(PROMPT_ADMITTED_MARKER)
  );
}

async function withDedicatedServer(
  launchEnv: NodeJS.ProcessEnv | undefined,
  run: (dedicated: BridgeServer, dedicatedPort: number) => Promise<void>,
): Promise<void> {
  const dedicated = makeServer(launchEnv);
  await dedicated.start(0);
  try {
    await run(dedicated, dedicated.port);
  } finally {
    await dedicated.stop();
  }
}

function makeServer(launchEnv?: NodeJS.ProcessEnv): BridgeServer {
  return new BridgeServer({
    authToken: TOKEN,
    allowedWorkspaceRoot: tmp,
    allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
    enforceControlLease: true,
    desktopControllerClientId: desktopId,
    desktopControllerProofKey: desktopProofKey,
    commandCodeInstallProbe: verifiedInstallProbe,
    commandCodeTestLaunch: {
      command: process.execPath,
      args: [PEER],
      ...(launchEnv ? { env: launchEnv } : {}),
    },
  });
}

describe('command code own-CLI gateway integration', () => {
  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-cc-gw-a-'));
    tmpB = mkdtempSync(join(tmpdir(), 'babel-cc-gw-b-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    prevCliExecutable = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = VERSION_FIXTURE;
    server = makeServer();
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    if (prevCliExecutable === undefined) delete process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    else process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = prevCliExecutable;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  });

  it('advertises harness adapters on remote.capabilities', async () => {
    const body = await rpc(port, desktopHeaders(), 'remote.capabilities', {});
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
      port,
      desktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
      },
      2,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(port, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 3);
    const first = await runTurn(port, threadId, transportSessionId, 'hello command code');
    assert.equal(first.terminal?.type, 'done');
    assert.match(String((first.terminal as { answer?: string }).answer ?? ''), /fixture:hello command code/);
    const catalog = await rpc(port, desktopHeaders(), 'remote.catalog', {}, 4);
    const row = (catalog.result as { sessions: { thread_id: string; harness_native_session_id?: string }[] })
      .sessions.find((s) => s.thread_id === threadId);
    assert.ok(row?.harness_native_session_id);
    const second = await runTurn(port, threadId, transportSessionId, 'second turn');
    assert.equal(second.terminal?.type, 'done');
    assert.match(String((second.terminal as { answer?: string }).answer ?? ''), /fixture:second turn/);
  });

  it('ignores session/new startup idle before prompt admission', async () => {
    await withDedicatedServer({ BABEL_COMMAND_CODE_FIXTURE_STARTUP_IDLE: '1' }, async (idleServer, iPort) => {
      const sess = await httpRequest(`http://127.0.0.1:${iPort}/sessions`, {
        method: 'POST',
        headers: desktopHeaders(),
        body: JSON.stringify({ projectRoot: tmp }),
      });
      const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
      const created = await rpc(
        iPort,
        desktopHeaders(),
        'thread.create',
        { project_root: tmp, session_id: transportSessionId, harness_adapter_id: 'command-code' },
        40,
      );
      const threadId = (created.result as { thread_id: string }).thread_id;
      await rpc(iPort, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 41);
      const turn = await runTurn(iPort, threadId, transportSessionId, 'hello command code');
      assert.equal(turn.terminal?.type, 'done');
      assert.match(String((turn.terminal as { answer?: string }).answer ?? ''), /fixture:hello command code/);
    });
  });

  it('maps ACP permission prompts through approval.decide on a dedicated peer env', async () => {
    await withDedicatedServer({ BABEL_COMMAND_CODE_FIXTURE_PERMISSION: '1' }, async (permissionServer, pPort) => {
      const sess = await httpRequest(`http://127.0.0.1:${pPort}/sessions`, {
        method: 'POST',
        headers: desktopHeaders(),
        body: JSON.stringify({ projectRoot: tmp }),
      });
      const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
      const created = await rpc(
        pPort,
        desktopHeaders(),
        'thread.create',
        { project_root: tmp, session_id: transportSessionId, harness_adapter_id: 'command-code' },
        10,
      );
      const threadId = (created.result as { thread_id: string }).thread_id;
      await rpc(pPort, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 11);
      const turn = await runTurn(pPort, threadId, transportSessionId, 'needs approval', { approve: true });
      assert.equal(turn.terminal?.type, 'done');
    });
  });

  it('preserves pending cancel through session startup without peer prompt admission', async () => {
    await withDedicatedServer(
      { BABEL_COMMAND_CODE_FIXTURE_DEFER_SESSION_NEW_MS: '400' },
      async (dedicated, sPort) => {
        const sess = await httpRequest(`http://127.0.0.1:${sPort}/sessions`, {
          method: 'POST',
          headers: desktopHeaders(),
          body: JSON.stringify({ projectRoot: tmp }),
        });
        const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
        const created = await rpc(
          sPort,
          desktopHeaders(),
          'thread.create',
          { project_root: tmp, session_id: transportSessionId, harness_adapter_id: 'command-code' },
          24,
        );
        const threadId = (created.result as { thread_id: string }).thread_id;
        await rpc(sPort, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 25);
        const ticketRes = await httpRequest(`http://127.0.0.1:${sPort}/ws/ticket`, {
          method: 'POST',
          headers: { ...desktopHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: transportSessionId, thread_id: threadId }),
        });
        const ticketBody = JSON.parse(ticketRes.body) as { ticket?: string };
        const ws = new WebSocket(
          `ws://127.0.0.1:${sPort}/ws?sessionId=${encodeURIComponent(transportSessionId)}&ticket=${encodeURIComponent(ticketBody.ticket ?? '')}`,
        );
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', reject);
        });
        const events: Record<string, unknown>[] = [];
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as { method?: string; params?: Record<string, unknown> };
          if (frame.method === 'turn.event' && frame.params?.event) {
            events.push(frame.params.event as Record<string, unknown>);
          }
        });
        void rpc(sPort, desktopHeaders(), 'turn.submit', { thread_id: threadId, message: 'startup-cancel' }, 26);
        await rpc(sPort, desktopHeaders(), 'turn.cancel', { thread_id: threadId }, 27);
        await waitForTurnEvent(events, (event) => event.type === 'cancelled', 'startup_cancelled');
        ws.close();
        assert.equal(events.some((event) => promptAdmittedEvent(event)), false);
      },
    );
  });

  it('does not fabricate cancelled without authoritative peer terminal', async () => {
    await withDedicatedServer(
      {
        BABEL_COMMAND_CODE_FIXTURE_SLOW: '1',
        BABEL_COMMAND_CODE_FIXTURE_NO_CANCEL_TERMINAL: '1',
      },
      async (dedicated, sPort) => {
        const sess = await httpRequest(`http://127.0.0.1:${sPort}/sessions`, {
          method: 'POST',
          headers: desktopHeaders(),
          body: JSON.stringify({ projectRoot: tmp }),
        });
        const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
        const created = await rpc(
          sPort,
          desktopHeaders(),
          'thread.create',
          { project_root: tmp, session_id: transportSessionId, harness_adapter_id: 'command-code' },
          20,
        );
        const threadId = (created.result as { thread_id: string }).thread_id;
        await rpc(sPort, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 21);
        const ticketRes = await httpRequest(`http://127.0.0.1:${sPort}/ws/ticket`, {
          method: 'POST',
          headers: { ...desktopHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: transportSessionId, thread_id: threadId }),
        });
        const ticketBody = JSON.parse(ticketRes.body) as { ticket?: string };
        const ws = new WebSocket(
          `ws://127.0.0.1:${sPort}/ws?sessionId=${encodeURIComponent(transportSessionId)}&ticket=${encodeURIComponent(ticketBody.ticket ?? '')}`,
        );
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', reject);
        });
        const events: Record<string, unknown>[] = [];
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as { method?: string; params?: Record<string, unknown> };
          if (frame.method === 'turn.event' && frame.params?.event) {
            events.push(frame.params.event as Record<string, unknown>);
          }
        });
        void rpc(sPort, desktopHeaders(), 'turn.submit', { thread_id: threadId, message: 'slow' }, 22);
        await waitForTurnEvent(events, promptAdmittedEvent, 'peer_prompt_admitted');
        await rpc(sPort, desktopHeaders(), 'turn.cancel', { thread_id: threadId }, 23);
        await sleep(700);
        ws.close();
        assert.ok(
          !events.some((event) => event.type === 'cancelled'),
          'must not invent cancelled without peer terminal',
        );
      },
    );
  });

  it('lists bound vendor sessions with canonical thread ownership', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      port,
      desktopHeaders(),
      'thread.create',
      { project_root: tmp, session_id: transportSessionId, harness_adapter_id: 'command-code' },
      50,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(port, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 51);
    await runTurn(port, threadId, transportSessionId, 'bind native');
    const catalog = await rpc(port, desktopHeaders(), 'remote.catalog', {}, 52);
    const nativeId = (
      catalog.result as { sessions: { thread_id: string; harness_native_session_id?: string }[] }
    ).sessions.find((row) => row.thread_id === threadId)?.harness_native_session_id;
    assert.ok(nativeId);
    const vendor = (
      catalog.result as {
        vendor_sessions?: { session_id: string; bound?: boolean; canonical_thread_id?: string }[];
      }
    ).vendor_sessions?.find((row) => row.session_id === nativeId);
    assert.equal(vendor?.bound, true);
    assert.equal(vendor?.canonical_thread_id, threadId);
  });

  it('opens saved vendor history idempotently via harness.command_code.open', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: desktopHeaders(),
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const created = await rpc(
      port,
      desktopHeaders(),
      'thread.create',
      {
        project_root: tmp,
        session_id: transportSessionId,
        harness_adapter_id: 'command-code',
        harness_native_session_id: 'sess_fixture_preload',
      },
      60,
    );
    const threadId = (created.result as { thread_id: string }).thread_id;
    await rpc(port, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 61);
    const open1 = await rpc(
      port,
      desktopHeaders(),
      'harness.command_code.open',
      {
        thread_id: threadId,
        project_root: tmp,
        harness_native_session_id: 'sess_fixture_preload',
      },
      62,
    );
    assert.equal((open1.result as { cell_count?: number }).cell_count, 2);
    const open2 = await rpc(
      port,
      desktopHeaders(),
      'harness.command_code.open',
      {
        thread_id: threadId,
        project_root: tmp,
        harness_native_session_id: 'sess_fixture_preload',
      },
      63,
    );
    assert.equal((open2.result as { cell_count?: number }).cell_count, 2);
  });

  it('cancels a slow turn then continues on the same native session', async () => {
    await withDedicatedServer({ BABEL_COMMAND_CODE_FIXTURE_SLOW: '1' }, async (dedicated, sPort) => {
      const sess = await httpRequest(`http://127.0.0.1:${sPort}/sessions`, {
        method: 'POST',
        headers: desktopHeaders(),
        body: JSON.stringify({ projectRoot: tmp }),
      });
      const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
      const created = await rpc(
        sPort,
        desktopHeaders(),
        'thread.create',
        { project_root: tmp, session_id: transportSessionId, harness_adapter_id: 'command-code' },
        70,
      );
      const threadId = (created.result as { thread_id: string }).thread_id;
      await rpc(sPort, desktopHeaders(), 'control.acquire', { thread_id: threadId, force: false }, 71);
      void rpc(sPort, desktopHeaders(), 'turn.submit', { thread_id: threadId, message: 'slow-cancel' }, 72);
      await sleep(80);
      await rpc(sPort, desktopHeaders(), 'turn.cancel', { thread_id: threadId }, 73);
      await sleep(700);
      const after = await runTurn(sPort, threadId, transportSessionId, 'after-cancel');
      assert.equal(after.terminal?.type, 'done');
    });
  });

  it('executes a turn in an isolated workspace B child', async () => {
    const serverB = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmpB,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: false,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      commandCodeTestLaunch: { command: process.execPath, args: [PEER] },
    });
    await serverB.start(0);
    try {
      const portB = serverB.port;
      const headers = desktopHeaders();
      const sessB = await httpRequest(`http://127.0.0.1:${portB}/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectRoot: tmpB }),
      });
      const sessionB = (JSON.parse(sessB.body) as { sessionId: string }).sessionId;
      const createdB = await rpc(
        portB,
        headers,
        'thread.create',
        { project_root: tmpB, session_id: sessionB, harness_adapter_id: 'command-code' },
        30,
      );
      const threadB = (createdB.result as { thread_id: string }).thread_id;
      const turn = await runTurn(portB, threadB, sessionB, 'workspace-b');
      assert.equal(turn.terminal?.type, 'done');
    } finally {
      await serverB.stop();
    }
  });
});
