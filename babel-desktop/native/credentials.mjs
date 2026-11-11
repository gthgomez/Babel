// License: Apache-2.0
// Native-only credential owner. Renderer receives status and write receipts only.
import {closeSync,fstatSync,lstatSync,mkdirSync,openSync,readSync,renameSync,rmSync,writeFileSync,fsyncSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const PROVIDERS=Object.freeze({deepseek:'DEEPSEEK_API_KEY',deepinfra:'DEEPINFRA_API_KEY',openrouter:'OPENROUTER_API_KEY','command-code':'COMMAND_CODE_API_KEY','opencode-go':'BABEL_OPENCODE_GO_API_KEY',ollama:null});
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
function emptyStore(){return {schemaVersion:1,entries:{},migrations:{},revisions:{},superseded:{}};}
function readStore(configDirectory){
  const raw=readSafe(privateTarget(configDirectory,PROTECTED_CREDENTIAL_FILE),null);
  if(raw===null)return emptyStore();
  try{
    const value=JSON.parse(raw);
    if(value.schemaVersion!==1||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries)||!value.migrations||typeof value.migrations!=='object'||Array.isArray(value.migrations))throw new Error();
    for(const [provider,entry] of Object.entries(value.entries))if(!Object.hasOwn(PROVIDERS,provider)||!PROVIDERS[provider]||(entry!==null&&(typeof entry!=='string'||entry.length<4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry))))throw new Error();
    for(const [provider,entry] of Object.entries(value.migrations))if(!Object.hasOwn(PROVIDERS,provider)||entry!==true||!Object.hasOwn(value.entries,provider))throw new Error();
    // Revision and supersede markers are optional so stores written by earlier
    // builds stay readable; an unknown marker is a hard error, never a guess.
    for(const field of ['revisions','superseded']){
      if(value[field]===undefined){value[field]={};continue;}
      if(!value[field]||typeof value[field]!=='object'||Array.isArray(value[field]))throw new Error();
      for(const [provider,entry] of Object.entries(value[field])){
        if(!Object.hasOwn(PROVIDERS,provider)||!Object.hasOwn(value.entries,provider))throw new Error();
        if(field==='revisions'&&(typeof entry!=='string'||!/^[a-f0-9-]{16,64}$/.test(entry)))throw new Error();
        if(field==='superseded'&&entry!==true)throw new Error();
      }
    }
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


/** The canonical operation names. Earlier builds sent add/replace over IPC. */
const OPERATIONS=Object.freeze({
  add_new:'add_new',replace_protected:'replace_protected',migrate_existing_legacy:'migrate_existing_legacy',
  supersede_legacy_with_new:'supersede_legacy_with_new',keep_existing_route_only:'keep_existing_route_only',
  remove:'remove',continue_with_legacy:'continue_with_legacy',
});
const LEGACY_OPERATIONS=Object.freeze({add:'add_new',replace:'replace_protected',remove:'remove'});
export function normalizeCredentialOperation(operation){
  const value=LEGACY_OPERATIONS[operation]??operation;
  if(!Object.hasOwn(OPERATIONS,value))throw new Error('Choose an explicit credential action.');
  return value;
}

/** Nonsecret identity of a legacy plaintext file: size and mtime only, never content. */
function fileIdentity(target,prefix){
  const info=lstatSync(target);
  if(!info.isFile())return null;
  return `${prefix}:${info.size}:${Math.trunc(info.mtimeMs)}`;
}
/** Status only: no stored plaintext or ciphertext crosses IPC. Read-only and network-free. */
export function providerCredentialStatus({provider,scope='private',configDirectory,projectRoot}={}){
  const name=providerName(provider);
  if(!['private','project'].includes(scope))throw new Error('Credential destination must be private or explicitly project-local.');
  const base={provider,scope,protectionAvailable:protectionAvailable()};
  if(!name)return {...base,configured:true,present:false,storage:'none',ownedProtectedEntry:false,legacyPresent:false,legacySuperseded:false,migrationAvailable:false,credentialRevision:null,credentialIdentity:null,authentication:unknownAuthentication()};
  if(scope==='project'){
    const target=verifyProjectCredentialTarget(projectRoot);
    const key=legacyKey(readSafe(target),name);
    let identity=null;
    if(key){try{identity=fileIdentity(target,'project');}catch{/* identity unavailable */}}
    return {...base,configured:Boolean(key),present:Boolean(key),storage:'project-plaintext',ownedProtectedEntry:false,legacyPresent:Boolean(key),legacySuperseded:false,migrationAvailable:false,credentialRevision:null,credentialIdentity:identity,authentication:unknownAuthentication()};
  }
  const store=readStore(configDirectory),owned=Object.hasOwn(store.entries,provider);
  const ownedPresent=owned&&store.entries[provider]!==null, tombstoned=owned&&store.entries[provider]===null;
  let legacy=false,legacyFile=null;
  try{
    const target=privateTarget(configDirectory);
    legacy=Boolean(legacyKey(readSafe(target),name));
    if(legacy)legacyFile=target;
  }catch(error){if(!tombstoned&&!ownedPresent)throw error;}
  // An owned entry (including a removal tombstone) always outranks the retained
  // legacy file, so a removed key is never resurrected from plaintext.
  const legacyEffective=legacy&&!owned&&!store.superseded[provider];
  let legacyIdentity=null;
  if(legacyEffective&&legacyFile){try{legacyIdentity=fileIdentity(legacyFile,'legacy');}catch{/* unavailable */}}
  const revision=store.revisions[provider]??null;
  return {
    ...base,
    configured:ownedPresent||legacyEffective,
    present:ownedPresent||legacyEffective,
    storage:ownedPresent?'os-protected':legacyEffective?'legacy-plaintext':'none',
    ownedProtectedEntry:ownedPresent,
    legacyPresent:legacy,
    legacySuperseded:tombstoned||store.superseded[provider]===true,
    tombstoned,
    migrationAvailable:legacyEffective&&protectionAvailable(),
    credentialRevision:revision,
    // A legacy key has no revision, but a stale authorization result still must
    // not survive an out-of-band edit. This identity is a file fact, not a hash.
    credentialIdentity:ownedPresent?revision:legacyIdentity,
    authentication:unknownAuthentication(),
  };
}
export function unknownAuthentication(reason='not_checked'){
  return {state:'not_checked',reason,checkedAt:null,observedRevision:null};
}
export function hasProviderCredential(options={}){return providerCredentialStatus(options).configured;}
function mutateProject(target,name,key,operation){
  locked(target,()=>{
    const previous=readSafe(target),lines=entryLines(previous,name),present=lines.some(entry=>entry.match);
    if(operation==='add_new'&&present)throw new Error('This provider already has a setting. Choose Replace explicitly.');
    if(operation==='replace_protected'&&!present)throw new Error('No saved credential exists to replace. Choose Add.');
    // Validate before replacing/removing; never discard a multiline or ambiguous value.
    if(present)legacyKey(previous,name);
    const retained=lines.filter(entry=>!entry.match).map(entry=>entry.line).join('');
    const next=key===null?retained:retained+(retained&&!retained.endsWith('\n')?'\n':'')+name+'='+key+'\n';
    atomicWrite(target,next);
  });
  return {storage:'project-plaintext',revision:null,credentialChanged:true,supersededLegacy:false,authenticated:false};
}
function nextRevision(store,provider){
  const revision=randomUUID();
  store.revisions[provider]=revision;
  return revision;
}
function mutatePrivate(configDirectory,provider,key,operation){
  requireProtection();const target=privateTarget(configDirectory,PROTECTED_CREDENTIAL_FILE,true);
  return locked(target,()=>{
    const store=readStore(configDirectory),owned=Object.hasOwn(store.entries,provider);
    const present=owned&&store.entries[provider]!==null;
    const legacy=legacyKey(readSafe(privateTarget(configDirectory)),PROVIDERS[provider]);
    // Persist the revision with the store; a receipt never claims a revision the
    // durable record does not contain.
    const commit=(credentialChanged,supersededLegacy,extra={})=>{
      const revision=nextRevision(store,provider);
      atomicWrite(target,JSON.stringify(store)+'\n');
      return {present:true,storage:'os-protected',revision,credentialChanged,supersededLegacy,authenticated:false,...extra};
    };
    if(operation==='add_new'||operation==='replace_protected'){
      // A legacy-only profile must choose explicitly; a silent overwrite would
      // destroy the user's only working credential without consent. Report this
      // before the empty-slot error because migrating is the real next action.
      if(legacy&&!owned)throw new Error('A legacy plaintext key exists. Migrate it, continue using it, or supersede it with a new protected key. No changes were made.');
      if(operation==='add_new'&&present)throw new Error('This provider already has a setting. Choose Replace explicitly.');
      if(operation==='replace_protected'&&!present)throw new Error('No saved credential exists to replace. Choose Add.');
      store.entries[provider]=encrypt(key);
      return commit(true,false);
    }
    if(operation==='supersede_legacy_with_new'){
      if(present)throw new Error('An OS-protected credential already exists. Choose Replace explicitly.');
      if(!legacy)throw new Error('No legacy plaintext credential is available to supersede.');
      // Store the new key protected and mark the retained legacy file superseded
      // so it can never be read again by this profile. Original bytes are kept.
      store.entries[provider]=encrypt(key);store.superseded[provider]=true;
      return commit(true,true);
    }
    if(operation==='keep_existing_route_only'){
      // A legacy-only profile must choose `continue_with_legacy` explicitly; a
      // plain "keep" would read as a successful first-run configuration.
      if(legacy&&!present)throw new Error('Only a legacy plaintext key is stored. Choose to replace it with OS-protected storage, or deliberately continue using the unverified legacy key.');
      if(!present)throw new Error('No saved credential exists to keep. Enter a new key.');
      return {present:true,storage:'os-protected',revision:store.revisions[provider]??null,credentialChanged:false,supersededLegacy:false,authenticated:false};
    }
    if(operation==='continue_with_legacy'){
      if(owned)throw new Error('This provider already has an OS-protected setting; legacy mode is unavailable.');
      if(!legacy)throw new Error('No legacy plaintext credential is available to continue using.');
      // Explicit compatibility mode: nothing is written and nothing is copied.
      return {present:true,storage:'legacy-plaintext',revision:null,credentialChanged:false,supersededLegacy:false,legacyAcknowledged:true,authenticated:false};
    }
    if(operation==='remove'){
      if(!owned)throw new Error('Migrate this legacy plaintext credential explicitly before removing it.');
      store.entries[provider]=null;delete store.superseded[provider];
      return {...commit(true,false),present:false,storage:'none'};
    }
    if(operation==='migrate_existing_legacy'){
      // Migration of the retained plaintext key into protected storage has its
      // own entry point (migrateProviderCredential) so the recovery file and its
      // consent are handled once. Reaching here means the caller bypassed it.
      throw new Error('Migrate the legacy key explicitly, retaining the original file for recovery.');
    }
    throw new Error('Choose an explicit credential action.');
  });
}
export function saveProviderCredential({provider,apiKey,scope='private',configDirectory,projectRoot,operation='add_new'}={}){
  const name=providerName(provider);
  if(!['private','project'].includes(scope))throw new Error('Credential destination must be private or explicitly project-local.');
  const action=normalizeCredentialOperation(operation);
  if(!name&&action!=='keep_existing_route_only')throw new Error('This provider does not use a credential.');
  if(name&&['add_new','replace_protected','supersede_legacy_with_new'].includes(action)&&!safeApiKey(apiKey))throw new Error('API key must be one nonempty, single-line provider token.');
  if(!name)return {provider,scope,configured:true,present:false,storage:'none',credentialChanged:false,revision:null};
  let outcome={storage:'none',revision:null,credentialChanged:false};
  if(action==='continue_with_legacy'||action==='keep_existing_route_only'){
    if(scope!=='private')throw new Error('Legacy continuation applies to the private profile only.');
    outcome=mutatePrivate(configDirectory,provider,apiKey,action);
  }else if(scope==='private')outcome=mutatePrivate(configDirectory,provider,apiKey,action);
  else outcome=mutateProject(verifyProjectCredentialTarget(projectRoot),name,apiKey,action);
  return {provider,scope,configured:outcome.present===true,revision:outcome.revision??null,...outcome};
}
export function removeProviderCredential({provider,scope,configDirectory,projectRoot}={}){
  const name=providerName(provider);
  if(!name)throw new Error('This provider does not use a credential.');
  let outcome;
  if(scope==='private')outcome=mutatePrivate(configDirectory,provider,null,'remove');
  else if(scope==='project')outcome=mutateProject(verifyProjectCredentialTarget(projectRoot),name,null,'remove');
  else throw new Error('Select an explicit credential destination.');
  return {provider,scope,configured:false,present:false,storage:'none',revision:outcome.revision??null,credentialChanged:true};
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
    const revision=nextRevision(store,provider);
    atomicWrite(target,JSON.stringify(store)+'\n');
    return {provider,scope:'private',migrated:true,recoveryRetained:true,revision};
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
      // An owned entry, including a removal tombstone, always outranks the
      // retained legacy file; a superseded legacy key is never resolved again.
      if(Object.hasOwn(store.entries,provider))key=store.entries[provider]===null?null:decrypt(store.entries[provider]);
      else if(!store.superseded[provider])key=legacyKey(readSafe(privateTarget(configDirectory)),name);
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
