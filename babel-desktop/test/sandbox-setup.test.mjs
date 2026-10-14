import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applySandboxEnvironment,configureSandboxImage,RECOMMENDED_IMAGE,validateSandboxImageReference} from '../native/sandbox-setup.mjs';
import {parsePreferences} from '../native/security.mjs';

const id=`sha256:${'a'.repeat(64)}`;
const inspect={Id:id,Os:'linux',Architecture:'amd64'};
test('setup rejects successful no-op entrypoints and unrelated output',async()=>{
  for(const stdout of ['', 'container started\n', 'git version 2.39.5\n']){
    await assert.rejects(()=>configureSandboxImage({reference:'custom:v1',execute:async(_binary,args)=>({stdout:args[0]==='image'?JSON.stringify(inspect):stdout})}),/verification failed/);
  }
});

test('a non-forwarding image entrypoint cannot be bypassed by setup validation',async()=>{
  await assert.rejects(()=>configureSandboxImage({reference:'custom:v1',execute:async(_binary,args)=>{
    if(args[0]==='run'&&!args.some(arg=>arg.startsWith('--entrypoint')))throw new Error('Synthetic non-forwarding entrypoint');
    return {stdout:JSON.stringify(inspect)};
  }}),/verification failed/);
});

test('image references reject argument, shell and control-character payloads',()=>{
  for(const value of ['',null,'--help','node:24;echo bad','node:24\nother','node:24 bad','https://registry/node','x'.repeat(513)]){
    assert.throws(()=>validateSandboxImageReference(value));
  }
  for(const value of ['node:24-bookworm','registry.example:5000/team/tools:v1',RECOMMENDED_IMAGE,id])assert.equal(validateSandboxImageReference(value),value);
});

test('preparation pulls only the fixed digest and verifies platform/tools before returning configuration',async()=>{
  const calls=[];
  const execute=async(binary,args,options)=>{
    calls.push({binary,args,options});
    assert.equal(binary,'docker');assert.equal(options.shell,false);
    assert.ok(options.timeout>0&&options.timeout<=300000);assert.ok(options.maxBuffer<=256*1024);
    return {stdout:args[0]==='image'?JSON.stringify(inspect):args[0]==='run'?
      `container started\n${args.at(-2)==='git'?'git version 2.39.5':args.at(-1).match(/babel-sandbox-[a-f0-9-]{36}/)?.[0]}\n`:''};
  };
  const result=await configureSandboxImage({prepareRecommended:true,execute});
  assert.equal(calls[0].args[0],'pull');assert.equal(calls[0].args.at(-1),RECOMMENDED_IMAGE);
  const probe=calls.find(call=>call.args[0]==='run');
  assert.ok(probe.args.includes('--network=none'));assert.ok(probe.args.includes('--read-only'));
  assert.ok(probe.args.includes('--cap-drop=ALL'));assert.ok(!probe.args.some(arg=>arg.startsWith('--entrypoint')));
  const probes=calls.filter(call=>call.args[0]==='run');
  assert.equal(probes.length,2);assert.deepEqual(probes[0].args.slice(-2),['git','--version']);
  assert.equal(probes[1].args.at(-3),'/bin/sh');assert.equal(probes[1].args.at(-2),'-lc');
  assert.ok(probe.args.includes(id));assert.ok(!probe.args.includes('-v'));
  assert.equal(result.sandboxImage,id);assert.equal(result.sandboxImageReference,RECOMMENDED_IMAGE);
});

test('custom validation does not pull and never accepts missing, incompatible or unusable images',async()=>{
  for(const failure of ['missing','windows','arm64','capability']){
    const calls=[];
    const execute=async(_binary,args)=>{
      calls.push(args);assert.notEqual(args[0],'pull');
      if(failure==='missing'||(failure==='capability'&&args[0]==='run'))throw new Error('synthetic private daemon detail');
      return {stdout:JSON.stringify({...inspect,...(failure==='windows'?{Os:'windows'}:{}),...(failure==='arm64'?{Architecture:'arm64'}:{})})};
    };
    await assert.rejects(()=>configureSandboxImage({reference:'custom/toolchain:v1',execute}),error=>!error.message.includes('private daemon detail'));
  }
});

test('saved configuration pins the exact inspected image for Desktop and CLI environments',()=>{
  const preferences=parsePreferences({sandboxImage:id,sandboxImageReference:'custom/toolchain:v1'});
  assert.equal(preferences.sandboxImage,id);
  assert.equal(preferences.sandboxImageReference,'custom/toolchain:v1');
  const env={BABEL_BENCHMARK_DOCKER_IMAGE:'another/image:latest'};
  assert.equal(applySandboxEnvironment(env,preferences),env);
  assert.equal(env.BABEL_BENCHMARK_DOCKER_IMAGE,id);
  assert.equal(parsePreferences({sandboxImage:'--unsafe'}).sandboxImage,null);
});

test('a failed or timed-out preparation probe cleans up only its own container',async()=>{
  const calls=[];
  await assert.rejects(()=>configureSandboxImage({reference:'custom:v1',execute:async(_binary,args)=>{
    calls.push(args);
    if(args[0]==='run')throw new Error('synthetic timeout');
    return {stdout:JSON.stringify(inspect)};
  }}),/verification failed/);
  const name=calls[1].find(arg=>arg.startsWith('--name=')).slice(7);
  assert.match(name,/^babel-setup-[a-f0-9-]{36}$/);
  assert.deepEqual(calls[2],['rm','--force',name]);
});
