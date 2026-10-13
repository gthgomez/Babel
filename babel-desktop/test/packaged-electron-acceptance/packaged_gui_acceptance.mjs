// License: Apache-2.0
import {createHash} from 'node:crypto';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {_electron as electron} from 'playwright';
import {parseBuildMetadata} from '../../native/identity.mjs';
import {HISTORY_SESSION_ID, writePackagedAcceptanceProfile} from './packaged-fixture-lane.mjs';

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

/** Packaged startup opens BABEL SETUP over the footer; dismiss via backdrop only. */
async function dismissPackagedSetupDialog(window) {
  const dialog = window.locator('#dialog');
  await dialog.click({position: {x: 8, y: 8}});
  await window.waitForSelector('#dialog:not([open])', {timeout: 15_000});
}

/**
 * Use the startup modal's harness control (never #preview-badge while #dialog is open).
 * @returns {Promise<{connected: boolean, reason?: string}>}
 */
async function connectLiveFromPackagedStartupDialog(window) {
  await window.waitForSelector('#dialog[open]', {timeout: 30_000});
  const title = await window.locator('#dialog-title').innerText();
  if (!title.includes('BABEL SETUP')) {
    throw new Error(`expected packaged startup BABEL SETUP dialog, got: ${title}`);
  }
  const useLive = window.locator('#dialog [data-action="use-live"]');
  await useLive.waitFor({state: 'visible', timeout: 15_000});
  const enabled = await useLive.isEnabled();
  if (!enabled) {
    await dismissPackagedSetupDialog(window);
    return {
      connected: false,
      reason: 'Use Babel Harness disabled until execution diagnostics report ready (Docker); connection validated via IPC',
    };
  }
  await useLive.click();
  await window.locator('#preview-badge').waitFor({timeout: 30_000});
  const badge = await window.locator('#preview-badge').innerText();
  if (badge !== 'BABEL CLI') throw new Error(`expected BABEL CLI badge after harness, got: ${badge}`);
  return {connected: true};
}

async function main() {
  const artifacts = artifactDir();
  const untestedJourneys = [];
  const journeys = {};

  if (process.platform !== 'win32') {
    const report = {
      skipped: true,
      reason: 'Packaged Electron GUI acceptance runs only on Windows after NSIS install',
      platform: process.platform,
      untestedJourneys: [
        'saved-chat history paging in installed app',
        'provider route configuration without credentials',
        'project-connected live shell without model execution',
        'interactive NSIS installer failure dialog (hosted lane launches installed exe only)',
      ],
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
    const report = {passed: 0, checks, errors, identity, journeys, untestedJourneys};
    await writeReport(artifacts, report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const profile = join(tmpdir(), `babel-desktop-gui-${Date.now()}`);
  await mkdir(profile, {recursive: true});
  const fixtures = await writePackagedAcceptanceProfile(profile);
  identity.fixtureProjectRoot = fixtures.projectRoot;

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
      projectName: info?.projectName,
    };
    if (info?.preloadMissing) throw new Error('window.babelDesktop.getInfo is unavailable (preload not wired)');
    if (info.packaged !== true) throw new Error(`getInfo().packaged expected true, got ${info.packaged}`);
    if (info.officialCliReady !== true) throw new Error('packaged install must report officialCliReady true');
    if (info.engine?.origin !== 'bundled') throw new Error(`engine.origin expected bundled, got ${info.engine?.origin}`);
    if (identity.build?.sourceSha && info.engine?.source?.commitSha !== identity.build.sourceSha) {
      throw new Error('engine.source.commitSha must match BUILD.json sourceSha');
    }
    checks.push('preload IPC getInfo reports packaged bundled engine');
    await window.waitForSelector('#preview-badge', {timeout: 30_000});
    const badge = await window.locator('#preview-badge').innerText();
    if (badge !== 'REFERENCE PREVIEW') throw new Error(`unexpected preview badge: ${badge}`);
    checks.push('renderer shows REFERENCE PREVIEW before live connection');

    if (info.ready !== true || info.projectName !== 'acceptance-project') {
      throw new Error(`fixture project not connected (ready=${info.ready}, project=${info.projectName})`);
    }
    if (info.engine?.readiness?.ready !== true) {
      throw new Error('engine.readiness.ready must be true with bundled CLI and fixture project');
    }
    checks.push('fixture-backed project connects with truthful ready state (no model run)');
    journeys.project = {status: 'executed', transport: 'preload IPC getInfo + listDirectory'};

    const tree = await window.evaluate(async () => {
      const entries = await window.babelDesktop.listDirectory('.');
      return entries.map(entry => entry.name);
    });
    if (!tree.includes('README.md')) throw new Error('fixture project tree missing README.md');
    checks.push('listDirectory IPC reads the fixture project through main process');
    journeys.projectTree = {status: 'executed'};

    const historyIpc = await window.evaluate(async sessionId => {
      const listed = await window.babelDesktop.listSessions({limit: 30, offset: 0});
      const tail = await window.babelDesktop.openSession(sessionId, {olderOffset: 0});
      const older = await window.babelDesktop.openSession(sessionId, {olderOffset: 150});
      const tailTexts = tail.messages.map(message => message.text);
      const olderTexts = older.messages.map(message => message.text);
      const overlap = tailTexts.filter(text => olderTexts.includes(text));
      return {
        listed: listed.sessions?.length ?? listed.length ?? 0,
        tailStart: tail.history?.windowStart,
        hasM159: tailTexts.includes('m-159'),
        hasM009Older: olderTexts.includes('m-009'),
        overlapCount: overlap.length,
      };
    }, HISTORY_SESSION_ID);
    if (historyIpc.listed < 1) throw new Error('listSessions did not discover fixture history');
    if (historyIpc.tailStart !== 10) throw new Error(`unexpected tail windowStart ${historyIpc.tailStart}`);
    if (!historyIpc.hasM159 || !historyIpc.hasM009Older || historyIpc.overlapCount !== 0) {
      throw new Error(`history paging overlap or bounds failed: ${JSON.stringify(historyIpc)}`);
    }
    checks.push('installed history IPC pages tail and older windows without overlap');
    journeys.historyIpc = {status: 'executed'};

    const provider = await window.evaluate(async () => {
      const providers = await window.babelDesktop.listQualifiedProviders();
      const saved = await window.babelDesktop.saveProviderRoute({provider: 'ollama', model: 'deepseek-v4-flash'});
      const route = await window.babelDesktop.readProviderRoute();
      return {
        providerCount: providers.length,
        savedProvider: saved?.route?.provider,
        routeProvider: route?.provider,
        routeModel: route?.model,
      };
    });
    if (provider.providerCount < 1) throw new Error('listQualifiedProviders returned no providers');
    if (provider.savedProvider !== 'ollama' || provider.routeProvider !== 'ollama') {
      throw new Error(`provider route not persisted: ${JSON.stringify(provider)}`);
    }
    checks.push('provider route saves via IPC without API credentials (ollama local route)');
    journeys.provider = {status: 'executed', note: 'route-only; no credential file or model call'};

    const harness = await connectLiveFromPackagedStartupDialog(window);
    if (harness.connected) {
      checks.push('startup BABEL SETUP modal connects live harness via enabled Use Babel Harness');
      await window.waitForSelector('button.session-button[data-action="session"]', {timeout: 30_000});
      await window.locator('button.session-button[data-action="session"]', {hasText: 'PACKAGED-HISTORY'}).click();
      const conv = window.locator('#conversation');
      await conv.locator('text=m-159').waitFor({timeout: 30_000});
      if (await conv.locator('text=m-009').count()) throw new Error('tail view should not include m-009');
      await window.locator('[data-action="load-older-messages"]').click();
      await conv.locator('text=m-009').waitFor({timeout: 30_000});
      if (await conv.locator('text=m-159').count()) throw new Error('older view should not include m-159');
      await window.locator('[data-action="load-latest-messages"]').click();
      await conv.locator('text=m-159').waitFor({timeout: 30_000});
      checks.push('renderer history navigation latest→older→latest on installed transport');
      journeys.historyUi = {status: 'executed'};
    } else {
      journeys.historyUi = {status: 'blocked', reason: harness.reason};
    }

    await window.locator('[data-action="settings"]').click();
    await window.locator('[data-action="configure-provider"]').click();
    await window.waitForSelector('#dialog-title', {timeout: 15_000});
    const dialogTitle = await window.locator('#dialog-title').innerText();
    if (!dialogTitle.includes('CONFIGURE AI PROVIDER')) throw new Error(`unexpected provider dialog: ${dialogTitle}`);
    await window.locator('#dialog [data-action="close-dialog"].button').click();
    checks.push('provider configuration dialog opens from settings on installed renderer');
    journeys.providerUi = {status: 'executed', note: 'dialog open/cancel only; no credential entry'};

    await mkdir(artifacts, {recursive: true});
    await window.screenshot({path: join(artifacts, 'packaged-electron-window.png'), fullPage: true});
    await window.screenshot({path: join(artifacts, 'packaged-electron-history.png'), fullPage: true});
    checks.push('screenshots captured from packaged Electron window');
  } catch (error) {
    errors.push(String(error?.message ?? error));
  } finally {
    if (app) await app.close().catch(() => {});
  }

  untestedJourneys.push(
    'babel:run task execution with any provider (no paid or live model calls in acceptance)',
    'chooseProject native open-directory dialog automation',
    'interactive NSIS installer failure dialog visibility (lifecycle exercises corrupt payload rejection without Electron UI)',
  );
  journeys.installerInteractiveFailure = {
    status: 'blocked',
    reason: 'NSIS interactive failure surface is not exposed to Playwright; corrupt upgrade is validated in run-lifecycle.ps1 step 6 only',
  };

  const report = {
    passed: errors.length ? 0 : checks.length,
    basis: 'Installed Babel Desktop.exe via Playwright _electron.launch({ executablePath }) with fixture profile',
    checks,
    errors,
    identity,
    journeys,
    untestedJourneys,
  };
  await writeReport(artifacts, report);
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
