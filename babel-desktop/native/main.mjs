import {app,BrowserWindow,dialog,ipcMain,protocol,session,shell} from 'electron';
import {readFile,writeFile,rename,mkdir,stat,realpath} from 'node:fs/promises';
import {basename,dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BabelChild,buildRunArgs} from './child.mjs';
import {listDirectory,readProjectFile} from './workspace.mjs';
import {APP_URL,REPOSITORY_URL,isAppUrl,parsePreferences} from './security.mjs';
import {resolveOfficialCli,bundledEnvironment} from './runtime.mjs';
import {diagnoseRuntime} from './diagnostics.mjs';
import {listSavedChats,readSavedChat} from './sessions.mjs';
import {CLOSE_GRACE_MS,decideLastWindow,decideWindowClose} from './lifecycle.mjs';

const packageRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const profileArgument=process.argv.find(arg=>arg.startsWith('--profile-dir='));
if(profileArgument){
  const profile=profileArgument.slice('--profile-dir='.length);
  if(!isAbsolute(profile))throw new Error('--profile-dir must be an absolute directory');
  app.setPath('userData',profile);
}
const officialRuntime=()=>resolveOfficialCli(packageRoot,{isPackaged:app.isPackaged,resourcesPath:process.resourcesPath});
const runtimeEnvironment=()=>app.isPackaged?bundledEnvironment(app.getPath('userData')):{...process.env,ELECTRON_RUN_AS_NODE:'1'};
let diagnostics=null;
let window=null;
let closingWindow=false;
let closeFinished=false;
let preferences={cliEntry:null,projectRoot:null};
let runner=null;
let runAdmission=false;
let dialogBusy=false;
let preferencePath;
const busy=()=>Boolean(runAdmission||runner?.busy);

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
async function getInfo(){
  const official=officialRuntime();
  const cliEntry=activeCliEntry();
  let ready=false;
  try{ready=Boolean(cliEntry&&preferences.projectRoot&&(await stat(cliEntry)).isFile()&&(await stat(preferences.projectRoot)).isDirectory());}catch{}
  if(app.isPackaged&&!diagnostics)diagnostics=await diagnoseRuntime(official,{env:runtimeEnvironment(),cwd:app.getPath('userData')});
  return {
    cliName:cliEntry?basename(cliEntry):null,
    projectName:preferences.projectRoot?basename(preferences.projectRoot):null,
    ready,
    officialCliLabel:official.label,
    officialCliReady:official.ready,
    runtimeSource:!app.isPackaged&&preferences.cliEntry?'advanced':official.ready?official.source:'missing',
    packaged:app.isPackaged,
    diagnostics,
    configDirectory:app.isPackaged?runtimeEnvironment().BABEL_CONFIG_DIR:null,
  };
}
function validateSender(event){
  if(!window||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!isAppUrl(event.senderFrame.url)) throw new Error('Rejected an untrusted desktop request');
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
      if(!diagnostics.ready)throw new Error('Execution prerequisites are missing or unverified. Open Connection, configure a provider and start Docker, then recheck setup.');
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
app.on('before-quit',()=>{runner?.cancel();});
app.on('window-all-closed',()=>{if(decideLastWindow()==='quit')app.quit();});
