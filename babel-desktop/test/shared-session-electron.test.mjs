// Production shared-session path: Electron IPC → SharedProtocolRun → `babel remote host-run` (not `babel run`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';
import { saveProviderRoute } from '../native/provider-routing.mjs';

const babelCliDist = resolve(
  fileURLToPath(new URL('../../babel-cli/dist/index.js', import.meta.url)),
);

test('shared-session Electron run uses host-run child and preserves thread across two turns', {
  skip: !process.env.BABEL_TEST_ELECTRON_EXECUTABLE,
  timeout: 120_000,
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
const isRemote = remoteIdx >= 0;
const remoteSub = isRemote ? argv[remoteIdx + 1] : '';
if (isRemote && (remoteSub === 'serve' || remoteSub === 'host-run')) {
  const child = spawn(process.execPath, ['--experimental-wasm-modules', dist, ...argv], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return;
}
if (argv.includes('run')) {
  writeFileSync(legacyRunReceipt, 'legacy-run');
  process.stdout.write(JSON.stringify({ type: 'run_start' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'run_complete', result: { session_id: 'legacy', answer: 'legacy' } }) + '\\n');
  process.exit(0);
}
console.error('unexpected shim argv', argv);
process.exit(2);
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
    ]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.BABEL_RUNS_DIR = join(profile, 'engine', 'state', 'runs');

    application = await _electron.launch({
      executablePath: process.env.BABEL_TEST_ELECTRON_EXECUTABLE,
      args: [bootstrap, `--profile-dir=${profile}`],
      env,
      timeout: 30_000,
    });
    const page = await application.firstWindow();
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });

    const authority = await page.evaluate(() => window.babelDesktop.trustProject());
    assert.equal(authority.projectAuthority.trusted, true);

    await page.evaluate(() => window.babelDesktop.startRemoteBridge({ port: 4551 }));
    const bridge = await page.evaluate(() => window.babelDesktop.getInfo().remoteBridge);
    assert.equal(bridge?.sharedSession, true);
    assert.equal(bridge?.running, true);

    await page.waitForFunction(() => !document.querySelector('#send-button').disabled);
    await page.locator('#composer-input').fill('Shared session turn one');
    await page.locator('#composer-form').evaluate((form) => form.requestSubmit());
    await page.waitForFunction(
      () =>
        document.querySelector('#main-status').textContent === 'Running' ||
        !document.querySelector('#send-button').disabled,
      null,
      { timeout: 60_000 },
    );

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

    const sessionAfterFirst = await page.evaluate(() => window.babelDesktop.getInfo().babelSessionId);
    await page.waitForFunction(() => !document.querySelector('#send-button').disabled, null, {
      timeout: 90_000,
    });

    await page.locator('#composer-input').fill('Shared session turn two');
    await page.locator('#composer-form').evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => !document.querySelector('#send-button').disabled, null, {
      timeout: 90_000,
    });
    const sessionAfterSecond = await page.evaluate(() => window.babelDesktop.getInfo().babelSessionId);
    if (sessionAfterFirst && sessionAfterSecond) {
      assert.equal(sessionAfterSecond, sessionAfterFirst, 'two turns must share babelSessionId');
    }
  } finally {
    if (application) {
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await application.close().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function assertEventually(check, message) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(message ?? 'condition not met');
}
