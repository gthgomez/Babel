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
        headers: options.headers,
      },
      (res: IncomingMessage) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const TOKEN = 'oc-timeout-isolation-token';
const HANG_PEER = fileURLToPath(
  new URL('../../test/fixtures/opencode-acp-prompt-hang-peer.mjs', import.meta.url),
);
const CC_PEER = fileURLToPath(
  new URL('../../test/fixtures/command-code-acp-peer.mjs', import.meta.url),
);
const OC_VERSION = fileURLToPath(
  new URL('../../test/fixtures/opencode-version.mjs', import.meta.url),
);
const CC_VERSION = fileURLToPath(
  new URL('../../test/fixtures/command-code-version.mjs', import.meta.url),
);

function desktopHeaders(desktopId: string, desktopProofKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    [DESKTOP_CLIENT_ID_HEADER]: desktopId,
    [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
    Origin: 'http://127.0.0.1',
  };
}

async function rpc(
  port: number,
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
  id: number,
): Promise<Record<string, unknown>> {
  const res = await httpRequest(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return JSON.parse(res.body) as Record<string, unknown>;
}

describe('OpenCode prompt timeout isolation (gateway subprocess)', () => {
  let tmp: string;
  let server: BridgeServer;
  let port: number;
  let prevRuns: string | undefined;
  let prevCcExecutable: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-oc-timeout-iso-'));
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    prevCcExecutable = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = CC_VERSION;
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      openCodeTestLaunch: {
        command: process.execPath,
        args: [HANG_PEER],
        env: { BABEL_OPENCODE_FIXTURE_EXIT_DELAY_MS: '150' },
      },
      openCodeTestRpcTimeoutMs: 80,
      openCodeInstallProbe: async () => ({
        state: 'verified' as const,
        executable: OC_VERSION,
        version: '1.0.0',
      }),
      commandCodeTestLaunch: { command: process.execPath, args: [CC_PEER] },
      commandCodeInstallProbe: async () => ({
        state: 'verified' as const,
        executable: CC_VERSION,
        version: '1.0.0',
      }),
    });
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await server.stop();
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    if (prevCcExecutable === undefined) delete process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    else process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = prevCcExecutable;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps an already-running Command Code child alive when OpenCode times out and dies', async () => {
    const headers = desktopHeaders(desktopId, desktopProofKey);
    const ccSess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const ccTransportSessionId = (JSON.parse(ccSess.body) as { sessionId: string }).sessionId;
    const ocSess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const ocTransportSessionId = (JSON.parse(ocSess.body) as { sessionId: string }).sessionId;

    const ccCreated = await rpc(
      port,
      headers,
      'thread.create',
      {
        project_root: tmp,
        session_id: ccTransportSessionId,
        harness_adapter_id: 'command-code',
      },
      1,
    );
    const ccThread = (ccCreated.result as { thread_id: string }).thread_id;
    await rpc(port, headers, 'control.acquire', { thread_id: ccThread, force: false }, 2);

    const ccTicket = await httpRequest(`http://127.0.0.1:${port}/ws/ticket`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: ccTransportSessionId, thread_id: ccThread }),
    });
    const ccWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=${encodeURIComponent(ccTransportSessionId)}&ticket=${encodeURIComponent((JSON.parse(ccTicket.body) as { ticket: string }).ticket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ccWs.once('open', () => resolve());
      ccWs.once('error', reject);
    });
    const ccEvents: Record<string, unknown>[] = [];
    ccWs.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { method?: string; params?: Record<string, unknown> };
      if (frame.method === 'turn.event' && frame.params?.event) {
        ccEvents.push(frame.params.event as Record<string, unknown>);
      }
    });
    await rpc(port, headers, 'turn.submit', { thread_id: ccThread, message: 'cc-before-oc-timeout' }, 3);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cc-before timeout')), 15_000);
      const check = () => {
        if (ccEvents.some((e) => e.type === 'done')) {
          clearTimeout(timer);
          resolve();
        }
      };
      ccWs.on('message', () => check());
      check();
    });
    assert.equal(ccEvents.filter((e) => e.type === 'done').length, 1);

    const ocCreated = await rpc(
      port,
      headers,
      'thread.create',
      {
        project_root: tmp,
        session_id: ocTransportSessionId,
        harness_adapter_id: 'opencode',
      },
      4,
    );
    const ocThread = (ocCreated.result as { thread_id: string }).thread_id;
    await rpc(port, headers, 'control.acquire', { thread_id: ocThread, force: false }, 5);
    const ocTicket = await httpRequest(`http://127.0.0.1:${port}/ws/ticket`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: ocTransportSessionId, thread_id: ocThread }),
    });
    const ocWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=${encodeURIComponent(ocTransportSessionId)}&ticket=${encodeURIComponent((JSON.parse(ocTicket.body) as { ticket: string }).ticket)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ocWs.once('open', () => resolve());
      ocWs.once('error', reject);
    });
    const ocEvents: Record<string, unknown>[] = [];
    ocWs.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { method?: string; params?: Record<string, unknown> };
      if (frame.method === 'turn.event' && frame.params?.event) {
        ocEvents.push(frame.params.event as Record<string, unknown>);
      }
    });
    const started = Date.now();
    await rpc(port, headers, 'turn.submit', { thread_id: ocThread, message: 'hang' }, 6);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('oc-failed timeout')), 15_000);
      const check = () => {
        if (ocEvents.some((e) => e.type === 'failed')) {
          clearTimeout(timer);
          resolve();
        }
      };
      ocWs.on('message', () => check());
      check();
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, `expected delayed child death wait, elapsed=${elapsed}`);
    assert.ok(ocEvents.some((e) => e.type === 'failed'));
    ocWs.close();

    await rpc(port, headers, 'turn.submit', { thread_id: ccThread, message: 'cc-after-oc-timeout' }, 7);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cc-after timeout')), 15_000);
      const check = () => {
        if (ccEvents.filter((e) => e.type === 'done').length >= 2) {
          clearTimeout(timer);
          resolve();
        }
      };
      ccWs.on('message', () => check());
      check();
    });
    ccWs.close();
    assert.ok(ccEvents.filter((e) => e.type === 'done').length >= 2);
  });
});
