// License: Apache-2.0
// Measured startup work: compares how many engine child processes admission
// spawns before and after this change, using the real capability module.
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {assertCredentialEngineCapability,resetCredentialEngineCapabilityCache} from '../native/credential-engine.mjs';

const root=mkdtempSync(join(tmpdir(),'babel-startup-measure-'));
const counterFile=join(root,'probes.txt');
const entry=join(root,'engine.mjs');
writeFileSync(entry,`import {readFileSync,writeFileSync} from 'node:fs';
const file=${JSON.stringify(counterFile)};
let n=0;try{n=Number(readFileSync(file,'utf8'))||0;}catch{}
writeFileSync(file,String(n+1));
console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));`);

const engine={executable:process.execPath,path:entry};
const probeCount=()=>{try{return Number(readFileSync(counterFile,'utf8'))||0;}catch{return 0;}};
const round=async(label,turns)=>{
  resetCredentialEngineCapabilityCache();
  rmSync(counterFile,{force:true});
  const started=process.hrtime.bigint();
  for(let i=0;i<turns;i++)await assertCredentialEngineCapability(engine);
  const elapsedMs=Number(process.hrtime.bigint()-started)/1e6;
  return {label,turns,probes:probeCount(),elapsedMs:Math.round(elapsedMs*10)/10};
};
try{
  const results=[
    await round('cold admission (1 turn)',1),
    await round('warm sequential turns (10)',10),
    await round('concurrent admission (8)',8),
  ];
  process.stdout.write(`${JSON.stringify({machine:{platform:process.platform,node:process.version},results},null,2)}\n`);
  const warm=results[1];
  if(warm.probes!==1)throw new Error(`Warm turns spawned ${warm.probes} probes; expected exactly 1.`);
  if(results[2].probes!==1)throw new Error(`Concurrent admission spawned ${results[2].probes} probes; expected exactly 1.`);
}finally{rmSync(root,{recursive:true,force:true});}
