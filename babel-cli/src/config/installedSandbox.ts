// License: Apache-2.0
import {randomUUID} from 'node:crypto';

type DockerResult={status:number|null;stdout?:string|Buffer;error?:unknown};
type DockerExecute=(binary:'docker',args:string[],options:{env:NodeJS.ProcessEnv;shell:false;windowsHide:true;encoding:'utf8';timeout:number;maxBuffer:number})=>DockerResult;

/** Check execution prerequisites without mounting a project or passing provider credentials. */
export function probeInstalledSandboxImage(image:string|undefined,options:{env?:NodeJS.ProcessEnv;execute:DockerExecute}):boolean{
  if(typeof image!=='string'||!image.length||image.length>512||image.includes('://')||!/^[a-z0-9][a-z0-9._/:@-]*$/i.test(image))return false;
  const source=options.env??process.env,env:NodeJS.ProcessEnv={};
  for(const name of ['PATH','SystemRoot','WINDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']){
    if(source[name]!==undefined)env[name]=source[name];
  }
  // Installed diagnostics owns the registered host-process boundary. This
  // capability probe only constructs fixed Docker requests through that port.
  const execute=options.execute;
  const run=(args:string[],timeout:number)=>execute('docker',args,{env,shell:false,windowsHide:true,encoding:'utf8',timeout,maxBuffer:256*1024});
  try{
    const inspected=run(['image','inspect','--format','{{json .}}','--',image],3000);
    if(inspected.error||inspected.status!==0)return false;
    const record=JSON.parse(String(inspected.stdout??'')) as {Id?:unknown;Os?:unknown;Architecture?:unknown};
    if(record.Os!=='linux'||record.Architecture!=='amd64'||typeof record.Id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(record.Id))return false;
    const marker=`babel-sandbox-${randomUUID()}`;
    for(const command of [['git','--version'],['/bin/sh','-lc',`git --version >/dev/null && printf '%s\\n' '${marker}'`]]){
      const containerName=`babel-doctor-${randomUUID()}`;
      try{
        const probe=run(['run','--rm',`--name=${containerName}`,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
          '--pids-limit=64','--memory=256m','--cpus=1','--user=65534:65534','--tmpfs=/tmp:rw,nosuid,size=32m',
          '--env=HOME=/tmp',record.Id,...command],5000);
        if(probe.error||probe.status!==0)return false;
        const lines=String(probe.stdout??'').split(/\r?\n/);
        if(command[0]==='git'?!lines.some(line=>/^git version \d+\.\d+(?:\.[0-9A-Za-z]+)*$/.test(line)):!lines.includes(marker))return false;
      }finally{
        // Client timeout does not terminate the daemon-owned container.
        try{run(['rm','--force',containerName],1500);}catch{}
      }
    }
    return true;
  }catch{return false;}
}
