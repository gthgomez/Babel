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

test('shared-session Electron run uses host-run child and preserves thread across two turns', {
  skip: !electronExecutable
    ? 'missing Electron binary: run npm install in babel-desktop or set BABEL_TEST_ELECTRON_EXECUTABLE'
    : !existsSync(babelCliDist)
      ? 'missing babel-cli dist/index.js: run npm run build in babel-cli'
      : !existsSync(desktopDistHtml)
        ? 'missing babel-desktop dist/index.html: run npm run build in babel-desktop'
        : false,
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shared-session-electron-'));
  let application;
  const traceStages = [];
  const failStage = (stage, evidence) => {
    assert.fail(
      `Electron shared-session stalled at stage "${stage}"; trace=${JSON.stringify(traceStages.map((s) => s.stage))}; evidence=${evidence}`,
    );
  };
  const waitStage = async (stage, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (traceStages.some((entry) => entry.stage === stage)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    failStage(stage, `missing trace stage within ${timeoutMs}ms`);
  };
  const invokeBounded = async (label, fn, timeoutMs = 15_000) => {
    let timer;
    try {
      return await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      failStage(label, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
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
const remoteIdx = argv.indexOf('remote');
const remoteSub = remoteIdx >= 0 ? argv[remoteIdx + 1] : '';
if (remoteIdx >= 0 && (remoteSub === 'serve' || remoteSub === 'acceptance-bridge' || remoteSub === 'host-run')) {
  appendFileSync(hostRunReceipt, remoteSub + '\\n');
  const child = spawn(process.execPath, ['--experimental-wasm-modules', dist, ...argv], {
    cwd: process.cwd(),
    stdio: remoteSub === 'host-run' ? ['pipe', 'pipe', 'inherit'] : 'inherit',
    env: process.env,
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

    const env = { ...process.env };
    env.BABEL_RUNS_DIR = join(profile, 'engine', 'state', 'runs');
    env.BABEL_TEST_ACCEPTANCE_DETERMINISTIC_BRIDGE = '1';
    env.BABEL_TEST_SHARED_SESSION_TRACE = '1';
    env.ELECTRON_NO_SANDBOX = '1';

    const launchArgs = [bootstrap, `--profile-dir=${profile}`];
    const gpuSafeArgs =
      process.platform === 'linux'
        ? ['--disable-gpu', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--no-zygote']
        : [];
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      gpuSafeArgs.unshift('--ozone-platform=headless');
    }

    application = await invokeBounded(
      'electron.launch',
      () =>
        _electron.launch({
          executablePath: electronExecutable,
          args: [...gpuSafeArgs, ...launchArgs],
          env,
          timeout: 45_000,
        }),
      50_000,
    );
    application.process().stderr?.on('data', (chunk) => {
      traceStages.push(...parseSharedSessionTrace(chunk.toString('utf8')));
    });
    const page = await invokeBounded('firstWindow', () => application.firstWindow(), 20_000);
    await waitStage('renderer:did-finish-load', 20_000);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => ({
        response: options?.buttons?.includes('Trust project') ? 1 : 0,
        checkboxChecked: false,
      });
    });

    const authority = await invokeBounded('trustProject', () =>
      page.evaluate(() => window.babelDesktop.trustProject()),
    );
    assert.equal(authority.projectAuthority.trusted, true);

    const bridgePort = 4600 + Math.floor(Math.random() * 400);
    await invokeBounded('startRemoteBridge IPC', () =>
      page.evaluate(async (port) => {
        await window.babelDesktop.startRemoteBridge({ port });
      }, bridgePort),
      35_000,
    );
    await waitStage('start-remote-bridge:ready', 35_000);
    await assertEventually(async () => {
      const info = await page.evaluate(() => window.babelDesktop.getInfo());
      return info.remoteBridge?.sharedSession === true && info.remoteBridge?.state === 'ready';
    }, 'shared-session bridge never reached ready state');
    const bridge = await page.evaluate(() => window.babelDesktop.getInfo().remoteBridge);
    assert.equal(bridge?.sharedSession, true);
    assert.equal(bridge?.running, true);

    const runSharedTurn = (runId, task, sessionId) =>
      invokeBounded(`run IPC ${runId}`, () =>
        page.evaluate(
          ({ runId, task, sessionId }) =>
            new Promise((resolve, reject) => {
              const seen = [];
              const timeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      `run ${runId} missing terminal event; seen=${JSON.stringify(seen)}`,
                    ),
                  ),
                25_000,
              );
              const unsubscribe = window.babelDesktop.onEvent((packet) => {
                if (packet.runId !== runId) return;
                const eventType = packet.event?.type ?? packet.kind;
                seen.push(eventType);
                if (packet.event?.type === 'run_complete') {
                  clearTimeout(timeout);
                  unsubscribe();
                  resolve({ result: packet.event.result, seen });
                }
                if (packet.event?.type === 'run_error') {
                  clearTimeout(timeout);
                  unsubscribe();
                  reject(new Error(String(packet.event.error ?? 'run_error')));
                }
                if (packet.kind === 'exit' && packet.code !== 0) {
                  clearTimeout(timeout);
                  unsubscribe();
                  reject(new Error(`host-run child exit code ${packet.code}`));
                }
              });
              window.babelDesktop
                .run({
                  runId,
                  task,
                  mode: 'chat',
                  ...(sessionId ? { sessionId } : {}),
                })
                .then((started) => {
                  if (!started?.started) {
                    clearTimeout(timeout);
                    unsubscribe();
                    reject(new Error(`run ${runId} was not started by the host`));
                  }
                })
                .catch((error) => {
                  clearTimeout(timeout);
                  unsubscribe();
                  reject(error);
                });
            }),
          { runId, task, sessionId },
        ),
      );

    const firstTurn = await runSharedTurn('electron-turn-1', 'Shared session turn one');
    const firstResult = firstTurn.result;
    assert.ok(
      traceStages.some((entry) => entry.stage === 'host-run:spawn' && entry.runId === 'electron-turn-1'),
      `missing host-run child spawn trace: ${JSON.stringify(traceStages)}`,
    );
    assert.ok(
      traceStages.some(
        (entry) =>
          entry.stage === 'babel:event' &&
          entry.runId === 'electron-turn-1' &&
          entry.eventType === 'run_complete',
      ),
      `missing main-process run_complete delivery: ${JSON.stringify(traceStages)}`,
    );
    assert.equal(typeof firstResult?.session_id, 'string');
    await assertEventually(async () => {
      try {
        const text = await readFile(hostRunReceipt, 'utf8');
        return text.includes('host-run');
      } catch {
        return false;
      }
    }, 'host-run receipt missing');

    await assertEventually(async () => {
      try {
        await readFile(legacyRunReceipt);
        return false;
      } catch {
        return true;
      }
    }, 'legacy babel run must not be used under shared bridge');

    const secondTurn = await runSharedTurn(
      'electron-turn-2',
      'Shared session turn two',
      firstResult.session_id,
    );
    const secondResult = secondTurn.result;
    assert.equal(secondResult?.session_id, firstResult.session_id);
    await assertEventually(async () => {
      const text = await readFile(hostRunReceipt, 'utf8');
      return text.split('\n').filter((line) => line === 'host-run').length >= 2;
    }, 'second host-run child was not started');
  } finally {
    if (application) {
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await application.close().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function assertEventually(check, message) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(message ?? 'condition not met');
}
