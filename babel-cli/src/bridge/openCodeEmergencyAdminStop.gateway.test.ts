/**
 * Qualifies production host-run `emergency_admin_stop` against real OpenCode + Command Code
 * subprocess children. Emergency scope is thread-local: `control.acquire` (force) + `turn.cancel`
 * on the active host-run thread only (`sharedProtocolHostRun.ts` → `emergencyAdminStopTurn`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
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
import { HttpProtocolClient } from './httpProtocolClient.js';
import { BridgeServer } from './sessionServer.js';
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'oc-emergency-admin-stop-token';
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

function destroyStdin(stdin: PassThrough): void {
  try {
    stdin.end();
  } catch {
    /* ignore */
  }
  try {
    stdin.destroy();
  } catch {
    /* ignore */
  }
}

/** Clears interval + timeout on success, timeout rejection, or companion promise settlement. */
function waitUntil(
  predicate: () => boolean,
  options: {
    intervalMs?: number;
    timeoutMs: number;
    label: string;
    companion?: Promise<unknown>;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const dispose = (): void => {
      clearTimeout(timer);
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      dispose();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`${options.label} timeout`)));
    }, options.timeoutMs);
    const check = (): void => {
      if (predicate()) {
        finish(() => resolve());
      }
    };
    interval = setInterval(check, options.intervalMs ?? 25);
    check();
    if (options.companion) {
      void options.companion.finally(() => {
        if (!settled) {
          finish(() =>
            reject(new Error(`${options.label} aborted before predicate became true`)),
          );
        }
      });
    }
  });
}

async function raceWithWatchdog<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(label)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

describe('OpenCode host emergency_admin_stop (gateway subprocess)', { concurrency: 1 }, () => {
  let tmp: string;
  let configDir: string;
  let server: BridgeServer;
  let port: number;
  let prevConfigDir: string | undefined;
  let prevRuns: string | undefined;
  let prevCcExecutable: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-oc-emergency-admin-'));
    configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
    prevConfigDir = process.env['BABEL_CONFIG_DIR'];
    prevRuns = process.env['BABEL_RUNS_DIR'];
    prevCcExecutable = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    process.env['BABEL_CONFIG_DIR'] = configDir;
    process.env['BABEL_RUNS_DIR'] = tmp;
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
        env: { BABEL_OPENCODE_FIXTURE_CANCEL_SETTLE_DELAY_MS: '350' },
      },
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
    try {
      await server.stop();
    } catch {
      /* ignore — primary stop runs at end of the it() */
    }
    if (prevConfigDir === undefined) delete process.env['BABEL_CONFIG_DIR'];
    else process.env['BABEL_CONFIG_DIR'] = prevConfigDir;
    if (prevRuns === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prevRuns;
    if (prevCcExecutable === undefined) delete process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    else process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = prevCcExecutable;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('acks emergency on the host-run OpenCode thread while Command Code survives', async () => {
    let ccWs: WebSocket | undefined;
    let ocWs: WebSocket | undefined;
    const headers = desktopHeaders(desktopId, desktopProofKey);
    const client = new HttpProtocolClient({
      baseUrl: `http://127.0.0.1:${port}`,
      desktopClientId: desktopId,
      desktopProofKey,
    });

    const ccSess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectRoot: tmp }),
    });
    const ccTransportSessionId = (JSON.parse(ccSess.body) as { sessionId: string }).sessionId;
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
    ccWs = new WebSocket(
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
    await rpc(port, headers, 'turn.submit', { thread_id: ccThread, message: 'cc-before-emergency' }, 3);
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

    const stdin = new PassThrough();
    const hostEvents: Record<string, unknown>[] = [];
    let emergencyAckAt: number | undefined;
    let cancelledAt: number | undefined;
    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'hang for emergency',
        runId: 'oc-emergency-host-run',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
        harnessAdapterId: 'opencode',
      },
      (event) => {
        hostEvents.push(event);
        if (event.type === 'emergency_stop' && emergencyAckAt === undefined) {
          emergencyAckAt = Date.now();
        }
        if (event.type === 'cancelled' && cancelledAt === undefined) {
          cancelledAt = Date.now();
        }
      },
    );

    await waitUntil(() => hostEvents.some((e) => e.type === 'thought'), {
      intervalMs: 25,
      timeoutMs: 15_000,
      label: 'host-run thought',
      companion: runPromise,
    });

    const catalogActive = await client.call<
      'remote.catalog',
      Record<string, never>,
      { sessions: Array<{ thread_id: string; active_turn: boolean }> }
    >('remote.catalog', {});
    const ocThread =
      catalogActive.sessions.find((row) => row.active_turn)?.thread_id ??
      catalogActive.sessions.at(-1)?.thread_id;
    assert.ok(ocThread, 'expected active OpenCode host-run thread in catalog');

    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );

    await waitUntil(() => hostEvents.some((e) => e.type === 'emergency_stop'), {
      intervalMs: 15,
      timeoutMs: 15_000,
      label: 'emergency_stop ack',
    });

    let sawAdmissionDenial = false;
    const denialDeadline = Date.now() + 600;
    while (Date.now() < denialDeadline) {
      const attempt = await rpc(
        port,
        headers,
        'turn.submit',
        { thread_id: ocThread, message: 'must-not-admit-during-emergency' },
        40,
      );
      if (attempt.error && (attempt.error as { code?: number }).code === -32001) {
        sawAdmissionDenial = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(sawAdmissionDenial, 'turn.submit must be denied while prior launch is settling');

    const code = await raceWithWatchdog(
      runPromise,
      25_000,
      `host-run hung; events=${JSON.stringify(hostEvents.map((e) => e.type))}`,
    );

    assert.ok(emergencyAckAt !== undefined && cancelledAt !== undefined);
    assert.ok(
      cancelledAt! >= emergencyAckAt!,
      'authoritative cancelled terminal must follow emergency_stop ack',
    );
    assert.equal(code, 0);
    assert.equal(hostEvents.filter((e) => e.type === 'emergency_stop').length, 1);
    assert.equal(hostEvents.filter((e) => e.type === 'cancelled').length, 1);
    assert.equal(hostEvents.some((e) => e.type === 'run_error'), false);

    const catalogAfter = await client.call<
      'remote.catalog',
      Record<string, never>,
      {
        sessions: Array<{
          thread_id: string;
          active_turn: boolean;
          active_turn_id?: number;
          owned_by_bridge_session?: string;
        }>;
      }
    >('remote.catalog', {});
    const ocRow = catalogAfter.sessions.find((row) => row.thread_id === ocThread);
    assert.ok(ocRow);
    assert.equal(ocRow.active_turn, false);
    assert.ok(ocRow.owned_by_bridge_session, 'expected bridge session owner for OpenCode thread');
    const turnId = ocRow.active_turn_id ?? 1;
    const history = await client.call<
      'history.lookup',
      { thread_id: string; turn_id: number; limit: number },
      { turn_terminal?: { turn_id: number; event_type: string } | null }
    >('history.lookup', { thread_id: ocThread, turn_id: turnId, limit: 50 });
    assert.equal(history.turn_terminal?.event_type, 'cancelled');

    await rpc(port, headers, 'turn.submit', { thread_id: ccThread, message: 'cc-after-emergency' }, 50);
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

    const ocTransportSessionId = ocRow.owned_by_bridge_session!;
    const ocTicketRes = await httpRequest(`http://127.0.0.1:${port}/ws/ticket`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: ocTransportSessionId, thread_id: ocThread }),
    });
    ocWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?sessionId=${encodeURIComponent(ocTransportSessionId)}&ticket=${encodeURIComponent((JSON.parse(ocTicketRes.body) as { ticket: string }).ticket)}`,
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
    await rpc(port, headers, 'control.acquire', { thread_id: ocThread, force: false }, 61);
    await rpc(port, headers, 'turn.submit', { thread_id: ocThread, message: 'oc-admits-after-settlement' }, 62);
    await rpc(port, headers, 'turn.cancel', { thread_id: ocThread }, 63);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('oc-admission-after-settlement timeout')), 15_000);
      const check = () => {
        if (ocEvents.some((e) => e.type === 'cancelled')) {
          clearTimeout(timer);
          resolve();
        }
      };
      ocWs.on('message', () => check());
      check();
    });
    ocWs.close();

    destroyStdin(stdin);
    try {
      ccWs?.terminate();
    } catch {
      /* ignore */
    }
    try {
      ocWs?.terminate();
    } catch {
      /* ignore */
    }
    await server.stop();
  });
});
