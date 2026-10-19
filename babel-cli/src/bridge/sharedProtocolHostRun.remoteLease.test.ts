import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { getRemoteSurface } from './remoteApproval.js';
import { BridgeServer } from './sessionServer.js';
import { executeSharedProtocolHostRun } from './sharedProtocolHostRun.js';

const TOKEN = 'remote-lease-fencing-token';
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

describe('shared host-run remote lease fencing', () => {
  let server: BridgeServer;
  let tmp: string;
  let configDir: string;
  let port = 0;
  let prevRuns: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-remote-lease-'));
    configDir = join(tmp, 'config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'bridge.json'), JSON.stringify({ authToken: TOKEN }), 'utf8');
    prevRuns = process.env['BABEL_RUNS_DIR'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    process.env['BABEL_CONFIG_DIR'] = configDir;
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*', 'http://localhost:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'lease-hold',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          const surface = getRemoteSurface();
          if (!surface) {
            yield { type: 'failed', error: 'no surface' };
            return;
          }
          const allowInput = {
            action: { type: 'write_file' as const, path: 'held.txt', content: 'x' },
            thread_id: surface.threadId,
            turn_id: surface.turnId,
            cwd: surface.cwd,
            ...(surface.notify ? { notify: surface.notify } : {}),
          };
          const allowed = await surface.broker.requestAllowOnce(allowInput);
          yield {
            type: allowed ? 'done' : 'failed',
            answer: allowed ? 'ok' : undefined,
            error: allowed ? undefined : 'denied',
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
    await server.start(0);
    port = server.port;
  });

  after(async () => {
    await server.stop();
    delete process.env['BABEL_CONFIG_DIR'];
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
    const cookie = st.headers['set-cookie'] ?? '';
    assert.ok(cookie);
    return cookie;
  }

  it('rejects ordinary desktop cancel and approval while remote holds the lease; emergency admin only with host token', async () => {
    const stdin = new PassThrough();
    const events: Record<string, unknown>[] = [];
    type LeaseApprovalBinding = {
      thread_id: string;
      request_id: string;
      turn_id: string;
      operation_digest: string;
      run_id: string;
    };
    let approvalBinding: LeaseApprovalBinding | null = null;
    const cookie = await pairCookie('remote lease owner');

    const runPromise = executeSharedProtocolHostRun(
      {
        port,
        projectRoot: tmp,
        task: 'hold for remote',
        runId: 'lease-run',
        desktopClientId: desktopId,
        desktopProofKey,
        stdin,
      },
      (event) => {
        events.push(event);
        if (event.type === 'approval.required' && event.item && typeof event.item === 'object') {
          const item = event.item as { approval?: LeaseApprovalBinding };
          if (item.approval) approvalBinding = item.approval;
        }
      },
    );

    const deadline = Date.now() + 20_000;
    let boundApproval: LeaseApprovalBinding | undefined;
    while (Date.now() < deadline) {
      if (approvalBinding) {
        boundApproval = approvalBinding;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!boundApproval) {
      throw new Error('approval binding never arrived');
    }
    const liveThreadId = boundApproval.thread_id;
    await httpRequest(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'control.acquire',
        params: { thread_id: liveThreadId, force: false },
      }),
    });

    stdin.write(`${JSON.stringify({ decision: 'cancel' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancelRejections = events.filter((e) => e.type === 'control.rejected');
    assert.ok(cancelRejections.length > 0, 'ordinary cancel must be rejected while remote holds lease');
    assert.equal(
      events.some((e) => e.type === 'cancelled'),
      false,
      'ordinary cancel must not report success while remote holds lease',
    );
    assert.equal(
      events.some(
        (e) => e.type === 'run_error' && String((e as { error?: string }).error).includes('Cancel'),
      ),
      false,
      'rejected cancel must not terminate the desktop task presentation',
    );

    stdin.write(
      `${JSON.stringify({ decision: 'allow_once', approval: boundApproval })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      events.filter((e) => e.type === 'control.rejected').length >= 2,
      'desktop approval must be rejected while remote holds lease',
    );

    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: 'wrong-token' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      events.some(
        (e) =>
          e.type === 'control.rejected' &&
          String((e as { error?: string }).error).includes('emergency'),
      ),
    );

    stdin.write(
      `${JSON.stringify({ decision: 'emergency_admin_stop', host_emergency_token: TOKEN })}\n`,
    );
    const code = await runPromise;
    assert.equal(code, 0);
    assert.ok(events.some((e) => e.type === 'emergency_stop'));
  });
});
