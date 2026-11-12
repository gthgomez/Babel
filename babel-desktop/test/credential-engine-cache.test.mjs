// License: Apache-2.0
// Startup work: capability facts are cached only for a byte-identical engine,
// concurrent probes are single-flighted, and no credential accompanies a probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,utimesSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertCredentialEngineCapability,resetCredentialEngineCapabilityCache} from '../native/credential-engine.mjs';

let counter=0;
/** A fixture CLI that counts its own invocations through a shared counter file. */
function fixtureEngine(root,{behaviour='support'}={}){
  const dir=mkdtempSync(join(root,'engine-'));
  // The probe runs with cwd inside its own disposable profile, so the counter
  // must live at a stable absolute path outside the probe's temporary root.
  const counterFile=join(root,`counter-${++counter}.txt`);
  const path=join(dir,`engine-${counter}.mjs`);
  const body=behaviour==='support'
    ? `import {readFileSync,writeFileSync} from 'node:fs';const file=${JSON.stringify(counterFile)};let n=0;try{n=Number(readFileSync(file,'utf8'))||0;}catch{}writeFileSync(file,String(n+1));if(process.env.DEEPSEEK_API_KEY||process.env.OPENROUTER_API_KEY||process.env.BABEL_PROJECT_CREDENTIALS_DIR)process.exit(9);if(process.argv[2]!=='--desktop-capabilities')process.exit(8);console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'native-resolved-v1'}));`
    : behaviour==='legacy'
    ? `console.log(JSON.stringify({schemaVersion:1,credentialEnvironment:'legacy'}));`
    : behaviour==='hang'
    ? `setTimeout(()=>{},60000);`
    : behaviour==='garbage'
    ? `console.log('not json at all');`
    : `process.stderr.write('BabelCapabilityCanary0000');process.exit(3);`;
  writeFileSync(path,body);
  return {executable:process.execPath,path,counterFile};
}
async function withRoot(body){
  const root=mkdtempSync(join(tmpdir(),'babel-capability-'));
  resetCredentialEngineCapabilityCache();
  try{return await body(root);}finally{resetCredentialEngineCapabilityCache();rmSync(root,{recursive:true,force:true});}
}

test('a supported engine is probed once and reused for the same identity',async()=>withRoot(async root=>{
  const engine=fixtureEngine(root);
  assert.equal(await assertCredentialEngineCapability(engine),true);
  assert.equal(readFileSync(engine.counterFile,'utf8'),'1');
  for(let i=0;i<5;i++)assert.equal(await assertCredentialEngineCapability(engine),true);
  assert.equal(readFileSync(engine.counterFile,'utf8'),'1','A warm chat must not re-probe a verified engine.');
}));

test('concurrent callers share one probe instead of spawning many',async()=>withRoot(async root=>{
  const engine=fixtureEngine(root);
  const results=await Promise.all(Array.from({length:6},()=>assertCredentialEngineCapability(engine)));
  assert.deepEqual(results,[true,true,true,true,true,true]);
  assert.equal(readFileSync(engine.counterFile,'utf8'),'1','Concurrent admission must single-flight the probe.');
}));

test('a replaced engine invalidates the cached capability fact',async()=>withRoot(async root=>{
  const engine=fixtureEngine(root);
  await assertCredentialEngineCapability(engine);
  assert.equal(readFileSync(engine.counterFile,'utf8'),'1');
  // Rewrite the entry: a new file identity or content must force a fresh probe.
  writeFileSync(engine.path,`${readFileSync(engine.path,'utf8')}\n// rebuilt`);
  const future=new Date(Date.now()+5000);utimesSync(engine.path,future,future);
  await assertCredentialEngineCapability(engine);
  assert.equal(readFileSync(engine.counterFile,'utf8'),'2','A rebuilt CLI must be probed again.');
}));

test('an unsupported or unreadable response fails closed with an actionable message',async()=>withRoot(async root=>{
  for(const behaviour of ['legacy','garbage','crash']){
    resetCredentialEngineCapabilityCache();
    const engine=fixtureEngine(root,{behaviour});
    await assert.rejects(()=>assertCredentialEngineCapability(engine),/capability|unreadable/i);
    // A failed probe is never cached as success.
    await assert.rejects(()=>assertCredentialEngineCapability(engine),/capability|unreadable/i);
  }
}));

test('a hung probe reports a timeout, not an unsupported CLI',async()=>withRoot(async root=>{
  const engine=fixtureEngine(root,{behaviour:'hang'});
  await assert.rejects(()=>assertCredentialEngineCapability(engine),error=>{
    assert.match(error.message,/within 8 seconds/i);
    assert.doesNotMatch(error.message,/does not support/i);
    return true;
  });
}));

test('a missing engine or executable reports the missing file rather than an unsupported CLI',async()=>withRoot(async root=>{
  const engine=fixtureEngine(root);
  await assert.rejects(()=>assertCredentialEngineCapability({...engine,path:join(root,'absent.mjs')}),/missing or unreadable/i);
  await assert.rejects(()=>assertCredentialEngineCapability({...engine,executable:join(root,'absent-node.exe')}),/missing or unreadable/i);
  await assert.rejects(()=>assertCredentialEngineCapability(null),/unavailable/i);
}));

test('a credential-bearing environment never reaches the probe',async()=>withRoot(async root=>{
  // The fixture exits 9 if any provider credential or credential directory is
  // inherited. Values are inert placeholders, never credential-shaped.
  const names=['DEEPSEEK_API_KEY','OPENROUTER_API_KEY','BABEL_PROJECT_CREDENTIALS_DIR'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  process.env[names[0]]='inherit-canary-one';
  process.env[names[1]]='inherit-canary-two';
  process.env[names[2]]=root;
  try{
    const engine=fixtureEngine(root);
    assert.equal(await assertCredentialEngineCapability(engine),true);
  }finally{
    for(const [name,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
  }
}));
