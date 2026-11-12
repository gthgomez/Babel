import {mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';

const PROCESS_TYPES=new Set(['renderer','Browser','Tab','Utility','Zygote','Sandbox helper','GPU','Pepper Plugin','Pepper Plugin Broker','Unknown']);
const REASONS=new Set(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction']);

// Record only bounded technical facts. Renderer messages, service names, URLs,
// project paths, and other event data can contain private user content.
export function createCrashDiagnosticRecorder({directory,build,clock=()=>new Date(),maxBytes=256*1024}){
  let queue=Promise.resolve();
  const safeBuild={
    version:typeof build?.version==='string'&&/^[0-9A-Za-z.+-]{1,80}$/.test(build.version)?build.version:null,
    sourceSha:typeof build?.sourceSha==='string'&&/^[0-9a-f]{40}$/i.test(build.sourceSha)?build.sourceSha:null,
  };
  return (processType,details={})=>{
    const item={
      version:1,
      processType:PROCESS_TYPES.has(processType)?processType:'Unknown',
      reason:REASONS.has(details.reason)?details.reason:'unknown',
      exitCode:Number.isSafeInteger(details.exitCode)?details.exitCode:null,
      time:clock().toISOString(),
      build:safeBuild,
    };
    const line=`${JSON.stringify(item)}\n`;
    const write=async()=>{
      const folder=join(directory,'diagnostics');
      await mkdir(folder,{recursive:true});
      const file=await open(join(folder,'desktop-crashes.jsonl'),'a+',0o600);
      try{
        const current=await file.stat();
        if(current.size+Buffer.byteLength(line)>maxBytes)return false;
        await file.writeFile(line);
        await file.sync();
        return true;
      }finally{await file.close();}
    };
    const result=queue.then(write);
    queue=result.catch(()=>{});
    return result;
  };
}
