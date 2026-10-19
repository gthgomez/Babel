import {modeUnavailableReason} from '../src/core.mjs';
import {app,BrowserWindow,clipboard,dialog,ipcMain,protocol,session,shell,Tray,Menu,safeStorage} from 'electron';
import {writeClipboardText} from './clipboard.mjs';
import {readFileSync} from 'node:fs';
import {readFile,writeFile,rename,mkdir,stat,realpath} from 'node:fs/promises';
import {basename,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BabelChild,buildRunArgs,EXECUTION_PROFILE} from './child.mjs';
import {SharedProtocolRun} from './sharedProtocolRun.mjs';
import {RemoteBridgeChild,releaseBridgeIfCurrent} from './remoteHost.mjs';
import {listDirectory,readProjectFile} from './workspace.mjs';
import {readProjectDiff} from './project-diff.mjs';
import {ProjectAuthority,inspectProjectIdentity} from './project-authority.mjs';
import {APP_URL,REPOSITORY_URL,isAppUrl,parsePreferences} from './security.mjs';
import {resolveOfficialCli,bundledEnvironment} from './runtime.mjs';
import {diagnoseRuntime} from './diagnostics.mjs';
import {applySandboxEnvironment,configureSandboxImage,RECOMMENDED_IMAGE} from './sandbox-setup.mjs';
import {configureCredentialProtection,hasProviderCredential,saveProviderCredential,providerCredentialStatus,removeProviderCredential,migrateProviderCredential} from './credentials.mjs';
import {saveDesktopProviderRoute} from './provider-route-save.mjs';
import {assertCredentialEngineCapability} from './credential-engine.mjs';
import {applyProjectCredentialScope,applySelectedModelEnvironment,applyOwnedCliCredentialEnvironment} from './childEnv.mjs';
import {resolveEngineIdentity} from './identity.mjs';
import {createGitRunner,createStepRunner,inspectDevelopmentCheckout,planDevelopmentUpdate,precheckSafety,resolveNpmInvocation,runDevelopmentUpdate,runDevelopmentRebuild,compareReleaseVersion,EXPECTED_ORIGIN} from './updater.mjs';
import {parseBuildMetadata} from './identity.mjs';
import {readActiveEngine, writeActiveEngine} from './engine-manager.mjs';
import {checkPackagedCliUpdate, installPreviewSourceBuild, installStableReleaseArchive, resolveBundledNpmCli} from './engine-artifact.mjs';
import {qualifiedProviders, readProviderRoute, saveProviderRoute, validateProviderRoute,refreshModelCatalog} from './provider-routing.mjs';
import {listSavedChats,readSavedChat,searchSavedChats,readSavedMessage} from './sessions.mjs';
import {ComposerDraftStore,composerDraftScope} from './composer-drafts.mjs';
import {CLOSE_GRACE_MS,decideLastWindow,decideWindowClose,createCloseRequest} from './lifecycle.mjs';
import {readBridgeHostAuthToken} from './bridge-host-token.mjs';

const packageRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const profileArgument=process.argv.find(arg=>arg.startsWith('--profile-dir='));
if(profileArgument){
  const profile=profileArgument.slice('--profile-dir='.length);
  if(!isAbsolute(profile))throw new Error('--profile-dir must be an absolute directory');
  app.setPath('userData',profile);
}
const officialRuntime=()=>resolveOfficialCli(packageRoot,{isPackaged:app.isPackaged,resourcesPath:process.resourcesPath,userData:app.getPath('userData')});
function bundledBuildRecord(){
  if(!app.isPackaged)return null;
  try{return parseBuildMetadata(readFileSync(join(process.resourcesPath,'..','BUILD.json'),'utf8'));}catch{return null;}
}
function runtimeEnvironment({credentials=false}={}) {
  const profile=join(app.getPath('userData'),'engine','config');
  const env=app.isPackaged?bundledEnvironment(app.getPath('userData')):{...process.env,ELECTRON_RUN_AS_NODE:'1',BABEL_CONFIG_DIR:profile};
  // Project keys are never loaded merely because a repository contains .env.
  applyProjectCredentialScope(env,{projectCredentialRoot:preferences.projectCredentialRoot,projectRoot:preferences.projectRoot,configDirectory:profile});
  if(credentials)applyOwnedCliCredentialEnvironment(env,{configDirectory:profile,projectCredentialRoot:preferences.projectCredentialRoot,projectRoot:preferences.projectRoot});
  return applySandboxEnvironment(env,preferences);
}
async function ownedCliEnvironment(){
  await assertCredentialEngineCapability({...officialRuntime(),path:activeCliEntry()});
  const root=preferences.projectRoot;
  if(root&&preferences.projectCredentialRoot===root){
    const admission=await projectAuthority.admit(root);
    if(preferences.projectRoot!==root||!projectAuthority.isCurrent(admission))throw new Error('Project authority changed before credential resolution.');
  }
  return runtimeEnvironment({credentials:true});
}
let diagnostics=null;
let window=null;
let tray=null;
let backgroundStatus='Babel is working';
let closingWindow=false;
let closeFinished=false;
let finishingClose=false;
let composerDrafts=null;
let draftCloseRequest=null;
let draftCloseReady=false;
let preferences={cliEntry:null,projectRoot:null,projectCredentialRoot:null};
let runner=null;
let projectAuthority=null;
let runAuthority=null;
let remoteBridge=null;
let runAdmission=false;
let runAdmissionEpoch=0;
let remoteAdmissionEpoch=0;
let dialogBusy=false;
let updateBusy=false;
let connectionChangeBusy=false;
let cliUpdate={state:'unchecked'};
let preferencePath;
function remoteBlocksLocalRunAdmission(){
  return Boolean(remoteBridge?.running&&!remoteBridge?.sharedSession);
}
function busy(){
  return Boolean(
    runAdmission||
    runner?.busy||
    remoteBridge?.running||
    updateBusy||
    connectionChangeBusy,
  );
}
function assertRunAdmissionIdle(){
  if(runAdmission||runner?.busy||remoteBlocksLocalRunAdmission()||updateBusy||connectionChangeBusy){
    throw new Error('Wait for the current Babel run to finish before starting another.');
  }
}

protocol.registerSchemesAsPrivileged([{scheme:'babel',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const singleInstance=app.requestSingleInstanceLock();
if(!singleInstance) app.quit();
else {
  app.on('second-instance',showWindow);
  app.whenReady().then(()=>{configureCredentialProtection(safeStorage);return start();}).catch(error=>{
    dialog.showErrorBox('Babel Desktop could not start',error.message);
    app.quit();
  });
}
async function savePreferences(){
  await mkdir(dirname(preferencePath),{recursive:true});
  // Non-secret UI/runtime preferences only: never keys, messages or sessions.
  const next=`${preferencePath}.next`;
  await writeFile(next,JSON.stringify(parsePreferences(preferences)),{mode:0o600});
  await rename(next,preferencePath);
}
function activeCliEntry(){
  if(!app.isPackaged&&preferences.cliEntry) return preferences.cliEntry;
  const official=officialRuntime();
  return official.ready?official.path:null;
}
function cliPackageDir(){const entry=activeCliEntry();return entry?dirname(dirname(entry)):null;}
function cliCheckoutRoot(){const dir=cliPackageDir();return dir?dirname(dir):null;}
async function getInfo(){
  const official=officialRuntime();
  const cliEntry=activeCliEntry();
  let ready=false;
  let scope={scope:preferences.projectRoot?'project':'conversation',trusted:false,identity:null,reason:null};
  try{scope=await projectAuthority.inspect(preferences.projectRoot);}catch{scope.reason='Project identity is unavailable. Select and verify the project again.';}
  try{ready=Boolean(cliEntry&&(!preferences.projectRoot||scope.trusted)&&(await stat(cliEntry)).isFile());}catch{}
  if(app.isPackaged&&preferences.projectRoot&&!diagnostics){
    try{diagnostics=await diagnoseRuntime(official,{env:await ownedCliEnvironment(),cwd:app.getPath('userData')});}
    catch{diagnostics={ready:false,provider:'unavailable',error:'Credential storage or project authority is unavailable. Review provider settings and project trust.'};}
  }
  const engine=resolveEngineIdentity({
    isPackaged:app.isPackaged,resourcesPath:process.resourcesPath,desktopVersion:app.getVersion(),
    cliEntry,official,advancedEntry:Boolean(!app.isPackaged&&preferences.cliEntry),ready,
    executionProfile:EXECUTION_PROFILE,diagnostics,update:cliUpdate,requiresSandbox:Boolean(preferences.projectRoot),
  });
  if(official.engineId&&official.engineId!=='bundled') engine.activeEngineId=official.engineId;
  return {
    cliName:cliEntry?basename(cliEntry):null,
    projectName:preferences.projectRoot?basename(preferences.projectRoot):null,
    projectRoot:preferences.projectRoot,
    projectAuthority:scope,
    ready,
    officialCliLabel:official.label,
    officialCliReady:official.ready,
    runtimeSource:!app.isPackaged&&preferences.cliEntry?'advanced':official.ready?official.source:'missing',
    packaged:app.isPackaged,
    diagnostics,
    engine,
    sandbox:{image:runtimeEnvironment().BABEL_BENCHMARK_DOCKER_IMAGE??null,reference:preferences.sandboxImageReference??runtimeEnvironment().BABEL_BENCHMARK_DOCKER_IMAGE??null,recommended:RECOMMENDED_IMAGE},
    configDirectory:runtimeEnvironment().BABEL_CONFIG_DIR,
    projectCredentialsSelected:preferences.projectCredentialRoot===preferences.projectRoot && Boolean(preferences.projectRoot),
    remoteBridge:remoteBridge
      ? {
          running:remoteBridge.state==='ready',
          state:remoteBridge.state,
          port:remoteBridge.port,
          url:remoteBridge.port?`http://127.0.0.1:${remoteBridge.port}`:null,
          blocksLocalRuns:remoteBridge.sharedSession
            ? false
            : remoteBridge.state==='ready' || remoteBridge.state==='starting',
          sharedSession:Boolean(remoteBridge.sharedSession),
          desktopClientId:remoteBridge.desktopClientId??null,
        }
      : {running:false,state:'stopped',port:null,url:null,blocksLocalRuns:false,sharedSession:false,desktopClientId:null},
  };
}
const credentialBindings=new Map();
async function credentialRequestContext(options,bound=false){
  if(!options||typeof options!=='object'||!['private','project'].includes(options.scope))throw new Error('Select an explicit credential destination.');
  const context={provider:options.provider,scope:options.scope,configDirectory:runtimeEnvironment().BABEL_CONFIG_DIR,projectRoot:preferences.projectRoot};
  const generation=projectAuthority.generation;
  if(bound){
    const previous=credentialBindings.get(options.binding);
    if(!previous||previous.provider!==context.provider||previous.scope!==context.scope||previous.configDirectory!==context.configDirectory||previous.projectRoot!==context.projectRoot||previous.generation!==generation)throw new Error('Credential destination changed. Reopen provider settings and retry.');
  }
  if(context.scope==='project'){
    const admission=await projectAuthority.admit(context.projectRoot);
    if(preferences.projectRoot!==context.projectRoot||generation!==projectAuthority.generation||!projectAuthority.isCurrent(admission))throw new Error('Project authority changed. Reopen provider settings and retry.');
  }
  return context;
}
function validateSender(event){
  if(!window||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!isAppUrl(event.senderFrame.url)) throw new Error('Rejected an untrusted desktop request');
}
const UPDATE_BLOCK={no_source_checkout:'No source checkout is selected for the CLI.',not_a_git_checkout:'The selected CLI is not inside a Git checkout; source updates are unavailable.',untrusted_remote:'The origin remote is not the expected Babel repository.',detached_head:'The checkout is on a detached HEAD; check out a branch first.',local_modifications:'The checkout has uncommitted changes; commit or stash them first.',local_commits_ahead:'Local commits are ahead of the upstream; resolve them manually.',no_upstream_observed:'No tracked upstream branch was observed.',already_current:'This CLI already matches the tracked upstream.',fetch_failed:'Fetching the trusted upstream failed.',fast_forward_failed:'The fast-forward was refused; the checkout may have diverged.',dependency_install_failed:'Installing locked dependencies failed.',build_failed:'Rebuilding the CLI failed.',version_mismatch:'The rebuilt CLI reported an unexpected version; the previous build was restored.',missing_entry:'The rebuilt CLI entry point is missing; the previous build was restored.',version_check_failed:'The rebuilt CLI could not be validated; the previous build was restored.'};
function updateBlockMessage(reason){return UPDATE_BLOCK[reason]??`Update refused: ${reason}.`;}
function publicInspection(inspection){
  if(!inspection?.ok) return {ok:false,blocker:inspection?.blocker??'not_inspected'};
  return {ok:true,repoRoot:inspection.repoRoot,remoteSlug:inspection.remoteSlug,trusted:inspection.trusted,branch:inspection.branch,detached:inspection.detached,head:inspection.head,upstream:inspection.upstream,upstreamRef:inspection.upstreamRef,dirty:inspection.dirty,ahead:inspection.ahead,behind:inspection.behind};
}
function updateStateFromInspection(inspection){
  if(!inspection?.ok) return {state:'unsupported',channel:'development',detail:updateBlockMessage(inspection?.blocker??'not_inspected')};
  const plan=planDevelopmentUpdate(inspection);
  if(plan.allowed) return {state:'available',channel:'development',currentSha:inspection.head,availableSha:plan.incomingSha,detail:`${plan.incomingCount} incoming commit(s) on ${inspection.upstreamRef}`};
  if(plan.reason==='already_current') return {state:'current',channel:'development',currentSha:inspection.head,availableSha:inspection.head,detail:'No newer source was observed for the tracked upstream.'};
  return {state:plan.reason==='untrusted_remote'?'unsupported':'error',channel:'development',currentSha:inspection.head,availableSha:null,detail:updateBlockMessage(plan.reason)};
}
async function checkPackagedUpdate(){
  const active=readActiveEngine(app.getPath('userData'))??{id:'bundled',channelPreference:'stable'};
  const build=bundledBuildRecord();
  try{
    const result=await checkPackagedCliUpdate({userData:app.getPath('userData'),channel:active.channelPreference,bundledSourceSha:build?.sourceSha??null});
    cliUpdate={
      state:result.state??'error',
      channel:result.channel??active.channelPreference,
      currentSha:result.currentSha??build?.sourceSha??null,
      availableSha:result.availableSha??null,
      detail:result.detail??'',
      candidate:result.candidate??null,
    };
  }catch{
    cliUpdate={state:'error',channel:active.channelPreference,detail:'The CLI update check failed. Verify network access and retry.'};
  }
  return {...cliUpdate};
}
async function checkReleaseUpdate(){
  const current=app.getVersion();
  try{
    const response=await fetch(`https://api.github.com/repos/${EXPECTED_ORIGIN}/releases/latest`,{headers:{'User-Agent':'Babel-Desktop','Accept':'application/vnd.github+json'},signal:AbortSignal.timeout(8000)});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const body=await response.json();
    const latest=typeof body?.tag_name==='string'?body.tag_name:'';
    const result=compareReleaseVersion(latest,current);
    return {state:result.state,channel:'release',detail:result.detail};
  }catch{
    return {state:'error',channel:'release',detail:'The Desktop release check failed. Verify network access and retry.'};
  }
}
function handle(channel,fn){ipcMain.handle(channel,async(event,...args)=>{validateSender(event);return fn(...args);});}
async function withNativeDialog(fn){
  if(dialogBusy) throw new Error('Another native dialog is already open');
  dialogBusy=true;
  try{return await fn();}finally{dialogBusy=false;}
}
function assertIdle(){if(busy())throw new Error('Wait for the current Babel run to finish before changing its connection');}
async function withConnectionChange(fn){
  assertIdle();
  connectionChangeBusy=true;
  try{return await fn();}finally{connectionChangeBusy=false;}
}
async function start(){
  await mkdir(app.getPath('userData'),{recursive:true});
  preferencePath=join(app.getPath('userData'),'ui-connection.json');
  try{
    if((await stat(preferencePath)).size<16384) preferences=parsePreferences(JSON.parse(await readFile(preferencePath,'utf8')));
  }catch{/* Missing/invalid UI preferences never block startup. */}
  projectAuthority=await ProjectAuthority.open(join(app.getPath('userData'),'project-authority.json'));
  const html=await readFile(join(packageRoot,'dist','index.html'),'utf8');
  protocol.handle('babel',request=>isAppUrl(request.url)?new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'}}):new Response('Not found',{status:404}));
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  handle('babel:get-info',getInfo);
  handle('babel:copy-text',text=>writeClipboardText(clipboard,text));
  composerDrafts=new ComposerDraftStore(app.getPath('userData'));
  handle('babel:read-composer-drafts',()=>composerDrafts.read(composerDraftScope(preferences.projectRoot)));
  handle('babel:write-composer-drafts',request=>composerDrafts.write(composerDraftScope(preferences.projectRoot),request));
  handle('babel:complete-draft-close',request=>{
    if(!draftCloseRequest||request?.token!==draftCloseRequest.token)return {accepted:false};
    draftCloseRequest.finish(request.saved===true);return {accepted:true};
  });
  handle('babel:refresh-diagnostics',async()=>{assertIdle();diagnostics=null;return getInfo();});
  handle('babel:configure-sandbox',async options=>withConnectionChange(async()=>{
    if(!options||typeof options!=='object')throw new Error('Invalid sandbox setup request.');
    const configured=await configureSandboxImage({reference:options.reference,prepareRecommended:options.prepareRecommended??false});
    const previous={sandboxImage:preferences.sandboxImage,sandboxImageReference:preferences.sandboxImageReference};
    Object.assign(preferences,configured);
    try{await savePreferences();}catch(error){Object.assign(preferences,previous);throw error;}
    diagnostics=null;
    return getInfo();
  }));
  handle('babel:check-cli-update',async()=>{
    assertIdle();
    if(app.isPackaged) return checkPackagedUpdate();
    const git=createGitRunner({timeout:15000});
    const repoRoot=cliCheckoutRoot()??'';
    await git(['fetch','origin','--prune'],repoRoot);
    const inspection=await inspectDevelopmentCheckout({git,repoRoot});
    cliUpdate=updateStateFromInspection(inspection);
    return {...cliUpdate,inspection:publicInspection(inspection),desktopRelease:await checkReleaseUpdate()};
  });
  handle('babel:set-update-channel',async channel=>{
    assertIdle();
    if(channel!=='stable'&&channel!=='preview') throw new Error('Update channel must be stable or preview.');
    const active=readActiveEngine(app.getPath('userData'))??{id:'bundled',channelPreference:'stable'};
    writeActiveEngine(app.getPath('userData'),{...active,channelPreference:channel});
    return checkPackagedUpdate();
  });
  handle('babel:update-packaged-cli',()=>withNativeDialog(async()=>{
    assertIdle();
    if(!app.isPackaged) throw new Error('Packaged CLI updates are available only in the installed Desktop application.');
    const check=await checkPackagedUpdate();
    if(check.state!=='available'||!check.candidate) throw new Error(check.detail||'No qualified CLI update is available.');
    const channel=check.channel??'stable';
    const detail=channel==='preview'
      ? `Channel: development preview (unsigned)\nIncoming: ${check.availableSha?.slice(0,12)}\nCurrent: ${check.currentSha?.slice(0,12)??'unknown'}\n\nThis builds the CLI from qualified main source using the bundled Node runtime. It is not publisher-signed.`
      : `Channel: stable release\nIncoming: ${check.availableSha?.slice(0,12)}\nCurrent: ${check.currentSha?.slice(0,12)??'unknown'}\n\nThe installer downloads the official release archive and validates it before activation.`;
    const consent=await dialog.showMessageBox(window,{type:'warning',title:'Update the Babel CLI?',message:'Download, verify, and activate a newer qualified CLI build.',detail,buttons:['Cancel','Update CLI'],defaultId:0,cancelId:0,noLink:true});
    if(consent.response!==1) return {started:false};
    const runtime=officialRuntime();
    const npmCli=resolveBundledNpmCli(process.resourcesPath);
    updateBusy=true;
    try{
      const send=event=>{if(window&&!window.isDestroyed())window.webContents.send('babel:update-event',event);};
      const result=channel==='preview'
        ? await installPreviewSourceBuild({userData:app.getPath('userData'),nodeExe:runtime.executable,npmCli,sourceSha:check.candidate.sourceSha,tarballUrl:check.candidate.tarballUrl,events:send})
        : await installStableReleaseArchive({userData:app.getPath('userData'),nodeExe:runtime.executable,npmCli,tgzUrl:check.candidate.tgzUrl,sourceSha:check.candidate.sourceSha,resourcesPath:process.resourcesPath,events:send});
      cliUpdate=result.ok
        ?{state:'current',channel,detail:`Active CLI ${result.version} · ${result.sourceSha.slice(0,12)}`,currentSha:result.sourceSha,availableSha:result.sourceSha}
        :{state:'error',channel,detail:`Update stopped at ${result.phase}: ${result.reason}`};
      diagnostics=null;
      return {...result};
    }finally{updateBusy=false;}
  }));
  handle('babel:update-dev-cli',()=>withNativeDialog(async()=>{
    assertIdle();
    if(app.isPackaged) throw new Error('Packaged builds update through the release channel; the source updater is available only in a development checkout.');
    const entry=activeCliEntry();
    if(!entry) throw new Error('No Babel CLI is selected.');
    const packageDir=dirname(dirname(entry));
    const repoRoot=dirname(packageDir);
    const git=createGitRunner();
    updateBusy=true;
    try{
      const before=await inspectDevelopmentCheckout({git,repoRoot});
      const pre=precheckSafety(before);
      if(!pre.allowed) throw new Error(updateBlockMessage(pre.reason));
      // Fetch the trusted upstream before presenting the incoming revision so the
      // user sees an accurate target, never a stale local ref.
      const fetched=await git(['fetch','origin','--prune'],repoRoot);
      if(!fetched.ok) throw new Error(updateBlockMessage('fetch_failed'));
      const after=await inspectDevelopmentCheckout({git,repoRoot});
      const plan=planDevelopmentUpdate(after);
      if(!plan.allowed){
        if(plan.reason==='already_current') return {started:false,upToDate:true};
        throw new Error(updateBlockMessage(plan.reason));
      }
      const consent=await dialog.showMessageBox(window,{type:'warning',title:'Update the development Babel CLI?',message:'Fetch, fast-forward, and rebuild the canonical CLI.',detail:`Checkout: ${after.repoRoot}\nRemote: ${after.remoteHost}/${after.remoteSlug}\nBranch: ${after.branch}\n\nCurrent: ${after.head.slice(0,12)}\nIncoming: ${plan.incomingSha.slice(0,12)} (${plan.incomingCount} commit(s))\n\nDependencies are reinstalled and the CLI rebuilt with the repository's own commands. Uncommitted work is refused, never overwritten.`,buttons:['Cancel','Update CLI'],defaultId:0,cancelId:0,noLink:true});
      if(consent.response!==1) return {started:false};
      const send=event=>{if(window&&!window.isDestroyed())window.webContents.send('babel:update-event',event);};
      const result=await runDevelopmentUpdate({git,run:createStepRunner(),repoRoot,cliDir:packageDir,nodeExe:officialRuntime().executable,nodeEnv:{ELECTRON_RUN_AS_NODE:'1'},npm:resolveNpmInvocation(),snapshotDir:join(app.getPath('userData'),'engine','rollback'),events:send});
      cliUpdate=result.ok
        ?{state:'current',channel:'development',currentSha:result.sourceSha,availableSha:result.sourceSha,detail:`Updated to ${result.sourceSha.slice(0,12)} (CLI ${result.version}).`}
        :{state:'error',channel:'development',currentSha:result.previousSha??null,detail:`Update stopped at ${result.phase}: ${updateBlockMessage(result.reason)}${result.treeAdvanced?'. The checkout is now at the fetched commit; the previous build was restored.' : ''}`};
      return {...result};
    }finally{updateBusy=false;}
  }));
  handle('babel:rebuild-dev-cli',()=>withNativeDialog(async()=>{
    assertIdle();
    if(app.isPackaged) throw new Error('Rebuild is available only in a source checkout.');
    const entry=activeCliEntry();
    if(!entry) throw new Error('No Babel CLI is selected.');
    const packageDir=dirname(dirname(entry));
    const repoRoot=dirname(packageDir);
    const consent=await dialog.showMessageBox(window,{type:'warning',title:'Rebuild the development Babel CLI?',message:'Reinstall dependencies and rebuild the current checkout.',detail:`Checkout: ${repoRoot}\n\nThe previous dist is restored automatically if the rebuild fails.`,buttons:['Cancel','Rebuild CLI'],defaultId:0,cancelId:0,noLink:true});
    if(consent.response!==1) return {started:false};
    updateBusy=true;
    try{
      const send=event=>{if(window&&!window.isDestroyed())window.webContents.send('babel:update-event',event);};
      const result=await runDevelopmentRebuild({run:createStepRunner(),repoRoot,cliDir:packageDir,nodeExe:officialRuntime().executable,nodeEnv:{ELECTRON_RUN_AS_NODE:'1'},npm:resolveNpmInvocation(),snapshotDir:join(app.getPath('userData'),'engine','rollback'),events:send});
      return {...result};
    }finally{updateBusy=false;}
  }));
  handle('babel:choose-cli',()=>withNativeDialog(()=>withConnectionChange(async()=>{
    if(app.isPackaged)throw new Error('Babel Desktop uses its bundled CLI. Other executable entries are available only in source builds.');
    const selection=await dialog.showOpenDialog(window,{title:'Select your trusted Babel build: babel-cli/dist/index.js',properties:['openFile'],filters:[{name:'JavaScript entry point',extensions:['js','mjs','cjs']}]});
    if(selection.canceled) return getInfo();
    const selected=await realpath(selection.filePaths[0]);
    const consent=await dialog.showMessageBox(window,{type:'warning',title:'Trust this Babel entry point?',message:'This file is executable code.',detail:`${selected}\n\nOnly select the built CLI from your trusted Babel checkout. This application does not verify the provenance of that build.`,buttons:['Cancel','Trust this build'],defaultId:0,cancelId:0,noLink:true});
    if(consent.response!==1)return getInfo();
    preferences.cliEntry=selected;await savePreferences();return getInfo();
  })));
  handle('babel:list-qualified-providers',()=>qualifiedProviders(runtimeEnvironment().BABEL_CONFIG_DIR));
  handle('babel:refresh-models',provider=>withConnectionChange(()=>refreshModelCatalog({provider,configDirectory:runtimeEnvironment().BABEL_CONFIG_DIR})));
  handle('babel:read-provider-route',()=>readProviderRoute(runtimeEnvironment().BABEL_CONFIG_DIR));
  handle('babel:provider-credential-status',async options=>{
    assertIdle();
    const context=await credentialRequestContext(options);
    const status=providerCredentialStatus(context);
    const binding=randomUUID();
    credentialBindings.clear();credentialBindings.set(binding,{...context,generation:projectAuthority.generation});
    return {...status,binding};
  });
  handle('babel:remove-provider-credential',async options=>{
    return withConnectionChange(async()=>{
      const context=await credentialRequestContext(options,true);
      const result=removeProviderCredential(context);diagnostics=null;return result;
    });
  });
  handle('babel:migrate-provider-credential',async options=>{
    return withConnectionChange(async()=>{
      const context=await credentialRequestContext({...options,scope:'private'},true);
      if(options?.confirm!==true)throw new Error('Confirm retention of the legacy plaintext recovery file.');
      const result=migrateProviderCredential({...context,confirm:true});diagnostics=null;return result;
    });
  });
  handle('babel:save-provider-route',async options=>{
    return withConnectionChange(async()=>{
    if(options?.apiKey || options?.scope==='project')await credentialRequestContext(options,Boolean(options?.apiKey));
    const result=await saveDesktopProviderRoute({
      options, configDirectory:runtimeEnvironment().BABEL_CONFIG_DIR, preferences, savePreferences,
    });
    diagnostics=null;
    return result;
    });
  });
  handle('babel:save-provider-credential',async options=>{
    return withConnectionChange(async()=>{
    if(!options || typeof options!=='object' || (options.scope!=='private' && options.scope!=='project')) {
      throw new Error('Select an explicit credential destination.');
    }
    if(options.scope==='project'&&!preferences.projectRoot) {
      throw new Error('Select a project before choosing project-local credentials.');
    }
    if(options.apiKey || options.scope==='project')await credentialRequestContext(options,Boolean(options.apiKey));
    const configDirectory=runtimeEnvironment().BABEL_CONFIG_DIR;
    const route=validateProviderRoute({provider:options.provider, model:options.model},configDirectory);
    const descriptor=qualifiedProviders().find(entry=>entry.id===route.provider);
    const requiresKey=Boolean(descriptor?.requiresApiKey);
    const apiKey=typeof options.apiKey==='string'?options.apiKey:'';
    if(requiresKey && !apiKey && !hasProviderCredential({
      configDirectory, provider: route.provider, scope: options.scope, projectRoot: preferences.projectRoot,
    })) {
      throw new Error('Enter a provider API key.');
    }
    let result={provider:route.provider, scope:options.scope, configured:true};
    if(requiresKey && apiKey) {
      result=saveProviderCredential({
        provider:route.provider, apiKey, scope:options.scope,
        configDirectory, projectRoot:preferences.projectRoot,operation:options.credentialOperation??'add',
      });
    }
    saveProviderRoute({configDirectory, ...route});
    const previousRoot=preferences.projectCredentialRoot;
    preferences.projectCredentialRoot=options.scope==='project'?preferences.projectRoot:null;
    try{await savePreferences();}
    catch(error){preferences.projectCredentialRoot=previousRoot;throw error;}
    diagnostics=null; // Next doctor reflects the saved file, without inspecting the key.
    return result;
    });
  });
  handle('babel:choose-project',()=>withNativeDialog(()=>withConnectionChange(async()=>{
    const selection=await dialog.showOpenDialog(window,{title:'Open project',properties:['openDirectory']});
    if(!selection.canceled){preferences.projectRoot=await realpath(selection.filePaths[0]);await savePreferences();}
    return getInfo();
  })));
  handle('babel:trust-project',()=>withNativeDialog(()=>withConnectionChange(async()=>{
    const root=preferences.projectRoot;
    const generation=projectAuthority.generation;
    const identity=await inspectProjectIdentity(root);
    const consent=await dialog.showMessageBox(window,{type:'question',title:'Trust this project?',message:'Allow Babel to work in this exact project?',detail:`${identity.root}\n${identity.branch?`Branch: ${identity.branch}\n`:''}\nBabel can read project content, send it to your selected provider, change files and run routine checks under CLI policy. Consequential operations retain their approvals. Trust is remembered for this directory and repository identity until you revoke it.`,buttons:['Cancel','Trust project'],defaultId:0,cancelId:0,noLink:true});
    if(consent.response===1)await projectAuthority.grant(root,identity,generation);
    return getInfo();
  })));
  handle('babel:revoke-project-trust',async()=>{
    if(!preferences.projectRoot)throw new Error('No project is selected.');
    const revocation=projectAuthority.revoke(preferences.projectRoot);
    runAdmissionEpoch++;
    remoteAdmissionEpoch++;
    runAuthority=null;
    runner?.cancel();remoteBridge?.stop();remoteBridge=null;
    try{await revocation;}catch{throw new Error('Project access stopped in this app, but revocation could not be saved. Retry before reopening Babel.');}
    return getInfo();
  });
  handle('babel:list-sessions',options=>listSavedChats(packageRoot,{
    runsDir:runtimeEnvironment().BABEL_RUNS_DIR,
    limit:Number(options?.limit) > 0 ? Number(options.limit) : undefined,
    offset:Number(options?.offset) >= 0 ? Number(options.offset) : undefined,
  }));
  let historySearchActive=false;
  handle('babel:read-session-message',request=>readSavedMessage(packageRoot,request?.sessionId,request?.messageIndex,{runsDir:runtimeEnvironment().BABEL_RUNS_DIR,charOffset:request?.charOffset,sourceEventId:request?.sourceEventId}));
  handle('babel:search-sessions',async query=>{
    if(historySearchActive)throw new Error('History search is already running.');
    historySearchActive=true;
    try{return await searchSavedChats(packageRoot,query,{runsDir:runtimeEnvironment().BABEL_RUNS_DIR});}
    finally{historySearchActive=false;}
  });
  handle('babel:open-session',(id, options)=>readSavedChat(packageRoot,id,{
    runsDir:runtimeEnvironment().BABEL_RUNS_DIR,
    olderOffset:Number(options?.olderOffset) >= 0 ? Number(options.olderOffset) : undefined,
    messageLimit:Number(options?.messageLimit) > 0 ? Number(options.messageLimit) : undefined,
  }));
  const withProjectAccess=async operation=>{
    const admission=await projectAuthority.admit(preferences.projectRoot);
    const result=await operation(admission.identity.root);
    const current=await projectAuthority.admit(preferences.projectRoot);
    if(!projectAuthority.isCurrent(admission)||current.identity.id!==admission.identity.id)throw new Error('Project authority changed during the request.');
    return result;
  };
  handle('babel:list-directory',relative=>withProjectAccess(root=>listDirectory(root,relative)));
  handle('babel:read-file',relative=>withProjectAccess(root=>readProjectFile(root,relative)));
  handle('babel:read-diff',relative=>withProjectAccess(root=>readProjectDiff(root,relative,{cacheDirectory:join(app.getPath('userData'),'diff-cache')})));
  handle('babel:open-repository',()=>shell.openExternal(REPOSITORY_URL));
  handle('babel:decide',async reply=>{
    if(!runAuthority||!projectAuthority.isCurrent(runAuthority))return {accepted:false};
    try{const current=await projectAuthority.admit(preferences.projectRoot);if(current.identity.id!==runAuthority?.identity.id||!projectAuthority.isCurrent(runAuthority))return {accepted:false};}catch{return {accepted:false};}
    const accepted=runner?.reply(reply)===true;
    if(accepted){backgroundStatus='Babel is working';try{updateTray();}catch{}}
    return {accepted};
  });
  handle('babel:cancel',()=>{runAdmissionEpoch++;runner?.cancel();return true;});
  handle('babel:emergency-stop-shared-run',()=>{
    if(!runner||typeof runner.emergencyAdminStop!=='function')return {accepted:false,reason:'not_shared_protocol'};
    const token=readBridgeHostAuthToken(runtimeEnvironment().BABEL_CONFIG_DIR);
    if(!token)return {accepted:false,reason:'missing_host_token'};
    return {accepted:runner.emergencyAdminStop(token)===true};
  });
  handle('babel:start-remote-bridge',options=>withConnectionChange(async()=>{
    const admissionEpoch=remoteAdmissionEpoch;
    if(remoteBridge?.running)throw new Error('The loopback remote bridge is already running');
    const cliEntry=activeCliEntry();
    if(!cliEntry)throw new Error(app.isPackaged?'Bundled CLI or Node is missing.':'Build or select the official Babel CLI first');
    if(!preferences.projectRoot)throw new Error('Open a project first');
    const admission=await projectAuthority.admit(preferences.projectRoot);
    const port=Number(options?.port??4545);
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid remote bridge port');
    if(admissionEpoch!==remoteAdmissionEpoch||!projectAuthority.isCurrent(admission))throw new Error('Remote startup was cancelled.');
    const childEnvironment=await ownedCliEnvironment();
    if(admissionEpoch!==remoteAdmissionEpoch||!projectAuthority.isCurrent(admission))throw new Error('Remote startup was cancelled.');
    const bridge=new RemoteBridgeChild({executable:officialRuntime().executable,entry:cliEntry,projectRoot:admission.identity.root,env:childEnvironment,inheritEnv:false});
    remoteBridge=bridge;
    try{
      const result=await bridge.start({
        port,
        sharedSession:true,
        onLine:({stream,text,phase,code,diagnosticAvailable})=>{if(window&&!window.isDestroyed())window.webContents.send('babel:remote-log',{stream,text,phase,code,diagnosticAvailable});},
      });
      if(!projectAuthority.isCurrent(admission)||remoteBridge!==bridge){bridge.stop();throw new Error('Project trust or connection changed while starting remote access.');}
      return result;
    }catch(error){
      remoteBridge=releaseBridgeIfCurrent(remoteBridge,bridge);
      throw error;
    }
  }));
  handle('babel:stop-remote-bridge',()=>{remoteAdmissionEpoch++;remoteBridge?.stop();remoteBridge=null;return {stopped:true};});
  handle('babel:run',async request=>{
    assertRunAdmissionIdle();
    runAdmission=true;
    const admissionEpoch=runAdmissionEpoch;
    try{
    if(!request||typeof request!=='object'||typeof request.runId!=='string'||!/^[\w-]{1,100}$/.test(request.runId))throw new Error('Invalid run request');
    const cliEntry=activeCliEntry();
    if(!cliEntry)throw new Error(app.isPackaged?'Bundled CLI or Node is missing. Extract the complete ZIP again.':'The official Babel CLI is not built. Build babel-cli/dist/index.js, or choose another entry from Advanced.');
    const conversationOnly=!preferences.projectRoot;
    if(!conversationOnly)await projectAuthority.admit(preferences.projectRoot);
    if(!(await getInfo()).ready)throw new Error('The selected Babel CLI or project is no longer available');
    if(app.isPackaged&&!conversationOnly){
      diagnostics=await diagnoseRuntime(officialRuntime(),{env:await ownedCliEnvironment(),cwd:app.getPath('userData')});
      if(!diagnostics.ready)throw new Error('Execution prerequisites are missing or unverified. Open Setup, start Docker Desktop and prepare or validate a sandbox image, then recheck setup.');
    }
    // Validate native-bound scope and route before spawning; no arbitrary flags.
    const route = readProviderRoute(runtimeEnvironment().BABEL_CONFIG_DIR);
    const runRequest = {...request,executionScope:conversationOnly?{kind:'conversation'}:{kind:'project',projectRoot:preferences.projectRoot}};
    if (route?.model && !runRequest.model) {
      runRequest.model = route.model;
    }
    if(!route)throw new Error('Choose a provider and default model in Settings before sending a task.');
    const unavailableMode=modeUnavailableReason(runRequest.mode,route.provider,conversationOnly?'conversation':'project');
    if(unavailableMode)throw new Error(unavailableMode);
    const models=qualifiedProviders(runtimeEnvironment().BABEL_CONFIG_DIR).find(p=>p.id===route.provider)?.routes??[];
    const selectedModel=models.find(model=>model.id===runRequest.model&&model.enabled!==false);
    if(!selectedModel)throw new Error('The selected model is disabled or belongs to another provider. Choose an enabled model.');
    if(selectedModel.selectable===false)throw new Error(selectedModel.unavailableReason||'The selected model is unavailable. Choose another model in Settings.');
    buildRunArgs(cliEntry, preferences.projectRoot, runRequest);
    const childEnvironment=applySelectedModelEnvironment(await ownedCliEnvironment(),selectedModel);
    runAuthority=conversationOnly?null:await projectAuthority.admit(preferences.projectRoot);
    if(admissionEpoch!==runAdmissionEpoch){runAuthority=null;return {started:false};}
    const sharedBridge=remoteBridge?.state==='ready'&&remoteBridge.sharedSession&&remoteBridge.port&&remoteBridge.desktopClientId;
    if(sharedBridge&&conversationOnly){
      throw new Error('Shared remote sessions require an open project.');
    }
    if(sharedBridge){
      if(route?.provider) runRequest.provider=route.provider;
      if(selectedModel?.modelId) runRequest.model=selectedModel.modelId;
      runner=new SharedProtocolRun({
        executable:officialRuntime().executable,
        entry:cliEntry,
        port:remoteBridge.port,
        desktopClientId:remoteBridge.desktopClientId,
        desktopProofKey:remoteBridge.desktopProofKey,
        projectRoot:runAuthority.identity.root,
        env:childEnvironment,
        inheritEnv:false,
      });
    }else{
      runner=new BabelChild({executable:officialRuntime().executable, entry:cliEntry, projectRoot:runAuthority?.identity.root??null,launchDirectory:app.getPath('userData'), env:childEnvironment, inheritEnv:false});
    }
    backgroundStatus='Babel is working';
    void runner.start(runRequest, handleBabelPacket);
    try{updateTray();}catch{ /* Tray refresh cannot invalidate an already admitted run. */ }
    return {started:true};
    }finally{runAdmission=false;}
  });
  createWindow();
}
function createWindow(){
  window=new BrowserWindow({width:1536,height:1060,minWidth:960,minHeight:620,backgroundColor:'#020914',title:'Babel — Run. Verify. Understand.',autoHideMenuBar:true,show:false,
    icon:join(packageRoot,'assets','babel-mark.png'),
    webPreferences:{preload:join(packageRoot,'native','preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false,devTools:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.on('ready-to-show',()=>window.show());
  const requestClose=createCloseRequest({
    ask:async()=>{
      if(dialogBusy)return 'cancel';
      if(updateBusy||connectionChangeBusy||runAdmission){
        await withNativeDialog(()=>dialog.showMessageBox(window,{type:'info',title:'Babel is finishing setup',message:'Wait for setup or the update to finish before closing Babel.',buttons:['Keep open'],noLink:true}));
        return 'cancel';
      }
      const answer=await withNativeDialog(()=>dialog.showMessageBox(window,{type:'question',title:'Active Babel work',message:'What should happen to the active work?',detail:'Keep working leaves this owned runtime running with a tray control to reopen or stop it. Local work cannot continue while the computer is asleep or shut down. Stop and quit requests cancellation; interrupted effects may need review when you reopen.',buttons:['Keep open','Keep working in background','Stop and quit'],defaultId:0,cancelId:0,noLink:true}));
      return ['cancel','background','stop'][answer.response]??'cancel';
    },
    background:()=>{ensureTray();window.hide();},
    stopAndClose:stopThenClose,
    onError:()=>{showWindow();dialog.showErrorBox('Babel could not finish closing','Review the window and active work before retrying the close action.');},
  });
  window.on('close',event=>{
    if(!draftCloseReady){
      event.preventDefault();
      if(!draftCloseRequest)void flushComposerBeforeClose().then(saved=>{if(saved&&window&&!window.isDestroyed()){draftCloseReady=true;window.close();}}).catch(()=>showWindow());
      return;
    }
    draftCloseReady=false;
    const decision=decideWindowClose({busy:busy(),closing:closingWindow});
    if(decision==='wait'){event.preventDefault();return;}
    if(decision==='ask'){
      event.preventDefault();
      void requestClose();
      return;
    }
    runner?.cancel();
    remoteBridge?.stop();
    remoteBridge=null;
  });
  window.on('closed',()=>{window=null;});
  window.loadURL(APP_URL);
}
function showWindow(){
  if(!window||window.isDestroyed())return;
  window.show();if(window.isMinimized())window.restore();window.focus();
}
function updateTray(){
  if(!tray||tray.isDestroyed())return;
  tray.setToolTip(backgroundStatus);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:backgroundStatus,enabled:false},
    {label:'Open Babel',click:showWindow},
    {label:'Stop work and quit',enabled:Boolean(runner?.busy||remoteBridge?.running),click:stopThenClose},
    {label:'Quit Babel',enabled:!busy(),click:()=>{if(busy())showWindow();else stopThenClose();}},
  ]));
}
function ensureTray(){
  if(!tray||tray.isDestroyed()){
    tray=new Tray(join(packageRoot,'assets','babel-mark.png'));
    tray.on('click',showWindow);tray.on('balloon-click',showWindow);
  }
  updateTray();
}
function handleBabelPacket(packet){
  // Notification or renderer failures cannot take down the owned child runtime.
  try{if(window&&!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('babel:event',packet);}catch{}
  const kind=packet.event?.type;
  const attention=kind==='approval.required'&&runner?.awaitingApproval?'Babel needs approval':packet.kind==='exit'?'Babel run ended · open to review':null;
  if(attention){
    backgroundStatus=attention;
    try{
      updateTray();
      if(tray&&!tray.isDestroyed()&&window&&!window.isDestroyed()&&!window.isVisible()&&process.platform==='win32')tray.displayBalloon({title:'Babel',content:attention,iconType:'info'});
    }catch{ /* Optional desktop attention must not interrupt task execution. */ }
  }
}
async function stopThenClose(){
  if(closingWindow)return false;
  if(updateBusy||connectionChangeBusy||runAdmission){showWindow();return false;}
  closingWindow=true;
  runner?.cancel();remoteBridge?.stop();
  await new Promise(resolve=>{
    const timer=setTimeout(resolve,CLOSE_GRACE_MS);
    if(runner?.busy)runner.whenIdle(()=>{clearTimeout(timer);resolve();});
    else{clearTimeout(timer);resolve();}
  });
  return finishClosingWindow();
}
async function flushComposerBeforeClose(){
  if(!window||window.isDestroyed())return true;
  if(draftCloseRequest)return false;
  const token=randomUUID();
  const saved=await new Promise(resolve=>{
    const timer=setTimeout(()=>{draftCloseRequest=null;resolve(false);},10000);
    draftCloseRequest={token,finish:value=>{clearTimeout(timer);draftCloseRequest=null;resolve(value);}};
    try{window.webContents.send('babel:prepare-draft-close',token);}catch{draftCloseRequest.finish(false);}
  });
  if(saved){await composerDrafts?.whenIdle();return true;}
  if(!window||window.isDestroyed())return false;
  const answer=await withNativeDialog(()=>dialog.showMessageBox(window,{type:'warning',title:'Drafts are not saved',message:'The latest composer drafts could not be saved.',detail:'Keep Babel open to copy or recover the text. Quitting now may lose unsaved text; previously saved chats and drafts remain on disk.',buttons:['Keep open','Quit without unsaved drafts'],defaultId:0,cancelId:0,noLink:true}));
  return answer.response===1;
}
async function finishClosingWindow(){
  if(closeFinished)return true;
  if(finishingClose)return false;
  finishingClose=true;
  try{
    if(!await flushComposerBeforeClose()){closingWindow=false;showWindow();return false;}
    closeFinished=true;
    if(window&&!window.isDestroyed())window.destroy();
    app.quit();
    return true;
  }catch{closingWindow=false;showWindow();return false;}
  finally{finishingClose=false;}
}
app.on('before-quit',event=>{
  if(!closeFinished&&window&&!window.isDestroyed()){event.preventDefault();window.close();return;}
  runner?.cancel();remoteBridge?.stop();tray?.destroy();tray=null;
});
app.on('window-all-closed',()=>{if(decideLastWindow()==='quit')app.quit();});
