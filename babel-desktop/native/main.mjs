import {app,BrowserWindow,dialog,ipcMain,protocol,session,shell} from 'electron';
import {readFileSync} from 'node:fs';
import {readFile,writeFile,rename,mkdir,stat,realpath} from 'node:fs/promises';
import {basename,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BabelChild,buildRunArgs,EXECUTION_PROFILE} from './child.mjs';
import {RemoteBridgeChild} from './remoteHost.mjs';
import {listDirectory,readProjectFile} from './workspace.mjs';
import {APP_URL,REPOSITORY_URL,isAppUrl,parsePreferences} from './security.mjs';
import {resolveOfficialCli,bundledEnvironment} from './runtime.mjs';
import {diagnoseRuntime} from './diagnostics.mjs';
import {saveProviderCredential} from './credentials.mjs';
import {applyProjectCredentialScope} from './childEnv.mjs';
import {resolveEngineIdentity} from './identity.mjs';
import {createGitRunner,createStepRunner,inspectDevelopmentCheckout,planDevelopmentUpdate,precheckSafety,resolveNpmInvocation,runDevelopmentUpdate,runDevelopmentRebuild,compareReleaseVersion,EXPECTED_ORIGIN} from './updater.mjs';
import {parseBuildMetadata} from './identity.mjs';
import {readActiveEngine, writeActiveEngine} from './engine-manager.mjs';
import {checkPackagedCliUpdate, installPreviewSourceBuild, installStableReleaseArchive, resolveBundledNpmCli} from './engine-artifact.mjs';
import {qualifiedProviders, saveProviderRoute} from './provider-routing.mjs';
import {listSavedChats,readSavedChat} from './sessions.mjs';
import {CLOSE_GRACE_MS,decideLastWindow,decideWindowClose} from './lifecycle.mjs';

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
function runtimeEnvironment() {
  const profile=join(app.getPath('userData'),'engine','config');
  const env=app.isPackaged?bundledEnvironment(app.getPath('userData')):{...process.env,ELECTRON_RUN_AS_NODE:'1',BABEL_CONFIG_DIR:profile};
  // Project keys are never loaded merely because a repository contains .env.
  return applyProjectCredentialScope(env,{projectCredentialRoot:preferences.projectCredentialRoot,projectRoot:preferences.projectRoot,configDirectory:profile});
}
let diagnostics=null;
let window=null;
let closingWindow=false;
let closeFinished=false;
let preferences={cliEntry:null,projectRoot:null,projectCredentialRoot:null};
let runner=null;
let remoteBridge=null;
let runAdmission=false;
let dialogBusy=false;
let updateBusy=false;
let cliUpdate={state:'unchecked'};
let preferencePath;
const busy=()=>Boolean(runAdmission||runner?.busy||remoteBridge?.running||updateBusy);

protocol.registerSchemesAsPrivileged([{scheme:'babel',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const singleInstance=app.requestSingleInstanceLock();
if(!singleInstance) app.quit();
else {
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(start).catch(error=>{
    dialog.showErrorBox('Babel Desktop could not start',error.message);
    app.quit();
  });
}
async function savePreferences(){
  await mkdir(dirname(preferencePath),{recursive:true});
  // UI paths only: never API credentials, agent messages, or authoritative sessions.
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
  try{ready=Boolean(cliEntry&&preferences.projectRoot&&(await stat(cliEntry)).isFile()&&(await stat(preferences.projectRoot)).isDirectory());}catch{}
  if(app.isPackaged&&!diagnostics)diagnostics=await diagnoseRuntime(official,{env:runtimeEnvironment(),cwd:app.getPath('userData')});
  const engine=resolveEngineIdentity({
    isPackaged:app.isPackaged,resourcesPath:process.resourcesPath,desktopVersion:app.getVersion(),
    cliEntry,official,advancedEntry:Boolean(!app.isPackaged&&preferences.cliEntry),ready,
    executionProfile:EXECUTION_PROFILE,diagnostics,update:cliUpdate,
  });
  if(official.engineId&&official.engineId!=='bundled') engine.activeEngineId=official.engineId;
  return {
    cliName:cliEntry?basename(cliEntry):null,
    projectName:preferences.projectRoot?basename(preferences.projectRoot):null,
    ready,
    officialCliLabel:official.label,
    officialCliReady:official.ready,
    runtimeSource:!app.isPackaged&&preferences.cliEntry?'advanced':official.ready?official.source:'missing',
    packaged:app.isPackaged,
    diagnostics,
    engine,
    configDirectory:runtimeEnvironment().BABEL_CONFIG_DIR,
    projectCredentialsSelected:preferences.projectCredentialRoot===preferences.projectRoot && Boolean(preferences.projectRoot),
    remoteBridge:remoteBridge
      ? {
          running:remoteBridge.state==='ready',
          state:remoteBridge.state,
          port:remoteBridge.port,
          url:remoteBridge.port?`http://127.0.0.1:${remoteBridge.port}`:null,
          blocksLocalRuns:remoteBridge.running,
          sharedSession:false,
        }
      : {running:false,state:'stopped',port:null,url:null,blocksLocalRuns:false,sharedSession:false},
  };
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
async function start(){
  await mkdir(app.getPath('userData'),{recursive:true});
  preferencePath=join(app.getPath('userData'),'ui-connection.json');
  try{
    if((await stat(preferencePath)).size<16384) preferences=parsePreferences(JSON.parse(await readFile(preferencePath,'utf8')));
  }catch{/* Missing/invalid UI preferences never block startup. */}
  const html=await readFile(join(packageRoot,'dist','index.html'),'utf8');
  protocol.handle('babel',request=>isAppUrl(request.url)?new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'}}):new Response('Not found',{status:404}));
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  handle('babel:get-info',getInfo);
  handle('babel:refresh-diagnostics',async()=>{assertIdle();diagnostics=null;return getInfo();});
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
        : await installStableReleaseArchive({userData:app.getPath('userData'),nodeExe:runtime.executable,npmCli,tgzUrl:check.candidate.tgzUrl,sourceSha:check.candidate.sourceSha,events:send});
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
  handle('babel:choose-cli',()=>withNativeDialog(async()=>{
    assertIdle();
    if(app.isPackaged)throw new Error('This preview uses its bundled CLI. Other executable entries are available only in source builds.');
    const selection=await dialog.showOpenDialog(window,{title:'Select your trusted Babel build: babel-cli/dist/index.js',properties:['openFile'],filters:[{name:'JavaScript entry point',extensions:['js','mjs','cjs']}]});
    if(selection.canceled) return getInfo();
    const selected=await realpath(selection.filePaths[0]);
    const consent=await dialog.showMessageBox(window,{type:'warning',title:'Trust this Babel entry point?',message:'This file is executable code.',detail:`${selected}\n\nOnly select the built CLI from your trusted Babel checkout. This application does not verify the provenance of that build.`,buttons:['Cancel','Trust this build'],defaultId:0,cancelId:0,noLink:true});
    if(consent.response!==1)return getInfo();
    preferences.cliEntry=selected;await savePreferences();return getInfo();
  }));
  handle('babel:list-qualified-providers',()=>qualifiedProviders());
  handle('babel:save-provider-credential',async options=>{
    assertIdle();
    if(!options || typeof options!=='object' || (options.scope!=='private' && options.scope!=='project')) {
      throw new Error('Select an explicit credential destination.');
    }
    if(options.scope==='project'&&!preferences.projectRoot) {
      throw new Error('Select a project before choosing project-local credentials.');
    }
    const configDirectory=runtimeEnvironment().BABEL_CONFIG_DIR;
    const result=saveProviderCredential({
      provider:options.provider,apiKey:options.apiKey,scope:options.scope,
      configDirectory,projectRoot:preferences.projectRoot,
    });
    saveProviderRoute({configDirectory,provider:options.provider,model:options.model});
    preferences.projectCredentialRoot=options.scope==='project'?preferences.projectRoot:null;
    await savePreferences();
    diagnostics=null; // Next doctor reflects the saved file, without inspecting the key.
    return result;
  });
  handle('babel:choose-project',()=>withNativeDialog(async()=>{
    assertIdle();
    const selection=await dialog.showOpenDialog(window,{title:'Open project',properties:['openDirectory']});
    if(!selection.canceled){preferences.projectRoot=await realpath(selection.filePaths[0]);await savePreferences();}
    return getInfo();
  }));
  handle('babel:list-sessions',()=>listSavedChats(packageRoot,{runsDir:runtimeEnvironment().BABEL_RUNS_DIR}));
  handle('babel:open-session',id=>readSavedChat(packageRoot,id,{runsDir:runtimeEnvironment().BABEL_RUNS_DIR}));
  handle('babel:list-directory',relative=>listDirectory(preferences.projectRoot,relative));
  handle('babel:read-file',relative=>readProjectFile(preferences.projectRoot,relative));
  handle('babel:open-repository',()=>shell.openExternal(REPOSITORY_URL));
  handle('babel:decide',decision=>{if(runner)runner.reply(decision);return true;});
  handle('babel:cancel',()=>{runner?.cancel();return true;});
  handle('babel:start-remote-bridge',async options=>{
    assertIdle();
    if(remoteBridge?.running)throw new Error('The loopback remote bridge is already running');
    const cliEntry=activeCliEntry();
    if(!cliEntry)throw new Error(app.isPackaged?'Bundled CLI or Node is missing.':'Build or select the official Babel CLI first');
    if(!preferences.projectRoot)throw new Error('Open a project first');
    const port=Number(options?.port??4545);
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid remote bridge port');
    remoteBridge=new RemoteBridgeChild({executable:officialRuntime().executable,entry:cliEntry,projectRoot:preferences.projectRoot,env:runtimeEnvironment(),inheritEnv:false});
    try{
      return await remoteBridge.start({port,onLine:({stream,text})=>{if(window&&!window.isDestroyed())window.webContents.send('babel:remote-log',{stream,text});}});
    }catch(error){
      remoteBridge=null;
      throw error;
    }
  });
  handle('babel:stop-remote-bridge',()=>{remoteBridge?.stop();remoteBridge=null;return {stopped:true};});
  handle('babel:run',async request=>{
    assertIdle();
    runAdmission=true;
    try{
    if(!request||typeof request!=='object'||typeof request.runId!=='string'||!/^[\w-]{1,100}$/.test(request.runId))throw new Error('Invalid run request');
    const cliEntry=activeCliEntry();
    if(!cliEntry)throw new Error(app.isPackaged?'Bundled CLI or Node is missing. Extract the complete ZIP again.':'The official Babel CLI is not built. Build babel-cli/dist/index.js, or choose another entry from Advanced.');
    if(!preferences.projectRoot)throw new Error('Open a project first');
    if(!(await getInfo()).ready)throw new Error('The selected Babel CLI or project is no longer available');
    if(app.isPackaged){
      diagnostics=await diagnoseRuntime(officialRuntime(),{env:runtimeEnvironment(),cwd:app.getPath('userData')});
      if(!diagnostics.ready)throw new Error('Execution prerequisites are missing or unverified. Open Connection, check runtime files and start Docker, then recheck setup.');
    }
    // Validate before presenting consent; renderer cannot provide arbitrary flags.
    buildRunArgs(cliEntry,preferences.projectRoot,request);
      const consent=await withNativeDialog(()=>dialog.showMessageBox(window,{type:'question',title:'Run with your existing Babel CLI?',message:`Start a ${request.mode} run with Babel?`,detail:`Project: ${preferences.projectRoot}\nCLI: ${cliEntry}\n\nTask: ${request.task.slice(0,1200)}${request.task.length>1200?'…':''}\n\nBabel may read and change files in this project, run commands, and send project content to your configured model provider. Approvals appear in this window. Stop ends the run.`,buttons:['Cancel','Run Babel'],defaultId:0,cancelId:0,noLink:true}));
      if(consent.response!==1)return {started:false};
      runner=new BabelChild({executable:officialRuntime().executable,entry:cliEntry,projectRoot:preferences.projectRoot,env:runtimeEnvironment(),inheritEnv:false});
      runner.start(request,packet=>{if(window&&!window.isDestroyed())window.webContents.send('babel:event',packet);});
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
  window.on('close',event=>{
    const decision=decideWindowClose({busy:busy(),closing:closingWindow});
    if(decision==='cancel-then-close'){
      event.preventDefault();
      closingWindow=true;
      runner?.cancel();
      const timer=setTimeout(finishClosingWindow,CLOSE_GRACE_MS);
      if(runner?.busy) runner.whenIdle(()=>{clearTimeout(timer);finishClosingWindow();});
      else {clearTimeout(timer);finishClosingWindow();}
      return;
    }
    runner?.cancel();
    remoteBridge?.stop();
    remoteBridge=null;
  });
  window.on('closed',()=>{window=null;});
  window.loadURL(APP_URL);
}
function finishClosingWindow(){
  if(closeFinished)return;
  closeFinished=true;
  if(window&&!window.isDestroyed())window.destroy();
  app.quit();
}
app.on('before-quit',()=>{runner?.cancel();remoteBridge?.stop();});
app.on('window-all-closed',()=>{if(decideLastWindow()==='quit')app.quit();});
