import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { approvalOperationFromAgentAction } from '../agent/approvalOperation.js';
import { ChatEngine } from '../agent/chatEngine.js';
import {
  computeDesktopControllerProof,
  DESKTOP_CLIENT_ID_HEADER,
  DESKTOP_PROOF_HEADER,
  mintDesktopControllerClientId,
  mintDesktopControllerProofKey,
} from './desktopControllerAuth.js';
import { mapPermissionRequest } from './sharedProtocolHostRun.js';
import { BridgeServer } from './sessionServer.js';
import {
  productionNodeCliArgv,
  resolveProductionCliEntry,
} from '../testinfra/nodeCliLaunch.js';

const HOST_RUN_TIMEOUT_MS = 45_000;

describe('sharedProtocolHostRun production contracts', () => {
  it('maps real RemoteApprovalBroker permission.request frames for Desktop run_id binding', () => {
    const runId = 'desktop-run-abc';
    const threadId = 'thr_test_1';
    const operation = approvalOperationFromAgentAction(
      { type: 'write_file', path: 'x.ts', content: 'ok' },
      { thread_id: threadId, turn_id: 'turn-1', cwd: '/tmp' },
    );
    const params = {
      thread_id: threadId,
      turn_id: 'turn-1',
      approval_id: 'appr-001',
      permission: operation.action_type,
      reason: 'Remote consequential action requires ALLOW_ONCE or DENY',
      action_type: operation.action_type,
      command: operation.command,
      cwd: operation.canonical_cwd,
      target_path: operation.target_path,
      operation_digest: 'a'.repeat(64),
      allowed_decisions: ['allow_once', 'deny'],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const mapped = mapPermissionRequest(params, runId);
    assert.ok(mapped);
    const item = mapped!.item as { approval: Record<string, unknown> };
    assert.equal(item.approval.run_id, runId);
    assert.equal(item.approval.request_id, 'appr-001');
    assert.equal(item.approval.operation_digest, params.operation_digest);
  });

  it('rejects turn.cancel without control_epoch for desktop_controller clients', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-host-run-cancel-epoch-'));
    const desktopId = mintDesktopControllerClientId();
    const desktopProofKey = mintDesktopControllerProofKey();
    const server = new BridgeServer({
      authToken: 'cancel-epoch-token',
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) =>
        new ChatEngine({
          task: 'cancel',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        }),
    });
    await server.start(0);
    const port = server.port;
    try {
      const headers = {
        [DESKTOP_CLIENT_ID_HEADER]: desktopId,
        [DESKTOP_PROOF_HEADER]: computeDesktopControllerProof(desktopProofKey, desktopId),
      };
      const sess = await httpPost(`http://127.0.0.1:${port}/sessions`, headers, {
        projectRoot: tmp,
      });
      const sessionId = (JSON.parse(sess.body) as { sessionId: string }).sessionId;
      const created = await httpPost(`http://127.0.0.1:${port}/rpc`, headers, {
        jsonrpc: '2.0',
        id: 1,
        method: 'thread.create',
        params: { project_root: tmp, session_id: sessionId },
      });
      const threadId = (JSON.parse(created.body) as { result: { thread_id: string } }).result
        .thread_id;
      const acquired = await httpPost(`http://127.0.0.1:${port}/rpc`, headers, {
        jsonrpc: '2.0',
        id: 2,
        method: 'control.acquire',
        params: { thread_id: threadId, force: false },
      });
      const epoch = (JSON.parse(acquired.body) as { result: { epoch: number } }).result.epoch;
      const denied = await httpPost(`http://127.0.0.1:${port}/rpc`, headers, {
        jsonrpc: '2.0',
        id: 3,
        method: 'turn.cancel',
        params: { thread_id: threadId },
      });
      const deniedBody = JSON.parse(denied.body) as {
        error?: { data?: { control_error?: string } };
      };
      assert.equal(deniedBody.error?.data?.control_error, 'epoch_required');
      const fenced = await httpPost(`http://127.0.0.1:${port}/rpc`, headers, {
        jsonrpc: '2.0',
        id: 4,
        method: 'turn.submit',
        params: {
          thread_id: threadId,
          message: 'hold',
          control_epoch: epoch,
          command_id: 'fenced-cancel-probe',
        },
      });
      assert.ok(!JSON.parse(fenced.body).error, fenced.body);
      const accepted = await httpPost(`http://127.0.0.1:${port}/rpc`, headers, {
        jsonrpc: '2.0',
        id: 5,
        method: 'turn.cancel',
        params: { thread_id: threadId, control_epoch: epoch },
      });
      const acceptedBody = JSON.parse(accepted.body) as { error?: unknown };
      assert.ok(!acceptedBody.error, `expected fenced cancel to succeed: ${accepted.body}`);
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('production launcher host-run child exits and supports a second turn', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'babel-host-run-child-exit-'));
    const desktopId = mintDesktopControllerClientId();
    const desktopProofKey = mintDesktopControllerProofKey();
    const server = new BridgeServer({
      authToken: 'child-exit-token',
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          task: 'child-exit',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
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
    await server.start(0);
    const port = server.port;
    const entry = resolveProductionCliEntry();
    try {
      const first = await spawnHostRunChild(entry, tmp, port, desktopId, desktopProofKey, 'run-a');
      assert.equal(first.code, 0, first.stderr);
      assert.ok(first.threadId, first.stdout);
      const second = await spawnHostRunChild(
        entry,
        tmp,
        port,
        desktopId,
        desktopProofKey,
        'run-b',
        first.threadId,
      );
      assert.equal(second.code, 0, second.stderr);
    } finally {
      await server.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function httpPost(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res: IncomingMessage) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function spawnHostRunChild(
  entry: string,
  projectRoot: string,
  port: number,
  desktopClientId: string,
  desktopProofKey: string,
  runId: string,
  resumeThread?: string,
): Promise<{ code: number | null; threadId?: string; stdout: string; stderr: string }> {
  const cliArgs = [
    'remote',
    'host-run',
    '--project-root',
    projectRoot,
    '--run-id',
    runId,
  ];
  if (resumeThread) cliArgs.push('--resume-thread', resumeThread);
  cliArgs.push('--', 'hello shared child');

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      productionNodeCliArgv(entry, cliArgs),
      {
        env: {
          ...process.env,
          BABEL_BRIDGE_PORT: String(port),
          BABEL_BRIDGE_DESKTOP_CLIENT_ID: desktopClientId,
          BABEL_BRIDGE_DESKTOP_PROOF_KEY: desktopProofKey,
          BABEL_RUNS_DIR: projectRoot,
          CI: '1',
          BABEL_SKIP_KG_INDEX: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`host-run child timed out after ${HOST_RUN_TIMEOUT_MS}ms`));
    }, HOST_RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const complete = stdout
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; result?: { session_id?: string } };
          } catch {
            return null;
          }
        })
        .find((event) => event?.type === 'run_complete');
      const out: { code: number | null; threadId?: string; stdout: string; stderr: string } = {
        code,
        stdout,
        stderr,
      };
      if (complete?.result?.session_id) out.threadId = complete.result.session_id;
      resolve(out);
    });
  });
}
