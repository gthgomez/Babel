// License: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
async function probe(source){
 const root=mkdtempSync(join(tmpdir(),'babel-capability-fixture-'));
 try{const path=join(root,'fixture.mjs');writeFileSync(path,source);const module=await import('../native/credential-engine.mjs');return await module.assertCredentialEngineCapability({executable:process.execPath,path});}
 finally{rmSync(root,{recursive:true,force:true});}
}
test('credential engine capability is probed without ambient keys or credential directories',async()=>{
 let accepted=false;
 try{accepted=await probe(`import {existsSync} from 'node:fs';if(process.argv[2]!=='--desktop-capabilities'||process.env.DEEPSEEK_API_KEY||process.env.BABEL_PROJECT_CREDENTIALS_DIR||!existsSync(process.env.HOME))process.exit(3);console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));`);}catch{}
 assert.equal(accepted,true);
});
test('old or malformed CLI capability responses fail closed',async()=>{
 await assert.rejects(()=>probe(`console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'legacy'}));`),/does not support|capability/);
 await assert.rejects(()=>probe(`process.stderr.write('BabelCapabilityErrorCanary0000');process.exit(2);`),error=>!String(error).includes('BabelCapabilityErrorCanary0000')&&/capability|does not support/.test(String(error)));
});
