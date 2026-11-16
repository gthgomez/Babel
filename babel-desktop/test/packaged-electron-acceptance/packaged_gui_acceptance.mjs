// License: Apache-2.0
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {_electron as electron} from 'playwright';
import {parseBuildMetadata} from '../../native/identity.mjs';
import {HISTORY_SESSION_ID, assertAcceptanceSource, writePackagedAcceptanceProfile} from './packaged-fixture-lane.mjs';

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

/** Compare only the synthetic value in a separate installed CLI process. */
function checkInstalledSharedCredential(install, profile, env, connectionId, expected, missing = false) {
  const code = `import {readFileSync} from 'node:fs';
    const input=JSON.parse(readFileSync(0,'utf8'));
    try {
      const {createSharedConnectionService}=await import(input.module);
      const service=createSharedConnectionService({path:input.preferences});
      const value=service.read(input.connection,'openrouter');
      process.exitCode=!input.missing && value===input.expected ? 0 : 1;
    } catch(error) { process.exitCode=input.missing && error?.code==='MISSING' ? 0 : 1; }`;
  const cli = join(install,'resources','babel-runtime','cli');
  const child = spawnSync(join(install,'resources','babel-runtime','node','node.exe'), ['--input-type=module','-e',code], {
    input:JSON.stringify({module:pathToFileURL(join(cli,'dist','config','sharedConnectionService.js')).href,
      preferences:join(profile,'.babel','preferences.json'),connection:connectionId,expected,missing}),
    env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4096,
  });
  if (child.status !== 0) throw new Error(missing ? 'Installed CLI did not observe removal of the synthetic shared credential' : 'Installed CLI could not read the synthetic shared credential after restart');
}

/** Report only synthetic self-test and path-guard facts when the hosted store fails. */
function diagnoseInstalledWindowsCredentialBridge(install, env) {
  const code = `import {readFileSync,lstatSync,realpathSync} from 'node:fs';
    import {spawnSync} from 'node:child_process';
    import {join,resolve,sep} from 'node:path';
    const input=JSON.parse(readFileSync(0,'utf8'));
    const result={};
    try {
      const root=resolve(process.env.SystemRoot), exe=join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
      const temp=resolve(process.env.LOCALAPPDATA,'Temp'), profile=resolve(process.env.USERPROFILE);
      const same=path=>{try{return realpathSync(path).toLowerCase()===path.toLowerCase()}catch{return false}};
      result.guard={rootReal:same(root),executableReal:same(exe),tempReal:same(temp),
        tempInProfile:temp.toLowerCase().startsWith(profile.toLowerCase()+sep.toLowerCase()),
        executableFile:lstatSync(exe).isFile(),tempDirectory:lstatSync(temp).isDirectory()};
      const {createWindowsHelperRunner,createWindowsCredentialBackend}=await import(input.module);
      const run=createWindowsHelperRunner({systemRoot:root,helper:input.helper,temp,tmp:temp});
      const probe=(operation,runner=run)=>{const started=Date.now(), outcome=runner(JSON.stringify({operation,id:input.id}));let body={};try{body=JSON.parse(outcome.stdout)}catch{}
        return {status:outcome.status,timedOut:outcome.error?.code==='ETIMEDOUT',elapsedMs:Date.now()-started,ok:body.ok===true,missing:body.result===null};};
      result.selftest=probe('selftest');
      if(result.selftest.timedOut){const longer=createWindowsHelperRunner({systemRoot:root,helper:input.helper,temp,tmp:temp,
        invoke:(exe,args,options)=>spawnSync(exe,args,{...options,timeout:90000})});result.longerSelftest=probe('selftest',longer)}
      if(result.selftest.ok)result.rawGet=probe('get');
      if(result.rawGet?.ok && result.rawGet.missing){try{result.backendGet=createWindowsCredentialBackend().get(input.id)===null?'missing':'unexpected-entry'}catch{result.backendGet='unavailable'}}
    } catch {result.diagnostic='failed'}
    process.stdout.write(JSON.stringify(result));`;
  const cli=join(install,'resources','babel-runtime','cli');
  const child=spawnSync(join(install,'resources','babel-runtime','node','node.exe'),['--input-type=module','-e',code],{
    input:JSON.stringify({module:pathToFileURL(join(cli,'dist','config','sharedCredentialStore.js')).href,
      helper:join(cli,'dist','config','sharedCredential.windows.ps1'),id:randomUUID()}),
    env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4096,
  });
  try{return child.status===0?JSON.parse(child.stdout):{diagnostic:'process-failed',status:child.status}}catch{return {diagnostic:'invalid-result'}}
}

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
  const syntheticCredential = `BabelSyntheticFixture-${randomUUID()}`;

  try {
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
    errors.push(String(error?.message ?? error));
    const report = {passed: 0, checks, errors, identity, journeys, untestedJourneys};
    await writeReport(artifacts, report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const profilePath = join(tmpdir(), `babel-desktop-gui-${Date.now()}`);
  await mkdir(profilePath, {recursive: true});
  const profile = await realpath(profilePath);
  const fixtures = await writePackagedAcceptanceProfile(profile);
  identity.fixtureProjectRoot = fixtures.projectRoot;
  identity.fixtureMissingInstallId = fixtures.missingInstallId;

  let app;
  try {
    const launchEnv={...process.env};
    for(const name of Object.keys(launchEnv))if(/(?:API_KEY|TOKEN|SECRET)$/.test(name))delete launchEnv[name];
    delete launchEnv.BABEL_MODEL_POLICY_PATH;
    launchEnv.USERPROFILE=profile;launchEnv.HOME=profile;
    launchEnv.LOCALAPPDATA=join(profile,'AppData','Local');
    launchEnv.APPDATA=join(profile,'AppData','Roaming');
    launchEnv.BABEL_OFFLINE='1';
    await mkdir(join(launchEnv.LOCALAPPDATA,'Temp'),{recursive:true});
    await mkdir(launchEnv.APPDATA,{recursive:true});
    launchEnv.BABEL_OPENCODE_GO_HELPER=join(profile,'absent-fixture-helper.cjs');
    app = await electron.launch({
      executablePath: exe,
      args: [`--profile-dir=${profile}`],
      env:launchEnv,
      timeout: 120_000,
    });
    const window = await app.firstWindow();
    window.on('pageerror', error => errors.push(`pageerror: ${error?.message ?? error}`));
    window.on('console', message => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
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
    if (info.engine?.executionProfile === 'safe_repo' && info.engine?.readiness?.ready && info.diagnostics?.ready !== true) {
      throw new Error('safe_repo execution cannot be ready without verified diagnostics');
    }
    if (info.engine?.executionProfile !== 'safe_repo' && info.engine?.readiness?.ready !== true) {
      throw new Error('host-native readiness must not require sandbox diagnostics');
    }
    checks.push('fixture-backed project reports execution readiness appropriate to its profile (no model run)');
    journeys.project = {status: 'executed', transport: 'preload IPC getInfo + listDirectory'};

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

    const provider = await evaluateInPackagedWindow(window, async syntheticCredential => {
      const providers = await window.babelDesktop.listQualifiedProviders();
      const credential = await window.babelDesktop.providerCredentialStatus({provider:'openrouter',scope:'private'});
      const saved = await window.babelDesktop.saveProviderRoute({provider:'openrouter',model:'openrouter/fixture-model',
        scope:'private',binding:credential.binding,credentialOperation:'add_new',apiKey:syntheticCredential});
      const route = await window.babelDesktop.readProviderRoute();
      return {
        providers: providers.map(item=>item.id).sort(),
        saved: saved?.ok,
        savedProvider: saved?.route?.provider,
        routeProvider: route?.provider,
        routeModel: route?.model,
      };
    }, syntheticCredential);
    if (provider.providers.join(',') !== 'command-code,openrouter') throw new Error('installed provider list does not match the product policy');
    if (!provider.saved || provider.savedProvider !== 'openrouter' || provider.routeProvider !== 'openrouter' || provider.routeModel !== 'openrouter/fixture-model') {
      throw new Error(`provider route not persisted: ${JSON.stringify(provider)}`);
    }
    checks.push('approved provider route and synthetic protected credential save via IPC without a provider request');
    journeys.provider = {status: 'executed', note: 'synthetic credential; offline; no model call'};

    // Exercise the renderer save transition using the existing synthetic credential.
    await window.locator('[data-action="models"]').click();
    await window.locator('#credential-provider').selectOption('openrouter');
    await window.locator('#credential-model').selectOption('openrouter/fixture-model');
    await window.waitForFunction(()=>Boolean(document.querySelector('#credential-scope')?.dataset.binding));
    await window.locator('#dialog [data-action="save-provider-credential"]').click();
    await window.locator('#dialog').waitFor({state:'hidden',timeout:30_000});
    if (!await window.locator('#model-controls').innerText().then(text=>text.includes('Packaged acceptance fixture'))) throw new Error('Saved provider did not update renderer model selection');

    const harness = await connectLiveFromPackagedStartupDialog(window);
    if (!harness.connected) throw new Error('Installed history connection failed');
    journeys.connection = {status: 'executed', executionReady: info.engine?.readiness?.ready === true, docker: info.diagnostics?.docker ?? null};
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
    if (info.engine?.executionProfile === 'safe_repo' && info.diagnostics?.ready !== true) {
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

    await mkdir(artifacts, {recursive: true});
    await window.screenshot({path: join(artifacts, 'packaged-electron-window.png'), fullPage: true});
    checks.push('screenshots captured from packaged Electron window');

    // Only GitHub-hosted Windows runners provide the disposable OS identity
    // required for this real Credential Manager test. The native confirmation
    // is simulated as an explicit user acceptance inside this test process.
    if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
      await app.evaluate(({dialog}) => {
        dialog.showMessageBox = async (_window, options) => {
          if (options?.title !== 'Share this key with Babel CLI?' || !options?.buttons?.includes('Share with CLI')) throw new Error('Expected explicit shared-key confirmation');
          return {response:1,checkboxChecked:false};
        };
      });
      let receipt;
      const sharingStarted = Date.now();
      try {
        receipt = await evaluateInPackagedWindow(window, async () => {
          const status = await window.babelDesktop.providerCredentialStatus({provider:'openrouter',scope:'private'});
          if (!status.shareAvailable) throw new Error('Synthetic protected credential is not available to share');
          return window.babelDesktop.shareProviderCredential({provider:'openrouter',scope:'private',binding:status.binding});
        });
      } catch (error) {
        const elapsedMs = Date.now() - sharingStarted;
        const message = String(error?.message ?? '');
        const category = /Synthetic protected credential is not available to share/.test(message) ? 'private-credential-unavailable'
          : /OS-protected credential storage is unavailable or locked/.test(message) ? 'shared-store-unavailable' : 'other';
        throw new Error(`Shared credential setup failed (${category}) after ${elapsedMs}ms; isolated bridge diagnostics: ${JSON.stringify(diagnoseInstalledWindowsCredentialBridge(install,launchEnv))}`);
      }
      if (!receipt?.shared || !receipt.connectionId) throw new Error('Synthetic credential sharing was not confirmed');
      await app.close();
      app = await electron.launch({executablePath:exe,args:[`--profile-dir=${profile}`],env:launchEnv,timeout:120_000});
      const restartedWindow = await app.firstWindow();
      await waitForPackagedPreload(restartedWindow);
      const restarted = await evaluateInPackagedWindow(restartedWindow, async () => {
        return window.babelDesktop.providerCredentialStatus({provider:'openrouter',scope:'private'});
      });
      if (restarted.storage !== 'shared-os' || restarted.sharedReady !== null) throw new Error('Shared connection metadata did not restore as unverified after Desktop restart');
      checkInstalledSharedCredential(install,profile,launchEnv,receipt.connectionId,syntheticCredential);
      await evaluateInPackagedWindow(restartedWindow, async () => {
        const status = await window.babelDesktop.providerCredentialStatus({provider:'openrouter',scope:'private'});
        await window.babelDesktop.removeProviderCredential({provider:'openrouter',scope:'private',binding:status.binding});
      });
      checkInstalledSharedCredential(install,profile,launchEnv,receipt.connectionId,syntheticCredential,true);
      checks.push('isolated Windows shared credential survives Desktop and installed CLI process restarts and remains removed');
      journeys.sharedCredentialRestart = {status:'executed',note:'synthetic key; disposable hosted Windows identity; confirmation simulated; no provider request'};
    } else {
      journeys.sharedCredentialRestart = {status:'not run',note:'requires a disposable GitHub-hosted Windows identity'};
      untestedJourneys.push('shared Windows credential-store restart outside a disposable hosted runner');
    }
  } catch (error) {
    errors.push(String(error?.message ?? error));
  } finally {
    if (app) {
      try { await app.close(); }
      catch (error) { errors.push(`Owned Electron cleanup: ${error.message}`); }
    }
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
