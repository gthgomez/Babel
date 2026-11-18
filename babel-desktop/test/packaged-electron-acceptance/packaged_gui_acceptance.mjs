// License: Apache-2.0
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {_electron as electron} from 'playwright';
import {parseBuildMetadata} from '../../native/identity.mjs';
import {HISTORY_SESSION_ID, assertAcceptanceSource, assertFixtureTaskReceipt, assertReadOnlyDenial, buildPackagedLaunchEnvironment, writePackagedAcceptanceProfile} from './packaged-fixture-lane.mjs';
import {assertRepairBaseline, assertRepairComplete} from './packaged-repair-fixture.mjs';
import {startScriptedProvider} from './scripted-provider.mjs';
import {cleanupOwnedFixture} from './owned-cleanup.mjs';

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

/** Packaged startup opens BABEL SETUP over the footer; use the dialog chrome close control. */
async function dismissPackagedSetupDialog(window) {
  const dialog = window.locator('#dialog');
  const close = window.locator('#dialog [data-action="close-dialog"]');
  await close.click();
  // Closed <dialog> stays in the DOM without [open] but is not visible; do not waitForSelector visible.
  await dialog.waitFor({state: 'hidden', timeout: 15_000});
  const closed = await dialog.evaluate(el => !el.open);
  if (!closed) throw new Error('expected #dialog closed after close-dialog');
}

/**
 * Use the startup modal's harness control (never #preview-badge while #dialog is open).
 * @returns {Promise<{connected: boolean, reason?: string}>}
 */
async function connectLiveFromPackagedStartupDialog(window) {
  await window.waitForFunction(()=>document.querySelector('#preview-badge')?.textContent==='BABEL CLI', {timeout: 30_000});
  if (!await window.locator('#dialog').evaluate(el=>el.open)) return {connected:true};
  const title = await window.locator('#dialog-title').innerText();
  if (!title.includes('BABEL SETUP')) {
    throw new Error(`expected packaged startup BABEL SETUP dialog, got: ${title}`);
  }
  const useLive = window.locator('#dialog [data-action="use-live"]');
  await useLive.waitFor({state: 'visible', timeout: 15_000});
  const enabled = await useLive.isEnabled();
  if (!enabled) throw new Error('Connection/history must not require Docker readiness');
  await useLive.click();
  await window.locator('#dialog').waitFor({state: 'hidden', timeout: 15_000});
  if (!await window.locator('#dialog').evaluate(el => !el.open)) throw new Error('Setup dialog remained open');
  await window.locator('#preview-badge').waitFor({timeout: 30_000});
  const badge = await window.locator('#preview-badge').innerText();
  if (badge !== 'BABEL CLI') throw new Error(`expected BABEL CLI badge after harness, got: ${badge}`);
  return {connected: true};
}

const NAVIGATION_RETRY_MS = 60_000;

function isDestroyedContextError(error) {
  const msg = String(error?.message ?? error);
  return /Execution context was destroyed|most likely because of a navigation/i.test(msg);
}

/** Electron may reload once after first paint; retry evaluate until the preload bridge is stable. */
async function evaluateInPackagedWindow(window, pageFunction, arg) {
  const deadline = Date.now() + NAVIGATION_RETRY_MS;
  for (;;) {
    try {
      if (arg !== undefined) return await window.evaluate(pageFunction, arg);
      return await window.evaluate(pageFunction);
    } catch (error) {
      if (!isDestroyedContextError(error) || Date.now() >= deadline) throw error;
      await window.waitForLoadState('domcontentloaded', {timeout: 15_000}).catch(() => {});
      await window.waitForFunction(
        () => typeof window.babelDesktop?.getInfo === 'function',
        null,
        {timeout: 15_000},
      ).catch(() => {});
    }
  }
}

async function waitForPackagedPreload(window) {
  await window.waitForLoadState('load', {timeout: 60_000}).catch(() => {});
  await window.waitForFunction(
    () => typeof window.babelDesktop?.getInfo === 'function',
    null,
    {timeout: 60_000},
  );
}

/** Submit in the installed renderer and observe, but never synthesize, its native events. */
async function submitFixtureTask(window, {task, projectRoot, allowVerifier, expectedOutcome, expectedStatus}) {
  await window.locator('button.icon-button[data-action="new-session"]').click();
  await window.evaluate(() => {
    window.__packagedAcceptanceUnsubscribe?.();
    window.__packagedAcceptanceEvents = [];
    window.__packagedAcceptanceUnsubscribe = window.babelDesktop.onEvent(packet => {
      const event = packet?.event;
      window.__packagedAcceptanceEvents.push({kind: packet?.kind, code: packet?.code, displayLimited: packet?.displayLimited, type: event?.type,
        tool: event?.item?.tool, detail: event?.item?.detail, command: event?.item?.command,
        cwd: event?.item?.cwd, outcome: event?.result?.terminal_outcome, userStatus: event?.result?.user_status,
        verification: event?.result?.verification?.status, approvalRequired: event?.result?.approval_required});
    });
  });
  await window.locator('#composer-input').fill(task);
  await window.locator('#send-button').click();
  const deadline = Date.now() + 120_000;
  let approvals = 0;
  for (;;) {
    const events = await window.evaluate(() => window.__packagedAcceptanceEvents);
    const exit = events.find(event => event.kind === 'exit');
    if (exit) {
      assertFixtureTaskReceipt(events, expectedOutcome);
      await window.waitForFunction(() => !document.querySelector('#send-button')?.disabled, null, {timeout: 15_000});
      await window.locator(`.assistant-message .message-status.${expectedStatus}`).last().waitFor({timeout: 15_000});
      return {events, approvals};
    }
    if (await window.locator('.assistant-message .message-status.failed').count()) throw new Error('fixture task failed before a clean exit');
    const allow = window.locator('.approval-card [data-action="approve-run"]');
    if (await allow.count()) {
      const approval = [...events].reverse().find(event => event.type === 'approval.required');
      const key = path => resolve(path).toLowerCase();
      if (!allowVerifier || approval?.command !== 'npm test' || typeof approval.cwd !== 'string' ||
          key(approval.cwd) !== key(projectRoot) || !await allow.isEnabled()) {
        throw new Error('unexpected fixture approval request');
      }
      await allow.click(); approvals++;
      await allow.waitFor({state: 'detached', timeout: 15_000});
    }
    if (Date.now() >= deadline) throw new Error('fixture task timed out');
    await window.waitForTimeout(250);
  }
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
        'installed Desktop repair and read-only task execution',
        'interactive NSIS installer failure dialog (hosted lane launches installed exe only)',
      ],
    };
    await writeReport(artifacts, report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const checks = [];
  const errors = [];
  const identity = {};
  let exe;
  let failure = null;

  try {
    const installRoot = process.env.BABEL_DESKTOP_INSTALL_ROOT;
    if (!installRoot) throw new Error('BABEL_DESKTOP_INSTALL_ROOT is required');
    const install = resolve(installRoot);
    exe = join(install, 'Babel Desktop.exe');
    const buildPath = join(install, 'BUILD.json');
    identity.installRoot = install;
    identity.executable = exe;
    await stat(exe);
    identity.executablePresent = true;
    const buildText = await readFile(buildPath, 'utf8');
    identity.build = parseBuildMetadata(buildText);
    identity.executableSha256 = createHash('sha256').update(await readFile(exe)).digest('hex');
    const expectedSha = String(process.env.BABEL_DESKTOP_SOURCE_SHA || '').trim();
    assertAcceptanceSource(identity.build, expectedSha);
    if (expectedSha && identity.build?.sourceSha) {
      if (identity.build.sourceSha.toLowerCase() !== expectedSha.toLowerCase()) {
        throw new Error(`BUILD.json sourceSha ${identity.build.sourceSha} != checkout ${expectedSha}`);
      }
      checks.push('BUILD.json sourceSha matches CI checkout');
    }
    checks.push('installed executable and BUILD.json identity verified on disk');
  } catch (error) {
    const reason = String(error?.message ?? error);
    errors.push(reason);
    failure = {stage: 'artifact-preflight', reason};
    const report = {passed: 0, checks, errors, failure, identity, journeys, untestedJourneys};
    await writeReport(artifacts, report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  let profile;
  let app;
  let window;
  let provider;
  let launchProcess;
  let launchAttempted = false;
  let launchExited = false;
  let launchExit;
  let taskMayBeActive = false;
  let retainedProvider = null;
  let providerStartupFailure = null;
  let stage = 'fixture-preflight';
  try {
    profile = await mkdtemp(join(tmpdir(), 'babel-desktop-gui-'));
    const fixtures = await writePackagedAcceptanceProfile(profile);
    identity.fixtureProjectRoot = fixtures.projectRoot;
    identity.fixtureMissingInstallId = fixtures.missingInstallId;
    journeys.repairBaseline = {status: 'executed', ...await assertRepairBaseline(fixtures.projectRoot)};
    checks.push('independent repair fixture starts with four failing cases and a clean Git tree');
    // The test server owns 127.0.0.1:11434 before the packaged process can run.
    provider = await startScriptedProvider();
    const launchEnv = buildPackagedLaunchEnvironment(process.env, profile);
    stage = 'installed-launch';
    launchAttempted = true;
    app = await electron.launch({
      executablePath: exe,
      args: [`--profile-dir=${profile}`],
      env:launchEnv,
      timeout: 120_000,
    });
    launchProcess = app.process();
    launchExit = new Promise(resolveExit => {
      if (launchProcess.exitCode !== null || launchProcess.signalCode !== null) { launchExited = true; resolveExit(); }
      else launchProcess.once('exit', () => { launchExited = true; resolveExit(); });
    });
    stage = 'render';
    window = await app.firstWindow();
    window.on('pageerror', error => { errors.push(`pageerror: ${error?.message ?? error}`); failure ??= {stage: 'render', reason: 'renderer page error'}; });
    window.on('console', message => {
      if (message.type() === 'error') { errors.push(`console: ${message.text()}`); failure ??= {stage: 'render', reason: 'renderer console error'}; }
    });
    await waitForPackagedPreload(window);

    const info = await evaluateInPackagedWindow(window, async () => {
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
      executionReady: info?.diagnostics?.ready,
      docker: info?.diagnostics?.docker,
      engineReadinessReady: info?.engine?.readiness?.ready,
      projectName: info?.projectName,
    };
    if (info?.preloadMissing) throw new Error('window.babelDesktop.getInfo is unavailable (preload not wired)');
    if (info.packaged !== true) throw new Error(`getInfo().packaged expected true, got ${info.packaged}`);
    if (info.officialCliReady !== true) throw new Error('packaged install must report officialCliReady true');
    if (info.runtimeSource !== 'bundled') throw new Error('Missing selected install must resolve through actual bundled runtime fallback');
    if (info.engine?.origin !== 'bundled') throw new Error(`engine.origin expected bundled, got ${info.engine?.origin}`);
    if (identity.build?.sourceSha && info.engine?.source?.commitSha !== identity.build.sourceSha) {
      throw new Error('engine.source.commitSha must match BUILD.json sourceSha');
    }
    checks.push('preload IPC getInfo reports packaged bundled engine');
    await window.waitForSelector('#preview-badge', {timeout: 30_000});
    const badge = await window.locator('#preview-badge').innerText();
    if (badge !== 'BABEL CLI') throw new Error(`unexpected harness badge: ${badge}`);
    if (await window.locator('.reference-answer').count()) throw new Error('Packaged app must not show a simulated reference conversation');
    checks.push('renderer starts on the real harness without simulated reference content');

    if (info.ready !== true || info.projectName !== 'acceptance-project') {
      throw new Error(`fixture project not connected (ready=${info.ready}, project=${info.projectName})`);
    }
    if (info.engine?.readiness?.ready !== (info.diagnostics?.ready === true)) {
      throw new Error('engine.readiness.ready must match verified execution prerequisites for the connected fixture project');
    }
    checks.push('fixture-backed project connects with truthful ready state (no model run)');
    journeys.project = {status: 'executed', transport: 'preload IPC getInfo + listDirectory'};

    stage = 'project-and-history-transport';
    const tree = await evaluateInPackagedWindow(window, async () => {
      const entries = await window.babelDesktop.listDirectory('.');
      return entries.map(entry => entry.name);
    });
    if (!tree.includes('README.md')) throw new Error('fixture project tree missing README.md');
    checks.push('listDirectory IPC reads the fixture project through main process');
    journeys.projectTree = {status: 'executed'};

    const historyIpc = await evaluateInPackagedWindow(window, async sessionId => {
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

    stage = 'provider-configuration';
    const providerRoute = await evaluateInPackagedWindow(window, async () => {
      const providers = await window.babelDesktop.listQualifiedProviders();
      const saved = await window.babelDesktop.saveProviderRoute({provider: 'ollama', model: 'ollama/local-fixture'});
      const route = await window.babelDesktop.readProviderRoute();
      return {
        providerCount: providers.length,
        savedProvider: saved?.route?.provider,
        routeProvider: route?.provider,
        routeModel: route?.model,
      };
    });
    if (providerRoute.providerCount < 1) throw new Error('listQualifiedProviders returned no providers');
    if (providerRoute.savedProvider !== 'ollama' || providerRoute.routeProvider !== 'ollama') {
      throw new Error(`provider route not persisted: ${JSON.stringify(providerRoute)}`);
    }
    checks.push('provider route saves via IPC without API credentials (ollama local route)');
    journeys.provider = {status: 'executed', note: 'route-only; no credential file or model call'};

    // Exercise the renderer save transition too; this profile has a synthetic local catalog only.
    await window.locator('[data-action="models"]').click();
    await window.locator('#credential-provider').selectOption('ollama');
    await window.locator('#credential-model').selectOption('ollama/local-fixture');
    await window.locator('#dialog [data-action="save-provider-credential"]').click();
    await window.locator('#dialog').waitFor({state:'hidden',timeout:30_000});
    if (!await window.locator('#model-controls').innerText().then(text=>text.includes('Local acceptance fixture'))) throw new Error('Saved provider did not update renderer model selection');

    stage = 'history-render';
    const harness = await connectLiveFromPackagedStartupDialog(window);
    if (!harness.connected) throw new Error('Installed history connection failed');
    journeys.connection = {status: 'executed', executionReady: info.diagnostics?.ready === true, docker: info.diagnostics?.docker ?? null};
    {
      checks.push('startup automatically connects the real harness; incomplete setup remains accessible');
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
      if (await conv.locator('text=m-009').count()) throw new Error('latest view should not include m-009');
      checks.push('renderer history navigation latest→older→latest on installed transport');
      journeys.historyUi = {status: 'executed'};
    }
    const selection = JSON.parse(await readFile(join(profile, 'engine', 'active-engine.json'), 'utf8'));
    if (selection.id !== fixtures.missingInstallId) throw new Error('Read-only fallback must preserve the missing engine selection on disk');
    journeys.engineFallback = {status: 'executed', missingInstallId: fixtures.missingInstallId, origin: info.engine.origin, runtimeSource: info.runtimeSource, selectionPreserved: true, note: 'Read-only history; no task execution.'};
    journeys.readOnlyHistoryControl = {status: 'executed', ...await assertRepairBaseline(fixtures.projectRoot),
      note: 'History and project browsing only; this is not a submitted read-only task.'};
    checks.push('read-only history and project browsing leave the independent repair baseline unchanged');
    const currentInfo = await evaluateInPackagedWindow(window, () => window.babelDesktop.getInfo());
    if (currentInfo.diagnostics?.ready !== true) {
      if (!await window.locator('#send-button').isDisabled()) throw new Error('Execution must remain blocked without ready diagnostics');
      journeys.executionAdmission = {status: 'blocked correctly', note: 'No task execution.'};
    }
    await mkdir(artifacts, {recursive: true});
    await window.screenshot({path: join(artifacts, 'packaged-electron-history.png'), fullPage: true});

    await window.locator('[data-action="settings"]').click();
    await window.locator('[data-action="configure-provider"]').click();
    await window.waitForSelector('#dialog-title', {timeout: 15_000});
    const dialogTitle = await window.locator('#dialog-title').innerText();
    if (!dialogTitle.includes('PROVIDERS AND MODELS')) throw new Error(`unexpected provider dialog: ${dialogTitle}`);
    await window.locator('#dialog [data-action="close-dialog"].button').click();
    checks.push('provider configuration dialog opens from settings on installed renderer');
    journeys.providerUi = {status: 'executed', note: 'dialog open/cancel only; no credential entry'};

    stage = 'execution-admission';
    if (currentInfo.diagnostics?.ready !== true) throw new Error('installed project execution prerequisites are unavailable');
    stage = 'read-only-task';
    provider.selectScenario('readOnly');
    taskMayBeActive = true;
    const readOnly = await submitFixtureTask(window, {task: 'Review parser.mjs and explain its defect. Do not modify files.',
      projectRoot: fixtures.projectRoot, allowVerifier: false, expectedOutcome: 'NO_CHANGE_REQUIRED', expectedStatus: 'no_change'});
    taskMayBeActive = false;
    assertReadOnlyDenial(readOnly.events);
    if (!readOnly.events.some(event => event.type === 'run_complete' && event.outcome === 'NO_CHANGE_REQUIRED')) throw new Error('read-only task did not complete with no change required');
    await provider.waitForCounts(3, 0);
    journeys.readOnlyTask = {status: 'executed', terminal: 'NO_CHANGE_REQUIRED', deniedEdit: true,
      baseline: await assertRepairBaseline(fixtures.projectRoot)};
    checks.push('installed renderer submits a read-only task and runtime denies a scripted edit');
    await window.screenshot({path: join(artifacts, 'packaged-electron-read-only.png'), fullPage: true});

    stage = 'repair-task';
    provider.selectScenario('repair');
    taskMayBeActive = true;
    const repair = await submitFixtureTask(window, {task: 'Investigate why parser_test fails and fix it.\nRequirements:\n- `npm test` passes.',
      projectRoot: fixtures.projectRoot, allowVerifier: true, expectedOutcome: 'VERIFIED_COMPLETE', expectedStatus: 'complete'});
    taskMayBeActive = false;
    if (!repair.events.some(event => event.type === 'run_complete' && event.outcome === 'VERIFIED_COMPLETE')) throw new Error('repair task did not report verified completion');
    await provider.waitForCounts(5, 0);
    stage = 'independent-oracle';
    const independent = await assertRepairComplete(fixtures.projectRoot);
    journeys.repair = {status: 'executed', terminal: 'VERIFIED_COMPLETE', approvals: repair.approvals, independent};
    checks.push('installed renderer completes the repair with independent passing behavior and scoped Git diff');
    await window.screenshot({path: join(artifacts, 'packaged-electron-repair.png'), fullPage: true});
    stage = 'screenshots';

    await mkdir(artifacts, {recursive: true});
    await window.screenshot({path: join(artifacts, 'packaged-electron-window.png'), fullPage: true});
    checks.push('screenshots captured from packaged Electron window');
  } catch (error) {
    if (!provider && error?.diagnostic?.cleanup === 'unresolved') providerStartupFailure = error;
    const reason = String(error?.message ?? error);
    errors.push(`${stage}: ${reason}`);
    failure ??= {stage, reason, ...(provider ? {provider: provider.snapshot()} : {})};
    if (window) {
      try {
        await mkdir(artifacts, {recursive: true});
        await window.screenshot({path: join(artifacts, 'packaged-electron-failure.png'), fullPage: true});
      } catch { errors.push('Failure screenshot unavailable'); }
    }
  } finally {
    const cleanup = await cleanupOwnedFixture({
      startupFailure: providerStartupFailure,
      settleTurn: async () => {
        if (!taskMayBeActive) return;
        if (!window) throw new Error('No renderer for active task');
        const alreadyExited = await window.evaluate(() => window.__packagedAcceptanceEvents?.some(event => event.kind === 'exit') === true);
        if (!alreadyExited) {
          const stop = window.locator('.stop-button[data-action="stop"]');
          if (!await stop.isVisible()) throw new Error('Stop control is unavailable');
          await stop.click({timeout: 5_000});
          await window.waitForFunction(() => window.__packagedAcceptanceEvents?.some(event => event.kind === 'exit') === true,
            null, {timeout: 20_000});
        }
      },
      terminateTree: async () => {
        if (!app) return !launchAttempted;
        // Never signal a PID after the captured launcher has already exited.
        if (!launchProcess?.pid || launchExited || launchProcess.exitCode !== null || launchProcess.signalCode !== null) return false;
        const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
        const killed = spawnSync(join(windowsRoot, 'System32', 'taskkill.exe'), ['/PID', String(launchProcess.pid), '/T', '/F'],
          {windowsHide: true, stdio: 'ignore', timeout: 10_000});
        if (killed.status !== 0) return false;
        let timer;
        try {
          return await Promise.race([launchExit.then(() => true), new Promise(resolveExit => { timer = setTimeout(() => resolveExit(false), 10_000); })]);
        } finally { clearTimeout(timer); }
      },
      releaseProvider: async () => { if (provider) await provider.close(); },
      retainProvider: () => { if (provider) retainedProvider = provider.retain(); },
      removeProfile: async () => { if (profile) await rm(profile, {recursive: true, force: true}); },
      profileAbsent: async () => {
        if (!profile) return true;
        try { await lstat(profile); return false; }
        catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
      },
    });
    journeys.cleanup = {...cleanup, ...(retainedProvider ? {retainedProviderPid: retainedProvider.pid} : {})};
    if (cleanup.state !== 'terminated' || !cleanup.turnSettled || cleanup.errors?.length) {
      errors.push('Owned fixture cleanup did not settle completely');
      failure ??= {stage: 'cleanup', reason: 'owned process tree or fixture cleanup is unresolved'};
    }
  }

  untestedJourneys.push(
    'live-provider task execution and authentication',
    'chooseProject native open-directory dialog automation',
    'interactive NSIS installer failure dialog visibility (lifecycle exercises corrupt payload rejection without Electron UI)',
  );
  if (!journeys.readOnlyTask) journeys.readOnlyTask = {status: 'not completed', stage};
  if (!journeys.repair) journeys.repair = {status: 'not completed', stage};
  journeys.installerInteractiveFailure = {
    status: 'blocked',
    reason: 'NSIS interactive failure surface is not exposed to Playwright; corrupt upgrade is validated in run-lifecycle.ps1 step 6 only',
  };

  const report = {
    passed: errors.length ? 0 : checks.length,
    basis: 'Installed Babel Desktop.exe via Playwright _electron.launch({ executablePath }) with fixture profile',
    checks,
    errors,
    failure,
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
