/**
 * Mirrors Electron IPC → RemoteBridgeChild → SharedProtocolRun → shim → dist host-run
 * without Playwright. Bounded stage traces identify the first missing transition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { RemoteBridgeChild } from '../native/remoteHost.mjs';
import { SharedProtocolRun } from '../native/sharedProtocolRun.mjs';
import { saveProviderRoute, qualifiedProviders, readProviderRoute } from '../native/provider-routing.mjs';
import { productionNodeCliArgv } from '../native/cli-launch.mjs';
import { nodeChildSpawnEnvironment } from '../native/spawn-env-floor.mjs';
import { rmTempDirWithOwnedChildDrain } from './temp-dir-cleanup.mjs';

const babelCliDist = resolve(
  fileURLToPath(new URL('../../babel-cli/dist/index.js', import.meta.url)),
);
const desktopCliShimRuntime = fileURLToPath(
  new URL('./desktop-cli-shim-runtime.mjs', import.meta.url),
);

async function assertLoopbackPortClosed(port, label) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (response.ok) {
      throw new Error(`${label}: loopback port ${port} still serves /health after bridge stop`);
    }
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code ?? error.cause?.code : undefined;
    if (error?.name === 'AbortError' || code === 'ECONNREFUSED') return;
    throw error;
  }
}

function assertPidNotAlive(pid, label) {
  if (pid == null) return;
  try {
    process.kill(pid, 0);
    throw new Error(`${label}: owned pid ${pid} still alive after bridge stop`);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return;
    if (error?.message?.includes('still alive')) throw error;
  }
}

const STAGE_BUDGET_MS = {
  'fixture-setup': 5_000,
  'bridge-ready': 25_000,
  'child-spawn': 3_000,
  'terminal-event': 22_000,
  'child-exit': 8_000,
  'bridge-stop': 8_000,
  'bridge-port-closed': 3_000,
  'temp-cleanup': 6_000,
};

function emitStackTrace(stage, detail = {}) {
  console.error(
    `[shared-protocol-stack-trace] ${JSON.stringify({
      stage,
      ts: Date.now(),
      ...detail,
    })}`,
  );
}

function failStage(stage, message) {
  const text = typeof message === 'string' ? message : message instanceof Error ? message.message : String(message);
  emitStackTrace(`${stage}:fail`, { error: text });
  throw new Error(`[shared-protocol-stack] stage=${stage} ${text}`);
}

async function bounded(promise, stage) {
  const ms = STAGE_BUDGET_MS[stage] ?? 10_000;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } catch (error) {
    failStage(stage, error);
  }
}

async function runTurn({
  bridge,
  entry,
  projectRoot,
  config,
  runsDir,
  runId,
  task,
  sessionId,
}) {
  const route = readProviderRoute(config);
  const models = qualifiedProviders(config).find((p) => p.id === route.provider)?.routes ?? [];
  const selectedModel = models.find((m) => m.id === route.model && m.enabled !== false);
  assert.ok(selectedModel, 'selected model must be qualified');

  const request = {
    runId,
    task,
    mode: 'chat',
    provider: route.provider,
    model: selectedModel.modelId,
    ...(sessionId ? { sessionId } : {}),
  };
  emitStackTrace('host-run-request', { runId, argv: productionNodeCliArgv(entry, ['remote', 'host-run']) });

  const events = [];
  const run = new SharedProtocolRun({
    executable: process.execPath,
    entry,
    projectRoot,
    port: bridge.port,
    desktopClientId: bridge.desktopClientId,
    desktopProofKey: bridge.desktopProofKey,
    env: nodeChildSpawnEnvironment({
      BABEL_CONFIG_DIR: config,
      BABEL_RUNS_DIR: runsDir,
      ELECTRON_RUN_AS_NODE: '1',
    }),
    inheritEnv: false,
  });

  let spawned = false;
  const outcome = await bounded(
    new Promise((resolvePromise, reject) => {
      run.start(request, (packet) => {
        events.push(packet);
        if (!spawned && packet.kind === 'event') {
          spawned = true;
          emitStackTrace('child-spawn', { runId });
        }
        if (packet.kind === 'event' && packet.event?.type === 'run_complete') {
          emitStackTrace('terminal-event', { runId, type: 'run_complete' });
          resolvePromise({ result: packet.event.result, events });
        }
        if (packet.kind === 'event' && packet.event?.type === 'run_error') {
          reject(new Error(String(packet.event.error ?? 'run_error')));
        }
        if (packet.kind === 'exit' && packet.code !== 0) {
          reject(new Error(`host-run child exit code ${packet.code}`));
        }
        if (packet.kind === 'transport-error') {
          reject(new Error(`transport-error: ${packet.error}`));
        }
      });
    }),
    'terminal-event',
  );

  if (!spawned) {
    failStage('child-spawn', `no host-run events for ${runId}`);
  }

  const exitInfo = await bounded(run.disposeOwnedChild(STAGE_BUDGET_MS['child-exit']), 'child-exit');
  emitStackTrace('child-exit', { runId, forced: exitInfo.forced });
  return outcome;
}

test('desktop stack reaches run_complete through shim and shared bridge (no Electron UI)', {
  skip: !existsSync(babelCliDist) ? 'missing babel-cli dist' : false,
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shared-protocol-stack-'));
  const completedStages = [];
  const mark = (stage, detail = {}) => {
    completedStages.push(stage);
    emitStackTrace(stage, detail);
  };

  try {
    await bounded(
      (async () => {
        const project = join(root, 'project');
        const config = join(root, 'config');
        const runsDir = join(root, 'runs');
        const entry = join(root, 'shim.mjs');
        const receipt = join(root, 'receipt.jsonl');
        await mkdir(project);
        await mkdir(config, { recursive: true });
        await mkdir(runsDir, { recursive: true });
        await writeFile(join(project, 'README.md'), '# stack');
        await writeFile(
          entry,
          `import { runDesktopCliShim } from ${JSON.stringify(desktopCliShimRuntime)};
runDesktopCliShim({
  dist: ${JSON.stringify(babelCliDist)},
  argv: process.argv.slice(2),
  hostRunReceipt: ${JSON.stringify(receipt)},
});
`,
        );
        saveProviderRoute({
          configDirectory: config,
          provider: 'openrouter',
          model: 'deepseek-v4-pro-openrouter',
        });
        return { project, config, runsDir, entry, receipt };
      })(),
      'fixture-setup',
    );
    mark('fixture-setup', { root });

    const project = join(root, 'project');
    const config = join(root, 'config');
    const runsDir = join(root, 'runs');
    const entry = join(root, 'shim.mjs');
    const receipt = join(root, 'receipt.jsonl');

    const bridge = new RemoteBridgeChild({
      executable: process.execPath,
      entry,
      projectRoot: project,
      env: nodeChildSpawnEnvironment({
        BABEL_CONFIG_DIR: config,
        BABEL_RUNS_DIR: runsDir,
        ELECTRON_RUN_AS_NODE: '1',
      }),
      inheritEnv: false,
    });

    const port = 4700 + Math.floor(Math.random() * 200);
    await bounded(bridge.start({ port, sharedSession: true }), 'bridge-ready');
    assert.equal(bridge.state, 'ready');
    mark('bridge-ready', { port: bridge.port });

    const first = await runTurn({
      bridge,
      entry,
      projectRoot: project,
      config,
      runsDir,
      runId: 'stack-1',
      task: 'stack turn one',
    });
    assert.equal(typeof first.result?.session_id, 'string');
    assert.equal(first.result?.fixture_execution, true);
    assert.equal(first.result?.terminal_outcome, 'UNVERIFIED_PATCH');

    const second = await runTurn({
      bridge,
      entry,
      projectRoot: project,
      config,
      runsDir,
      runId: 'stack-2',
      task: 'stack turn two',
      sessionId: first.result.session_id,
    });
    assert.equal(second.result?.session_id, first.result.session_id);
    assert.equal(second.result?.fixture_execution, true);
    assert.equal(second.result?.terminal_outcome, 'UNVERIFIED_PATCH');

    const receiptText = await readFile(receipt, 'utf8');
    assert.ok(receiptText.includes('host-run'));

    const bridgeListenPort = bridge.port;
    bridge.stop();
    const bridgeExit = await bounded(
      bridge.waitForOwnedChildExit(STAGE_BUDGET_MS['bridge-stop']),
      'bridge-stop',
    );
    assert.equal(bridge.state, 'stopped', 'owned bridge must reach stopped after child exit');
    assert.equal(bridge.port, null, 'owned bridge must release port after child exit');
    assertPidNotAlive(bridgeExit.pid, 'bridge-stop');
    if (bridgeListenPort != null) {
      await bounded(assertLoopbackPortClosed(bridgeListenPort, 'bridge-stop'), 'bridge-port-closed');
      mark('bridge-port-closed', { port: bridgeListenPort });
    }
    mark('bridge-stop', {
      pid: bridgeExit.pid,
      exitCode: bridgeExit.exitCode,
      signal: bridgeExit.signal,
    });
  } catch (error) {
    emitStackTrace('fixture:error', {
      error: error instanceof Error ? error.message : String(error),
      completedStages,
    });
    throw error;
  } finally {
    await bounded(
      rmTempDirWithOwnedChildDrain(root, {
        attempts: 5,
        baseDelayMs: 150,
        onRetry: (detail) => emitStackTrace('temp-cleanup-retry', detail),
      }),
      'temp-cleanup',
    );
    mark('temp-cleanup', { root });
  }
});
