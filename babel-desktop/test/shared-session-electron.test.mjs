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
  timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-shared-session-electron-'));
  let application;
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
if (remoteIdx >= 0 && remoteSub === 'serve') {
  appendFileSync(hostRunReceipt, 'serve\\n');
  const child = spawn(process.execPath, ['--experimental-wasm-modules', dist, ...argv], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else if (remoteIdx >= 0 && remoteSub === 'host-run') {
  appendFileSync(hostRunReceipt, 'host-run\\n');
  const resumeIdx = argv.indexOf('--resume-thread');
  const sessionId =
    resumeIdx >= 0 && typeof argv[resumeIdx + 1] === 'string'
      ? argv[resumeIdx + 1]
      : 'electron-fixture-thread';
  process.stdout.write(JSON.stringify({ type: 'run_start' }) + '\\n');
  process.stdout.write(
    JSON.stringify({
      type: 'run_complete',
      result: {
        session_id: sessionId,
        answer: 'fixture shared-session turn',
        terminal_outcome: 'COMPLETED',
      },
    }) + '\\n',
  );
  process.exit(0);
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

    const launchArgs = [bootstrap, `--profile-dir=${profile}`];
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      launchArgs.unshift('--ozone-platform=headless');
    }

    application = await _electron.launch({
      executablePath: electronExecutable,
      args: launchArgs,
      env,
      timeout: 30_000,
    });
    const page = await application.firstWindow();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => ({
        response: options?.buttons?.includes('Trust project') ? 1 : 0,
        checkboxChecked: false,
      });
    });

    const authority = await page.evaluate(() => window.babelDesktop.trustProject());
    assert.equal(authority.projectAuthority.trusted, true);

    await page.evaluate(async () => {
      await window.babelDesktop.startRemoteBridge({ port: 4551 });
    });
    await assertEventually(async () => {
      const info = await page.evaluate(() => window.babelDesktop.getInfo());
      return info.remoteBridge?.sharedSession === true && info.remoteBridge?.state === 'ready';
    }, 'shared-session bridge never reached ready state');
    const bridge = await page.evaluate(() => window.babelDesktop.getInfo().remoteBridge);
    assert.equal(bridge?.sharedSession, true);
    assert.equal(bridge?.running, true);

    const runSharedTurn = (runId, task, sessionId) =>
      page.evaluate(
        ({ runId, task, sessionId }) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`run ${runId} timed out`)), 45_000);
            const unsubscribe = window.babelDesktop.onEvent((packet) => {
              if (packet.runId !== runId) return;
              if (packet.event?.type === 'run_complete') {
                clearTimeout(timeout);
                unsubscribe();
                resolve(packet.event.result);
              }
              if (packet.event?.type === 'run_error') {
                clearTimeout(timeout);
                unsubscribe();
                reject(new Error(String(packet.event.error ?? 'run_error')));
              }
            });
            window.babelDesktop
              .run({
                runId,
                task,
                mode: 'chat',
                ...(sessionId ? { sessionId } : {}),
              })
              .catch((error) => {
                clearTimeout(timeout);
                unsubscribe();
                reject(error);
              });
          }),
        { runId, task, sessionId },
      );

    const firstResult = await runSharedTurn('electron-turn-1', 'Shared session turn one');
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

    const secondResult = await runSharedTurn(
      'electron-turn-2',
      'Shared session turn two',
      firstResult.session_id,
    );
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
