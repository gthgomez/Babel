import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import {
  computeDesktopControllerProof,
  DESKTOP_CLIENT_ID_HEADER,
  DESKTOP_PROOF_HEADER,
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { BridgeServer } from './sessionServer.js';

const TOKEN = 'cc-native-binding-token';
const ORIGIN = 'http://127.0.0.1';
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
): Promise<{ statusCode: number; body: string }> {
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
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
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

describe('command-code native binding at thread.create', () => {
  let server: BridgeServer;
  let port = 0;
  let tmp = '';
  let rootA = '';
  let rootB = '';
  let prevRuns: string | undefined;
  let prevCliExecutable: string | undefined;
  const desktopId = mintDesktopControllerClientId();
  const desktopProofKey = mintDesktopControllerProofKey();

  function headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${TOKEN}`,
      [DESKTOP_CLIENT_ID_HEADER]: desktopId,
      [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
      Origin: ORIGIN,
    };
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'babel-cc-bind-gw-'));
    rootA = join(tmp, 'workspace-a');
    rootB = join(tmp, 'workspace-b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    prevRuns = process.env['BABEL_RUNS_DIR'];
    prevCliExecutable = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'];
    process.env['BABEL_RUNS_DIR'] = tmp;
    process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE'] = VERSION_FIXTURE;
    server = new BridgeServer({
      authToken: TOKEN,
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: false,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
    });
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
  });

  it('allows exactly one concurrent thread.create for the same canonical native binding', async () => {
    const sess = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ projectRoot: rootA }),
    });
    const transportSessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
    const nativeId = 'sess_fixture_concurrent_create';
    const params = {
      project_root: rootA,
      session_id: transportSessionId,
      harness_adapter_id: 'command-code',
      harness_native_session_id: nativeId,
    };
    const [first, second] = await Promise.all([
      rpc(port, headers(), 'thread.create', params, 501),
      rpc(port, headers(), 'thread.create', params, 502),
    ]);
    const successes = [first, second].filter((body) => Boolean(body.result));
    const failures = [first, second].filter((body) => Boolean(body.error));
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    const ownerId = (successes[0]!.result as { thread_id: string }).thread_id;
    const retry = await rpc(port, headers(), 'thread.create', params, 503);
    assert.ok(retry.error, 'third create must fail after owner exists');
    assert.notEqual((retry.error as { message?: string }).message, 'Multiple persisted');
    const catalog = await rpc(port, headers(), 'remote.catalog', {}, 504);
    const sessions = (catalog.result as { sessions: { thread_id: string; harness_native_session_id?: string }[] })
      .sessions;
    const owners = sessions.filter((row) => row.harness_native_session_id === nativeId);
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.thread_id, ownerId);
  });

  it('allows the same native id on distinct canonical project roots', async () => {
    const sessA = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ projectRoot: rootA }),
    });
    const sessB = await httpRequest(`http://127.0.0.1:${port}/sessions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ projectRoot: rootB }),
    });
    const sessionA = (JSON.parse(sessA.body) as { sessionId: string }).sessionId;
    const sessionB = (JSON.parse(sessB.body) as { sessionId: string }).sessionId;
    const nativeId = 'sess_fixture_cross_root';
    const createdA = await rpc(
      port,
      headers(),
      'thread.create',
      {
        project_root: rootA,
        session_id: sessionA,
        harness_adapter_id: 'command-code',
        harness_native_session_id: nativeId,
      },
      601,
    );
    const createdB = await rpc(
      port,
      headers(),
      'thread.create',
      {
        project_root: rootB,
        session_id: sessionB,
        harness_adapter_id: 'command-code',
        harness_native_session_id: nativeId,
      },
      602,
    );
    assert.ok(createdA.result);
    assert.ok(createdB.result);
    assert.notEqual(
      (createdA.result as { thread_id: string }).thread_id,
      (createdB.result as { thread_id: string }).thread_id,
    );
  });
});
