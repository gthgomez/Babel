// Production shared-session path: Electron IPC → SharedProtocolRun → `babel remote host-run` (not `babel run`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { _electron } from 'playwright';
import { saveProviderRoute } from '../native/provider-routing.mjs';
import { parseSharedSessionTrace } from './shared-session-electron-trace.mjs';
import {
  EVAL_GET_REMOTE_BRIDGE,
  EVAL_RUN_SHARED_TURN,
  EVAL_START_REMOTE_BRIDGE,
  EVAL_TRUST_PROJECT,
} from './shared-session-electron-ipc.mjs';

const babelCliDist = resolve(
  fileURLToPath(new URL('../../babel-cli/dist/index.js', import.meta.url)),
);
const desktopDistHtml = resolve(
  fileURLToPath(new URL('../dist/index.html', import.meta.url)),
);

function resolveElectronExecutable() {
  if (process.env.BABEL_TEST_ELECTRON_EXECUTABLE) return process.env.BABEL_TEST_ELECTRON_EXECUTABLE;
  const bundled = resolve(
    fileURLToPath(new URL('..', import.meta.url)),
    'node_modules',
    'electron',
    'dist',
    'electron',
  );
  return existsSync(bundled) ? bundled : null;
}

const electronExecutable = resolveElectronExecutable();

function emitParentTrace(stage, detail = {}) {
  console.error(
    `[shared-session-parent-trace] ${JSON.stringify({
      stage,
      ts: Date.now(),
      display: process.env.DISPLAY ?? null,
      platform: process.platform,
      ...detail,
    })}`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function buildLifecycleStyleEnv(profileDir) {
  const env = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'HOME',
    'COMSPEC',
    'PATHEXT',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.BABEL_RUNS_DIR = join(profileDir, 'engine', 'state', 'runs');
  env.BABEL_TEST_SHARED_SESSION_TRACE = '1';
  env.ELECTRON_NO_SANDBOX = '1';
  return env;
}

async function runSharedTurnWithAdmissionRetry(page, payload, label, failStageFn) {
  let lastError = 'unknown';
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      return await bounded(page.evaluate(EVAL_RUN_SHARED_TURN, payload), 60_000, label);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!/Wait for the current Babel run/.test(lastError)) throw error;
      await sleep(200);
    }
  }
  failStageFn(label, `runner admission still busy after retries: ${lastError}`);
}

async function shutdownElectronApplication(application) {
  if (!application) return;
  await bounded(
    application.evaluate(({ app }) => {
      app.exit(0);
    }),
    3_000,
    'cleanup:app.exit',
  ).catch(() => {});
  await bounded(application.close(), 5_000, 'cleanup:application.close').catch(() => {});
}

test('shared-session Electron run uses host-run child and preserves thread across two turns', {
  skip: !electronExecutable
    ? 'missing Electron binary: run npm install in babel-desktop or set BABEL_TEST_ELECTRON_EXECUTABLE'
    : !existsSync(babelCliDist)
      ? 'missing babel-cli dist/index.js: run npm run build in babel-cli'
      : !existsSync(desktopDistHtml)
        ? 'missing babel-desktop dist/index.html: run npm run build in babel-desktop'
        : false,
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shared-session-electron-'));
  let application;
  const traceStages = [];
  const completedStages = [];

  const failStage = (stage, evidence) => {
    assert.fail(
      `Electron shared-session stalled at stage "${stage}"; completed=${JSON.stringify(completedStages)}; trace=${JSON.stringify(traceStages.map((s) => s.stage))}; evidence=${evidence}`,
    );
  };

  const markStage = (stage, detail = {}) => {
    completedStages.push(stage);
    emitParentTrace(stage, detail);
  };

  const waitTraceStage = async (stage, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (traceStages.some((entry) => entry.stage === stage)) return;
      await sleep(40);
    }
    failStage(`trace:${stage}`, `missing main-process trace stage within ${timeoutMs}ms`);
  };

  const waitTraceMatch = async (predicate, label, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(50);
    }
    failStage(label, `trace evidence missing within ${timeoutMs}ms; trace=${JSON.stringify(traceStages)}`);
  };

  try {
    const project = join(root, 'project');
    const profile = join(root, 'profile');
    const config = join(profile, 'engine', 'config');
    const entry = join(root, 'shared-cli-shim.mjs');
    const hostRunReceipt = join(root, 'host-run-receipt.jsonl');
    const legacyRunReceipt = join(root, 'legacy-run-receipt.txt');
    await mkdir(project);
    await mkdir(config, { recursive: true });
    await writeFile(join(project, 'README.md'), 'Synthetic shared-session project');

    await writeFile(
      entry,
      `import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
const dist = ${JSON.stringify(babelCliDist)};
const argv = process.argv.slice(2);
const legacyRunReceipt = ${JSON.stringify(legacyRunReceipt)};
const hostRunReceipt = ${JSON.stringify(hostRunReceipt)};
if (argv[0] === '--desktop-capabilities') {
  console.log(JSON.stringify({ schemaVersion: 1, credentialEnvironment: 'native-resolved-v1' }));
  process.exit(0);
}
let argvToRun = [...argv];
const remoteIdx = argvToRun.indexOf('remote');
let remoteSub = remoteIdx >= 0 ? argvToRun[remoteIdx + 1] : '';
if (remoteIdx >= 0 && remoteSub === 'serve') {
  argvToRun[remoteIdx + 1] = 'acceptance-bridge';
  remoteSub = 'acceptance-bridge';
}
if (remoteIdx >= 0 && (remoteSub === 'serve' || remoteSub === 'acceptance-bridge' || remoteSub === 'host-run')) {
  appendFileSync(hostRunReceipt, remoteSub + '\\n');
  const childEnv = { ...process.env };
  if (remoteSub === 'acceptance-bridge') childEnv.BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE = '1';
  const child = spawn(process.execPath, ['--experimental-wasm-modules', dist, ...argvToRun], {
    cwd: process.cwd(),
    stdio: remoteSub === 'host-run' ? ['pipe', 'pipe', 'inherit'] : 'inherit',
    env: childEnv,
  });
  if (remoteSub === 'host-run' && child.stdout) {
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    if (child.stdin) process.stdin.pipe(child.stdin);
  }
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else if (argv.includes('run')) {
  writeFileSync(legacyRunReceipt, 'legacy-run');
  process.stdout.write(JSON.stringify({ type: 'run_start' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'run_complete', result: { session_id: 'legacy', answer: 'legacy' } }) + '\\n');
  process.exit(0);
} else {
  console.error('unexpected shim argv', argv);
  process.exit(2);
}
`,
    );

    await writeFile(
      join(profile, 'ui-connection.json'),
      JSON.stringify({ projectRoot: project, cliEntry: entry }),
    );
    const bootstrap = join(root, 'bootstrap.cjs');
    await writeFile(
      bootstrap,
      `const {app,dialog}=require('electron');dialog.showErrorBox=(title,message)=>{console.error(title+': '+message);app.quit();};import(${JSON.stringify(new URL('../native/main.mjs', import.meta.url).href)}).catch(error=>{console.error(error);app.quit();});`,
    );
    saveProviderRoute({
      configDirectory: config,
      provider: 'openrouter',
      model: 'deepseek-v4-pro-openrouter',
    });

    const env = buildLifecycleStyleEnv(profile);
    const launchArgs = [bootstrap, `--profile-dir=${profile}`];
    const gpuSafeArgs =
      process.platform === 'linux'
        ? ['--disable-gpu', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--no-zygote']
        : [];

    markStage('fixtures:ready', { executable: electronExecutable, gpuSafeArgs });

    let childStderr = '';
    markStage('before-electron.launch', { timeoutMs: 45_000 });
    application = await bounded(
      _electron.launch({
        executablePath: electronExecutable,
        args: [...gpuSafeArgs, ...launchArgs],
        env,
        timeout: 45_000,
      }),
      50_000,
      'electron.launch',
    );
    application.process().stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      childStderr += text;
      traceStages.push(...parseSharedSessionTrace(text));
    });
    markStage('after-electron.launch', { ok: true });

    const page = await bounded(application.firstWindow(), 20_000, 'firstWindow');
    await bounded(page.waitForLoadState('domcontentloaded'), 20_000, 'renderer:domcontentloaded');
    markStage('renderer:ready', { url: page.url() });

    await bounded(
      application.evaluate(({ dialog }) => {
        dialog.showMessageBox = async (_window, options) => ({
          response: options?.buttons?.includes('Trust project') ? 1 : 0,
          checkboxChecked: false,
        });
      }),
      5_000,
      'dialog:trust-mock',
    );

    const trust = await bounded(page.evaluate(EVAL_TRUST_PROJECT), 20_000, 'ipc:trustProject');
    if (!trust?.trusted) {
      failStage(
        'ipc:trustProject',
        `project not trusted; authority=${JSON.stringify(trust)}; stderrTail=${childStderr.slice(-1500)}`,
      );
    }
    markStage('ipc:trustProject', { trusted: true });

    const bridgePort = 4600 + Math.floor(Math.random() * 400);
    await bounded(page.evaluate(EVAL_START_REMOTE_BRIDGE, bridgePort), 45_000, 'ipc:startRemoteBridge');
    markStage('ipc:startRemoteBridge', { port: bridgePort });

    await waitTraceStage('start-remote-bridge:ready', 40_000);
    markStage('trace:start-remote-bridge:ready', {});

    const bridgeReady = await bounded(page.evaluate(EVAL_GET_REMOTE_BRIDGE), 10_000, 'ipc:getInfo.remoteBridge');
    if (!bridgeReady?.sharedSession || bridgeReady.state !== 'ready' || !bridgeReady.running) {
      failStage('ipc:getInfo.remoteBridge', `bridge not ready: ${JSON.stringify(bridgeReady)}`);
    }
    markStage('ipc:getInfo.remoteBridge', bridgeReady);

    const firstTurn = await bounded(
      page.evaluate(EVAL_RUN_SHARED_TURN, {
        runId: 'electron-turn-1',
        task: 'Shared session turn one',
        sessionId: null,
      }),
      60_000,
      'ipc:run turn-1',
    );
    markStage('ipc:run turn-1 complete', { session_id: firstTurn.result?.session_id });

    await waitTraceMatch(
      () => traceStages.some((e) => e.stage === 'host-run:spawn' && e.runId === 'electron-turn-1'),
      'trace:host-run:spawn turn-1',
    );
    await waitTraceMatch(
      () =>
        traceStages.some(
          (e) =>
            e.stage === 'host-run:event' &&
            e.runId === 'electron-turn-1' &&
            e.eventType === 'run_complete',
        ),
      'trace:host-run:event run_complete turn-1',
    );
    await waitTraceMatch(
      () =>
        traceStages.some(
          (e) =>
            e.stage === 'babel:event' &&
            e.runId === 'electron-turn-1' &&
            e.eventType === 'run_complete',
        ),
      'trace:babel:event run_complete turn-1',
    );
    markStage('trace:turn-1 terminal evidence', {});

    assert.equal(typeof firstTurn.result?.session_id, 'string');
    assert.equal(firstTurn.result?.fixture_execution, true, 'deterministic acceptance engine marker');
    assert.equal(firstTurn.result?.terminal_outcome, 'UNVERIFIED_PATCH');
    const receiptAfterFirst = await readFile(hostRunReceipt, 'utf8').catch(() => '');
    if (!receiptAfterFirst.includes('host-run')) {
      failStage('receipt:host-run turn-1', receiptAfterFirst || '(empty)');
    }
    if (existsSync(legacyRunReceipt)) {
      failStage('receipt:legacy-run absent', await readFile(legacyRunReceipt, 'utf8'));
    }

    const secondTurn = await runSharedTurnWithAdmissionRetry(
      page,
      {
        runId: 'electron-turn-2',
        task: 'Shared session turn two',
        sessionId: firstTurn.result.session_id,
      },
      'ipc:run turn-2',
      failStage,
    );
    markStage('ipc:run turn-2 complete', { session_id: secondTurn.result?.session_id });

    assert.equal(secondTurn.result?.session_id, firstTurn.result.session_id);
    const receiptFinal = await readFile(hostRunReceipt, 'utf8');
    const hostRunCount = receiptFinal.split('\n').filter((line) => line === 'host-run').length;
    if (hostRunCount < 2) {
      failStage('receipt:host-run turn-2', receiptFinal);
    }
    markStage('fixture:two-turn-pass', {
      threadId: firstTurn.result.session_id,
      hostRunInvocations: hostRunCount,
    });
  } catch (error) {
    emitParentTrace('fixture:error', {
      error: error instanceof Error ? error.message : String(error),
      completedStages,
    });
    throw error;
  } finally {
    emitParentTrace('cleanup:start', { hadApplication: Boolean(application), completedStages });
    await shutdownElectronApplication(application);
    await rm(root, { recursive: true, force: true }).catch(() => {});
    emitParentTrace('cleanup:done', {});
  }
});
