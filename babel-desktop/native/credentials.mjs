// License: Apache-2.0
// Native-only credential owner. Renderer receives status and write receipts only.
import {closeSync,fstatSync,lstatSync,mkdirSync,openSync,readSync,renameSync,rmSync,writeFileSync,fsyncSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const PROVIDERS=Object.freeze({deepseek:'DEEPSEEK_API_KEY',deepinfra:'DEEPINFRA_API_KEY',openrouter:'OPENROUTER_API_KEY','opencode-go':'BABEL_OPENCODE_GO_API_KEY',ollama:null});
const FILE_LIMIT=256*1024;
export const PROTECTED_CREDENTIAL_FILE='desktop-credentials.json';
let protection=null;
/** Main-process bootstrap only; never exposed over IPC. */
export function configureCredentialProtection(value){protection=value;}
export function credentialProviders(){return Object.keys(PROVIDERS);}
function providerName(provider){
  if(!Object.hasOwn(PROVIDERS,provider))throw new Error('Select a supported, authority-qualified cloud provider.');
  return PROVIDERS[provider];
}
function safeApiKey(key){return typeof key==='string'&&key.length>=8&&key.length<=4096&&/^[A-Za-z0-9_./:+==-]+$/.test(key);}
function protectionAvailable(){
  try{return Boolean(protection?.isEncryptionAvailable())&&(!protection.getSelectedStorageBackend||!['basic_text','unknown'].includes(protection.getSelectedStorageBackend()));}catch{return false;}
}
function requireProtection(){if(!protectionAvailable())throw new Error('OS-protected credential storage is unavailable. No plaintext fallback is permitted.');}
function encrypt(key){requireProtection();try{return protection.encryptString(key).toString('base64');}catch{throw new Error('OS-protected credential encryption failed. No changes were made.');}}
function decrypt(value){requireProtection();try{const key=protection.decryptString(Buffer.from(value,'base64'));if(!safeApiKey(key))throw new Error();return key;}catch{throw new Error('OS-protected credential could not be unlocked. No changes were made.');}}
function gitOk(cwd,args){
  const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/i.test(name)));
  const result=spawnSync('git',['-c','core.fsmonitor=false','-C',cwd,...args],{env:{...env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1'},windowsHide:true,timeout:4000,maxBuffer:4096,stdio:'ignore'});
  return result.status===0;
}
function verifyDirectory(dir){
  // Check every existing ancestor: a safe final directory may sit below a link.
  for(let current=resolve(dir);;current=dirname(current)){
    let info;try{info=lstatSync(current);}catch(error){if(error.code==='ENOENT'){if(dirname(current)===current)break;continue;}throw error;}
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Credential directory cannot be a link.');
    if(dirname(current)===current)break;
  }
}
function privateTarget(configDirectory,name='.env',create=false){
  if(typeof configDirectory!=='string'||!configDirectory)throw new Error('Private Babel configuration directory is unavailable.');
  if(!isAbsolute(configDirectory))throw new Error('Private Babel configuration directory must be an absolute path.');
  const dir=resolve(configDirectory);verifyDirectory(dir);
  if(create)mkdirSync(dir,{recursive:true,mode:0o700});
  return join(dir,name);
}
function readSafe(target,missing=''){
  let before;try{before=lstatSync(target);}catch(error){if(error.code==='ENOENT')return missing;throw error;}
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>FILE_LIMIT)throw new Error('Existing credential file is unsafe or too large; an unlinked regular file is required.');
  if(process.platform!=='win32'&&(before.mode&0o077)!==0)throw new Error('Credential file permissions are too broad. Secure it before continuing.');
  const fd=openSync(target,'r');
  try{
    const info=fstatSync(fd);
    if(!info.isFile()||info.dev!==before.dev||info.ino!==before.ino||info.nlink!==1||info.size>FILE_LIMIT||info.size!==before.size||info.mtimeMs!==before.mtimeMs||info.ctimeMs!==before.ctimeMs)throw new Error('Credential file changed. Retry after verifying storage.');
    const buffer=Buffer.alloc(info.size);let offset=0;
    while(offset<buffer.length){const count=readSync(fd,buffer,offset,buffer.length-offset,offset);if(!count)break;offset+=count;}
    const after=fstatSync(fd),current=lstatSync(target);
    if(offset!==buffer.length||after.dev!==info.dev||after.ino!==info.ino||after.nlink!==1||after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||!current.isFile()||current.isSymbolicLink()||current.nlink!==1||current.dev!==info.dev||current.ino!==info.ino||current.size!==info.size||current.mtimeMs!==info.mtimeMs||current.ctimeMs!==info.ctimeMs)throw new Error('Credential file changed while reading. No changes were made.');
    const value=buffer.toString('utf8');
    if(value.includes('\0'))throw new Error('Existing credential file is invalid.');
    return value;
  }finally{closeSync(fd);}
}
function atomicWrite(target,value){
  if(Buffer.byteLength(value)>FILE_LIMIT)throw new Error('Credential storage is full.');
  const temporary=target+'.'+randomUUID()+'.tmp';let fd;
  try{fd=openSync(temporary,'wx',0o600);writeFileSync(fd,value,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,target);}finally{if(fd!==undefined)closeSync(fd);rmSync(temporary,{force:true});}
}
function locked(target,work){
  const lock=target+'.babel-lock';let fd;
  try{fd=openSync(lock,'wx',0o600);}catch{throw new Error('Credential setup is already running or the storage directory is not writable.');}
  try{return work();}finally{closeSync(fd);rmSync(lock,{force:true});}
}
function readStore(configDirectory){
  const raw=readSafe(privateTarget(configDirectory,PROTECTED_CREDENTIAL_FILE),null);
  if(raw===null)return {schemaVersion:1,entries:{},migrations:{}};
  try{
    const value=JSON.parse(raw);
    if(value.schemaVersion!==1||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries)||!value.migrations||typeof value.migrations!=='object'||Array.isArray(value.migrations))throw new Error();
    for(const [provider,entry] of Object.entries(value.entries))if(!Object.hasOwn(PROVIDERS,provider)||!PROVIDERS[provider]||(entry!==null&&(typeof entry!=='string'||entry.length<4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry))))throw new Error();
    for(const [provider,entry] of Object.entries(value.migrations))if(!Object.hasOwn(PROVIDERS,provider)||entry!==true||!Object.hasOwn(value.entries,provider))throw new Error();
    return value;
  }catch{throw new Error('Credential storage is invalid or uses an unsupported schema and is read-only.');}
}
function entryLines(text,name){
  // A physical NAME= line may belong to another variable's quoted value.
  // This narrow editor deliberately rejects multiline dotenv rather than
  // importing an embedded token or corrupting an unrelated assignment.
  // Use dotenv's assignment/quote boundaries, including newline whitespace
  // before a value and its immediately backslash-escaped quotes. Inspect the
  // whole value before treating any physical line as an editable assignment.
  const assignment=/(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
  for(const match of text.matchAll(assignment))if(/[\r\n]/.test(match[2]??''))throw new Error('Multiline or ambiguous dotenv values are unsupported. Repair the file locally before credential access.');
  return text.split(/(?<=\n)/).map(line=>({line,match:new RegExp('^\\s*(?:export\\s+)?'+name+'\\s*=').test(line)}));
}
function legacyKey(text,name){
  const lines=entryLines(text,name).filter(entry=>entry.match);
  if(!lines.length)return null;
  if(lines.length!==1)throw new Error('Legacy credential is ambiguous. Repair its duplicate entries before migrating.');
  let value=lines[0].line.slice(lines[0].line.indexOf('=')+1).trim();
  if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
  if(!safeApiKey(value))throw new Error('Legacy credential format is unsupported. Repair it locally before migrating.');
  return value;
}
/** Only an expressly selected project with an ignored, untracked .env may receive secrets. */
export function verifyProjectCredentialTarget(projectRoot, git = gitOk) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new Error('Select an absolute project directory first.');
  }
  const root = resolve(projectRoot);
  let rootInfo;
  try { rootInfo = lstatSync(root); } catch { throw new Error('Selected project is unavailable.'); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Project credential storage requires a real directory, not a link.');
  }
  if (!git(root, ['rev-parse', '--is-inside-work-tree'])) {
    throw new Error('Project-local credentials require a Git repository with .env ignored.');
  }
  if (git(root, ['ls-files', '--error-unmatch', '--', '.env'])) {
    throw new Error('Project .env is tracked by Git. Use private Babel storage instead.');
  }
  if (!git(root, ['check-ignore', '-q', '--', '.env'])) {
    throw new Error('Project .env is not Git-ignored. Add .env to .gitignore first, or use private Babel storage.');
  }
  verifyDirectory(root);
  const target = join(root, '.env');
  let info;
  try { info = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new Error('Project .env is not a regular, unlinked file.');
    }
  }
  return target;
}


/** Status only: no stored plaintext or ciphertext crosses IPC. */
export function providerCredentialStatus({provider,scope='private',configDirectory,projectRoot}={}){
  const name=providerName(provider);
  if(!['private','project'].includes(scope))throw new Error('Credential destination must be private or explicitly project-local.');
  if(!name)return {provider,scope,configured:true,storage:'none',protectionAvailable:protectionAvailable(),migrationAvailable:false};
  if(scope==='project'){
    const key=legacyKey(readSafe(verifyProjectCredentialTarget(projectRoot)),name);
    return {provider,scope,configured:Boolean(key),storage:'project-plaintext',protectionAvailable:protectionAvailable(),migrationAvailable:false};
  }
  const store=readStore(configDirectory),owned=Object.hasOwn(store.entries,provider);
  const legacy=owned?false:Boolean(legacyKey(readSafe(privateTarget(configDirectory)),name));
  return {provider,scope,configured:owned?store.entries[provider]!==null:legacy,storage:owned?'os-protected':legacy?'legacy-plaintext':'none',protectionAvailable:protectionAvailable(),migrationAvailable:legacy};
}
export function hasProviderCredential(options={}){return providerCredentialStatus(options).configured;}
function mutateProject(target,name,key,operation){
  return locked(target,()=>{
    const previous=readSafe(target),lines=entryLines(previous,name),present=lines.some(entry=>entry.match);
    if(operation==='add'&&present)throw new Error('This provider already has a setting. Choose Replace explicitly.');
    if(operation==='replace'&&!present)throw new Error('No saved credential exists to replace. Choose Add.');
    // Validate before replacing/removing; never discard a multiline or ambiguous value.
    if(present)legacyKey(previous,name);
    const retained=lines.filter(entry=>!entry.match).map(entry=>entry.line).join('');
    const next=key===null?retained:retained+(retained&&!retained.endsWith('\n')?'\n':'')+name+'='+key+'\n';
    atomicWrite(target,next);
  });
}
function mutatePrivate(configDirectory,provider,key,operation){
  requireProtection();const target=privateTarget(configDirectory,PROTECTED_CREDENTIAL_FILE,true);
  return locked(target,()=>{
    const store=readStore(configDirectory),owned=Object.hasOwn(store.entries,provider);
    if(!owned&&legacyKey(readSafe(privateTarget(configDirectory)),PROVIDERS[provider]))throw new Error('Migrate this legacy plaintext credential explicitly before replacing or removing it.');
    const present=owned&&store.entries[provider]!==null;
    if(operation==='add'&&present)throw new Error('This provider already has a setting. Choose Replace explicitly.');
    if(operation==='replace'&&!present)throw new Error('No saved credential exists to replace. Choose Add.');
    store.entries[provider]=key===null?null:encrypt(key);
    atomicWrite(target,JSON.stringify(store)+'\n');
  });
}
export function saveProviderCredential({provider,apiKey,scope='private',configDirectory,projectRoot,operation='add'}={}){
  const name=providerName(provider);
  if(!['private','project'].includes(scope))throw new Error('Credential destination must be private or explicitly project-local.');
  if(!['add','replace'].includes(operation))throw new Error('Choose Add or Replace explicitly.');
  if(name&&!safeApiKey(apiKey))throw new Error('API key must be one nonempty, single-line provider token.');
  if(name){if(scope==='private')mutatePrivate(configDirectory,provider,apiKey,operation);else mutateProject(verifyProjectCredentialTarget(projectRoot),name,apiKey,operation);}
  return {provider,scope,configured:true};
}
export function removeProviderCredential({provider,scope,configDirectory,projectRoot}={}){
  const name=providerName(provider);
  if(!name)throw new Error('This provider does not use a credential.');
  if(scope==='private')mutatePrivate(configDirectory,provider,null,'remove');
  else if(scope==='project')mutateProject(verifyProjectCredentialTarget(projectRoot),name,null,'remove');
  else throw new Error('Select an explicit credential destination.');
  return {provider,scope,configured:false};
}
/** Opt-in, single-provider atomic import. Original dotenv remains unchanged for recovery.
 * Retry observes the committed ownership marker, preserving later replacement/removal.
 */
export function migrateProviderCredential({provider,configDirectory,confirm}={}){
  const name=providerName(provider);if(!name||confirm!==true)throw new Error('Confirm migration and retention of the legacy plaintext recovery file.');
  requireProtection();const target=privateTarget(configDirectory,PROTECTED_CREDENTIAL_FILE,true);
  return locked(target,()=>{
    const store=readStore(configDirectory);
    if(Object.hasOwn(store.entries,provider))return {provider,scope:'private',migrated:false,recoveryRetained:true};
    const key=legacyKey(readSafe(privateTarget(configDirectory)),name);
    if(!key)throw new Error('No legacy credential is available to migrate.');
    store.entries[provider]=encrypt(key);store.migrations[provider]=true;
    atomicWrite(target,JSON.stringify(store)+'\n');
    return {provider,scope:'private',migrated:true,recoveryRetained:true};
  });
}
/** Native-only resolution: clear inherited provider secrets and load only the selected scope.
 * Successful handoff flags instruct the owned CLI to avoid reloading plaintext dotenv.
 */
export function applyNativeCredentialEnvironment(env,{provider,scope='private',configDirectory,projectRoot}={}){
  const removedNames=new Set([...Object.values(PROVIDERS).filter(Boolean),'OPENCODE_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','GROQ_API_KEY','BABEL_OPENCODE_GO_HELPER','BABEL_COMPACTION_API_KEY','BABEL_DESKTOP_CREDENTIALS_RESOLVED','BABEL_DESKTOP_IPC']);
  for(const name of Object.keys(env))if(removedNames.has(name.toUpperCase()))delete env[name];
  const name=providerName(provider);let key=null;
  if(name){
    if(scope==='project')key=legacyKey(readSafe(verifyProjectCredentialTarget(projectRoot)),name);
    else if(scope==='private'){
      const store=readStore(configDirectory);
      key=Object.hasOwn(store.entries,provider)?store.entries[provider]===null?null:decrypt(store.entries[provider]):legacyKey(readSafe(privateTarget(configDirectory)),name);
    }else throw new Error('Select an explicit credential destination.');
  }
  if(key)env[name]=key;
  delete env.BABEL_PROJECT_CREDENTIALS_DIR;delete env.BABEL_LEGACY_CLI_ENV;
  env.BABEL_DESKTOP_IPC='1';env.BABEL_DESKTOP_CREDENTIALS_RESOLVED='1';
  return env;
}

/** Node launcher cannot unlock OS storage; never silently resurrect retained legacy data. */
export function assertStandaloneCredentialCompatibility(configDirectory){
  const store=readStore(configDirectory);
  // Args and auxiliary calls can select providers other than the saved default.
  if(Object.keys(store.entries).length)throw new Error('This profile has Desktop-managed OS-protected credentials or removal markers. Run it in Babel Desktop; the standalone Node launcher cannot safely use this profile.');
}
