// License: Apache-2.0
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
const execute=promisify(execFile);
/** Probe before resolving any key. Old CLI commands receive a disposable empty profile.
 * No cached capability survives an engine change; stdout/stderr never cross IPC.
 */
export async function assertCredentialEngineCapability(runtime){
  const root=await mkdtemp(join(tmpdir(),'babel-credential-capability-'));
  try{
    const config=join(root,'config');await mkdir(config,{mode:0o700});
    const env={};
    for(const name of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
    Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,BABEL_CONFIG_DIR:config,BABEL_STATE_DIR:join(root,'state'),BABEL_CACHE_DIR:join(root,'cache'),BABEL_RUNS_DIR:join(root,'runs'),ELECTRON_RUN_AS_NODE:'1',BABEL_LITE_OFFLINE:'1',BABEL_DAEMON_ENABLED:'false'});
    const {stdout}=await execute(runtime.executable,[runtime.path,'--desktop-capabilities'],{cwd:root,env,windowsHide:true,timeout:8000,maxBuffer:4096});
    const value=JSON.parse(stdout.trim());
    if(value.schemaVersion!==1||value.credentialEnvironment!=='native-resolved-v1')throw new Error();
    return true;
  }catch{throw new Error('The selected CLI does not support the native credential capability. Update or rebuild the CLI before running this provider.');}
  finally{try{await rm(root,{recursive:true,force:true});}catch{throw new Error('Native credential capability temporary profile cleanup failed. Check local storage before retrying.');}}
}
