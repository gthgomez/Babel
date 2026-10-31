import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const babelRoot = resolve(packageRoot, '..', 'babel-cli');
const importFromBabelDist = (relativePath) =>
  import(pathToFileURL(join(babelRoot, 'dist', relativePath)).href);

test('SharedProtocolRun reply accepts broker-shaped approval after host-run NDJSON', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shared-protocol-run-'));
  let server;
  try {
    const { ChatEngine } = await importFromBabelDist('agent/chatEngine.js');
    const {
      mintDesktopControllerClientId,
      mintDesktopControllerProofKey,
    } = await importFromBabelDist('bridge/desktopControllerAuth.js');
    const { getRemoteSurface } = await importFromBabelDist('bridge/remoteApproval.js');
    const { BridgeServer } = await importFromBabelDist('bridge/sessionServer.js');
    const { SharedProtocolRun } = await import('../native/sharedProtocolRun.mjs');
    const entry = join(babelRoot, 'dist', 'index.js');

    const tmp = root;
    const desktopId = mintDesktopControllerClientId();
    const desktopProofKey = mintDesktopControllerProofKey();
    server = new BridgeServer({
      authToken: 'shared-run-approval-token',
      allowedWorkspaceRoot: tmp,
      allowedOrigins: ['http://127.0.0.1:*'],
      enforceControlLease: true,
      desktopControllerClientId: desktopId,
      desktopControllerProofKey: desktopProofKey,
      engineFactory: (descriptor) => {
        const engine = new ChatEngine({
          inferenceOwner: 'external-harness',
          task: 'shared-run-approval',
          projectRoot: descriptor.projectRoot,
          executionProfile: 'chat',
        });
        engine.submitMessageStream = async function* () {
          const surface = getRemoteSurface();
          if (!surface) {
            yield { type: 'failed', error: 'no surface' };
            return;
          }
          const allowed = await surface.broker.requestAllowOnce({
            action: { type: 'write_file', path: 'via-desktop.txt', content: 'x' },
            thread_id: surface.threadId,
            turn_id: surface.turnId,
            cwd: surface.cwd,
            notify: surface.notify,
          });
          yield {
            type: allowed ? 'done' : 'failed',
            answer: allowed ? 'ok' : undefined,
            usage: {
              totalCostUSD: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalTokens: 0,
              modelBreakdown: {},
            },
          };
        };
        return engine;
      },
    });
    await server.start(0);
    const runner = new SharedProtocolRun({
      executable: process.execPath,
      entry,
      projectRoot: tmp,
      port: server.port,
      desktopClientId: desktopId,
      desktopProofKey,
      env: { BABEL_RUNS_DIR: tmp, CI: '1', BABEL_SKIP_KG_INDEX: '1' },
      inheritEnv: false,
    });

    const packets = [];
    const exitPromise = new Promise((resolve) => {
      runner.start(
        { runId: 'desktop-decide-1', mode: 'chat', task: 'need approval' },
        (packet) => {
          packets.push(packet);
          if (packet.kind === 'event' && packet.event?.type === 'approval.required') {
            const accepted = runner.reply({
              runId: 'desktop-decide-1',
              decision: 'allow_once',
              approval: packet.event.item?.approval,
            });
            assert.equal(accepted, true);
          }
          if (packet.kind === 'exit') resolve(packet);
        },
      );
    });

    const exit = await Promise.race([
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SharedProtocolRun timed out')), 45_000),
      ),
    ]);
    assert.equal(exit.code, 0);
    assert.ok(
      packets.some((p) => p.kind === 'event' && p.event?.type === 'run_complete'),
      'expected run_complete after babel:decide equivalent reply',
    );
  } finally {
    if (server) await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
