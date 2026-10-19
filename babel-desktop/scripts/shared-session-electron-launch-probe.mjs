#!/usr/bin/env node
// Bounded launch probe: parent traces + firstWindow only (no full shared-session turn flow).
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { _electron } from 'playwright';
import { saveProviderRoute } from '../native/provider-routing.mjs';

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

const electronDistDir = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'node_modules',
  'electron',
  'dist',
);
const electronNames = process.platform === 'win32' ? ['electron.exe', 'electron'] : ['electron'];
const bundledElectron = electronNames
  .map((name) => join(electronDistDir, name))
  .find((candidate) => existsSync(candidate));
const electronExecutable = process.env.BABEL_TEST_ELECTRON_EXECUTABLE ?? bundledElectron ?? null;

if (!electronExecutable) {
  console.error('probe: missing electron executable');
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), 'babel-shared-session-probe-'));
let application;
try {
  const project = join(root, 'project');
  const profile = join(root, 'profile');
  const config = join(profile, 'engine', 'config');
  await mkdir(project);
  await mkdir(config, { recursive: true });
  await writeFile(join(project, 'README.md'), 'probe');
  await writeFile(
    join(profile, 'ui-connection.json'),
    JSON.stringify({ projectRoot: project, cliEntry: process.execPath }),
  );
  const bootstrap = join(root, 'bootstrap.cjs');
  await writeFile(
    bootstrap,
    `const {app,dialog}=require('electron');dialog.showErrorBox=(t,m)=>{console.error(t+': '+m);app.quit();};import(${JSON.stringify(new URL('../native/main.mjs', import.meta.url).href)}).catch(e=>{console.error(e);app.quit();});`,
  );
  saveProviderRoute({
    configDirectory: config,
    provider: 'openrouter',
    model: 'deepseek-v4-pro-openrouter',
  });

  const env = {};
  for (const name of ['PATH', 'HOME', 'DISPLAY', 'XAUTHORITY']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.ELECTRON_NO_SANDBOX = '1';
  const gpuSafeArgs =
    process.platform === 'linux'
      ? ['--disable-gpu', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--no-zygote']
      : [];

  emitParentTrace('before-electron.launch', { executable: electronExecutable });
  application = await _electron.launch({
    executablePath: electronExecutable,
    args: [...gpuSafeArgs, bootstrap, `--profile-dir=${profile}`],
    env,
    timeout: 25_000,
  });
  emitParentTrace('after-electron.launch', { ok: true });

  const page = await application.firstWindow();
  emitParentTrace('firstWindow', { url: page.url() });

  await application.evaluate(({ app }) => app.exit(0));
  await application.close();
  emitParentTrace('cleanup:done', {});
} catch (error) {
  emitParentTrace('probe:error', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
