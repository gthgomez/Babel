// License: Apache-2.0
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
const execute=promisify(execFile);

/** Immutable engine identity: the capability fact depends only on these bytes. */
async function engineIdentity(runtime){
  const parts=[];
  for(const path of [runtime.path,runtime.executable]){
    try{
      const info=await stat(path,{bigint:true});
      if(!info.isFile())return null;
      parts.push(`${path}\u0000${info.dev}\u0000${info.ino}\u0000${info.size}\u0000${info.mtimeNs}`);
    }catch{return null;}
  }
  return parts.join('\u0001');
}

/** Successful capability facts keyed by verified runtime identity, never by time. */
const capabilityCache=new Map();
const inFlight=new Map();

/** Test/engine-change reset. Never exposed over IPC. */
export function resetCredentialEngineCapabilityCache(){capabilityCache.clear();inFlight.clear();}

/**
 * Probe before resolving any key. Old CLI commands receive a disposable empty profile.
 *
 * Only the immutable capability fact is cached, and only for a byte-identical
 * executable/entry pair: a replaced binary or engine invalidates it. The probe
 * neither reads nor carries credentials, so the cache cannot leak a key.
 */
export async function assertCredentialEngineCapability(runtime){
  if(!runtime||typeof runtime.path!=='string'||!runtime.path||typeof runtime.executable!=='string'||!runtime.executable)throw new Error('The Babel CLI is unavailable, so its native credential capability cannot be verified. Select or rebuild the CLI before running this provider.');
  const identity=await engineIdentity(runtime);
  if(!identity)throw new Error('The Babel CLI files are missing or unreadable, so its native credential capability cannot be verified. Repair or rebuild the CLI before running this provider.');
  if(capabilityCache.get(identity)===true)return true;
  // Single-flight: concurrent callers share one probe instead of spawning many.
  const existing=inFlight.get(identity);
  if(existing)return existing;
  const probe=probeCapability(runtime).then(ok=>{capabilityCache.set(identity,true);return ok;}).finally(()=>inFlight.delete(identity));
  inFlight.set(identity,probe);
  return probe;
}

async function probeCapability(runtime){
  const root=await mkdtemp(join(tmpdir(),'babel-credential-capability-'));
  let stdout;
  try{
    const config=join(root,'config');await mkdir(config,{mode:0o700});
    const env={};
    for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
    Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,BABEL_CONFIG_DIR:config,BABEL_STATE_DIR:join(root,'state'),BABEL_CACHE_DIR:join(root,'cache'),BABEL_RUNS_DIR:join(root,'runs'),ELECTRON_RUN_AS_NODE:'1',BABEL_LITE_OFFLINE:'1',BABEL_DAEMON_ENABLED:'false'});
    ({stdout}=await execute(runtime.executable,[runtime.path,'--desktop-capabilities'],{cwd:root,env,windowsHide:true,timeout:8000,maxBuffer:4096}));
  }catch(error){
    // Distinguish the causes the caller can actually act on. A timeout or a
    // missing executable is not evidence that the CLI is unsupported.
    const timedOut=error?.killed===true||error?.signal==='SIGTERM'||error?.code==='ETIMEDOUT';
    if(timedOut)throw new Error('The CLI did not answer its native credential capability check within 8 seconds. Retry, and verify the installed CLI and Node runtime.');
    if(error?.code==='ENOENT')throw new Error('The selected CLI executable or its Node runtime is missing. Repair the installation before running this provider.');
    if(error?.code==='EACCES'||error?.code==='EPERM')throw new Error('The selected CLI executable could not be run. Check file permissions or antivirus policy, then retry.');
    throw new Error('The CLI capability check failed before it produced a result. Verify the installed CLI starts, then retry.');
  }finally{
    try{await rm(root,{recursive:true,force:true});}catch{throw new Error('Native credential capability temporary profile cleanup failed. Check local storage before retrying.');}
  }
  let value;
  try{value=JSON.parse(String(stdout??'').trim());}catch{throw new Error('The selected CLI returned an unreadable capability response. Rebuild or update the CLI before running this provider.');}
  if(value?.schemaVersion!==1||value?.credentialEnvironment!=='native-resolved-v1')throw new Error('The selected CLI does not support the native credential capability. Update or rebuild the CLI before running this provider.');
  return true;
}
