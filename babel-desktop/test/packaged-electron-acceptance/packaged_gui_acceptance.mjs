// License: Apache-2.0
import {createHash} from 'node:crypto';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {_electron as electron} from 'playwright';
import {parseBuildMetadata} from '../../native/identity.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(scriptDir, '..', '..');

function artifactDir() {
  return process.env.BABEL_DESKTOP_ACCEPTANCE_DIR
    ? resolve(process.env.BABEL_DESKTOP_ACCEPTANCE_DIR)
    : join(desktopRoot, 'artifacts', 'packaged-electron');
}

async function writeReport(dir, report) {
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'packaged-electron-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  const artifacts = artifactDir();
  if (process.platform !== 'win32') {
    const report = {
      skipped: true,
      reason: 'Packaged Electron GUI acceptance runs only on Windows after NSIS install',
      platform: process.platform,
      untestedJourneys: ['saved-chat paging', 'live provider runs', 'project-connected ready state'],
    };
    await writeReport(artifacts, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const installRoot = process.env.BABEL_DESKTOP_INSTALL_ROOT;
  if (!installRoot) throw new Error('BABEL_DESKTOP_INSTALL_ROOT is required');
  const install = resolve(installRoot);
  const exe = join(install, 'Babel Desktop.exe');
  const buildPath = join(install, 'BUILD.json');
  const checks = [];
  const errors = [];
  const identity = {installRoot: install, executable: exe};

  try {
    await stat(exe);
    identity.executablePresent = true;
    const buildText = await readFile(buildPath, 'utf8');
    identity.build = parseBuildMetadata(buildText);
    identity.executableSha256 = createHash('sha256').update(await readFile(exe)).digest('hex');
    const expectedSha = String(process.env.BABEL_DESKTOP_SOURCE_SHA || '').trim();
    if (expectedSha && identity.build?.sourceSha) {
      if (identity.build.sourceSha.toLowerCase() !== expectedSha.toLowerCase()) {
        throw new Error(`BUILD.json sourceSha ${identity.build.sourceSha} != checkout ${expectedSha}`);
      }
      checks.push('BUILD.json sourceSha matches CI checkout');
    }
    checks.push('installed executable and BUILD.json identity verified on disk');
  } catch (error) {
    errors.push(String(error?.message ?? error));
    const report = {passed: 0, checks, errors, identity};
    await writeReport(artifacts, report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const profile = join(tmpdir(), `babel-desktop-gui-${Date.now()}`);
  await mkdir(profile, {recursive: true});
  let app;
  try {
    app = await electron.launch({
      executablePath: exe,
      args: [`--profile-dir=${profile}`],
      timeout: 120_000,
    });
    const window = await app.firstWindow();
    window.on('pageerror', error => errors.push(`pageerror: ${error?.message ?? error}`));
    window.on('console', message => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    await window.waitForLoadState('domcontentloaded', {timeout: 60_000});
    const info = await window.evaluate(async () => {
      if (!window.babelDesktop?.getInfo) return {preloadMissing: true};
      return await window.babelDesktop.getInfo();
    });
    identity.ipc = {
      preloadPresent: !info?.preloadMissing,
      packaged: info?.packaged,
      officialCliReady: info?.officialCliReady,
      runtimeSource: info?.runtimeSource,
      engineOrigin: info?.engine?.origin,
      buildVersion: info?.engine?.buildVersion,
      sourceCommit: info?.engine?.source?.commitSha,
      connectionReady: info?.ready,
      engineReadinessReady: info?.engine?.readiness?.ready,
    };
    if (info?.preloadMissing) throw new Error('window.babelDesktop.getInfo is unavailable (preload not wired)');
    if (info.packaged !== true) throw new Error(`getInfo().packaged expected true, got ${info.packaged}`);
    if (info.officialCliReady !== true) throw new Error('packaged install must report officialCliReady true');
    if (info.engine?.origin !== 'bundled') throw new Error(`engine.origin expected bundled, got ${info.engine?.origin}`);
    if (info.ready !== false) throw new Error('fresh install must report ready false without a project');
    if (info.engine?.readiness?.ready !== false) throw new Error('engine.readiness.ready must stay false without a project');
    if (identity.build?.sourceSha && info.engine?.source?.commitSha !== identity.build.sourceSha) {
      throw new Error('engine.source.commitSha must match BUILD.json sourceSha');
    }
    checks.push('preload IPC getInfo reports packaged bundled engine with truthful not-ready connection');
    await window.waitForSelector('#preview-badge', {timeout: 30_000});
    const badge = await window.locator('#preview-badge').inner_text();
    if (badge !== 'REFERENCE PREVIEW') throw new Error(`unexpected preview badge: ${badge}`);
    checks.push('renderer shows REFERENCE PREVIEW before live connection');
    await mkdir(artifacts, {recursive: true});
    await window.screenshot({path: join(artifacts, 'packaged-electron-window.png'), full_page: true});
    checks.push('screenshot captured from packaged Electron window');
  } catch (error) {
    errors.push(String(error?.message ?? error));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  const report = {
    passed: errors.length ? 0 : checks.length,
    basis: 'Installed Babel Desktop.exe via Playwright _electron.launch({ executablePath })',
    checks,
    errors,
    identity,
    untestedJourneys: ['saved-chat history paging in installed app', 'provider credential save', 'live CLI run with project'],
  };
  await writeReport(artifacts, report);
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
