/**
 * Mirrors Electron IPC → RemoteBridgeChild → SharedProtocolRun → shim → dist host-run
 * without Playwright. Fails fast with traced stages.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { RemoteBridgeChild } from '../native/remoteHost.mjs';
import { SharedProtocolRun } from '../native/sharedProtocolRun.mjs';
import { saveProviderRoute, qualifiedProviders, readProviderRoute } from '../native/provider-routing.mjs';
import { productionNodeCliArgv } from '../native/cli-launch.mjs';

const babelCliDist = resolve(
  fileURLToPath(new URL('../../babel-cli/dist/index.js', import.meta.url)),
);

const TRACE = process.env.BABEL_TEST_TRACE_SHARED_PROTOCOL === '1';

function trace(stage, detail) {
  if (TRACE) console.error(`[shared-protocol-stack] ${stage}:`, detail);
}

async function runTurn({ bridge, entry, projectRoot, config, runId, task, sessionId }) {
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
  trace('host-run-request', request);
  trace('host-run-argv', productionNodeCliArgv(entry, ['remote', 'host-run', '--project-root', projectRoot, '--run-id', runId, '--model', request.model, '--provider', request.provider, '--', task]));

  const events = [];
  const run = new SharedProtocolRun({
    executable: process.execPath,
    entry,
    projectRoot,
    port: bridge.port,
    desktopClientId: bridge.desktopClientId,
    desktopProofKey: bridge.desktopProofKey,
    env: {
      BABEL_CONFIG_DIR: config,
      ELECTRON_RUN_AS_NODE: '1',
    },
    inheritEnv: false,
  });

  return await new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => {
      reject(
        new Error(
          `turn ${runId} timed out; events=${JSON.stringify(events.map((e) => ({ kind: e.kind, type: e.event?.type, code: e.code })))}`,
        ),
      );
    }, 20_000);

    run.start(request, (packet) => {
      events.push(packet);
      trace('packet', packet);
      if (packet.kind === 'event' && packet.event?.type === 'run_complete') {
        clearTimeout(deadline);
        resolvePromise({ result: packet.event.result, events });
      }
      if (packet.kind === 'event' && packet.event?.type === 'run_error') {
        clearTimeout(deadline);
        reject(new Error(String(packet.event.error ?? 'run_error')));
      }
      if (packet.kind === 'exit' && packet.code !== 0) {
        clearTimeout(deadline);
        reject(new Error(`host-run child exit code ${packet.code}`));
      }
      if (packet.kind === 'transport-error') {
        clearTimeout(deadline);
        reject(new Error(`transport-error: ${packet.error}`));
      }
    });
  });
}

test('desktop stack reaches run_complete through shim and shared bridge (no Electron UI)', {
  skip: !existsSync(babelCliDist) ? 'missing babel-cli dist' : false,
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shared-protocol-stack-'));
  try {
    const project = join(root, 'project');
    const config = join(root, 'config');
    const entry = join(root, 'shim.mjs');
    const receipt = join(root, 'receipt.jsonl');
    await mkdir(project);
    await mkdir(config, { recursive: true });
    await writeFile(join(project, 'README.md'), '# stack');
    await writeFile(
      entry,
      `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const dist = ${JSON.stringify(babelCliDist)};
const receipt = ${JSON.stringify(receipt)};
const argv = process.argv.slice(2);
let argvToRun = [...argv];
const remoteIdx = argvToRun.indexOf('remote');
let remoteSub = remoteIdx >= 0 ? argvToRun[remoteIdx + 1] : '';
if (remoteIdx >= 0 && remoteSub === 'serve') {
  argvToRun[remoteIdx + 1] = 'acceptance-bridge';
  remoteSub = 'acceptance-bridge';
}
if (remoteIdx >= 0 && (remoteSub === 'serve' || remoteSub === 'acceptance-bridge' || remoteSub === 'host-run')) {
  appendFileSync(receipt, remoteSub + '\\n');
  const childEnv = { ...process.env };
  if (remoteSub === 'acceptance-bridge') childEnv.BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE = '1';
  const child = spawn(process.execPath, ['--experimental-wasm-modules', dist, ...argvToRun], {
    cwd: process.cwd(),
    stdio: remoteSub === 'host-run' ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    env: childEnv,
  });
  if (remoteSub === 'host-run') {
    child.stdout?.on('data', (c) => process.stdout.write(c));
    child.stderr?.on('data', (c) => process.stderr.write(c));
    if (child.stdin) process.stdin.pipe(child.stdin);
  } else {
    child.stderr?.on('data', (c) => process.stderr.write(c));
  }
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else process.exit(2);
`,
    );

    saveProviderRoute({
      configDirectory: config,
      provider: 'openrouter',
      model: 'deepseek-v4-pro-openrouter',
    });

    const bridge = new RemoteBridgeChild({
      executable: process.execPath,
      entry,
      projectRoot: project,
      env: {
        BABEL_CONFIG_DIR: config,
        ELECTRON_RUN_AS_NODE: '1',
      },
      inheritEnv: false,
    });

    const port = 4700 + Math.floor(Math.random() * 200);
    trace('bridge-start', { port });
    await bridge.start({ port, sharedSession: true });
    assert.equal(bridge.state, 'ready');
    trace('bridge-ready', { port: bridge.port, desktopClientId: bridge.desktopClientId });

    const first = await runTurn({
      bridge,
      entry,
      projectRoot: project,
      config,
      runId: 'stack-1',
      task: 'stack turn one',
    });
    assert.equal(typeof first.result?.session_id, 'string');

    const second = await runTurn({
      bridge,
      entry,
      projectRoot: project,
      config,
      runId: 'stack-2',
      task: 'stack turn two',
      sessionId: first.result.session_id,
    });
    assert.equal(second.result?.session_id, first.result.session_id);

    const receiptText = await readFile(receipt, 'utf8');
    assert.ok(receiptText.includes('host-run'));
    bridge.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
