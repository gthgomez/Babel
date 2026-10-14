import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeInstalledSandboxImage} from './installedSandbox.js';

const id=`sha256:${'b'.repeat(64)}`;
test('installed image probe rejects missing/option/shell values before spawning',()=>{
  for(const image of [undefined,'','--help','node:24;echo bad','node:24 bad']){
    assert.equal(probeInstalledSandboxImage(image,{execute:()=>{throw new Error('must not execute');}}),false);
  }
});

test('installed image probe verifies local linux amd64 shell and Git without mounts or credential environment',()=>{
  const calls:Array<{args:string[];options:any}>=[];
  const execute=(_binary:string,args:string[],options:any)=>{
    calls.push({args,options});
    assert.equal(options.shell,false);assert.ok(options.timeout<=8000);
    assert.equal(options.env.OPENROUTER_API_KEY,undefined);
    return {status:0,stdout:args[0]==='image'?JSON.stringify({Id:id,Os:'linux',Architecture:'amd64'}):'',stderr:''};
  };
  assert.equal(probeInstalledSandboxImage(id,{execute,env:{OPENROUTER_API_KEY:'synthetic',PATH:'fixture'}}),true);
  assert.equal(calls.length,3);
  assert.ok(calls[1]!.args.includes('--network=none'));assert.ok(calls[1]!.args.includes('--read-only'));
  assert.ok(calls[1]!.args.includes('--entrypoint=/bin/sh'));assert.ok(calls[1]!.args.includes(id));
  assert.ok(!calls[1]!.args.includes('-v'));
  assert.deepEqual(calls[2]!.args,['rm','--force',calls[1]!.args.find(arg=>arg.startsWith('--name='))!.slice(7)]);
});

test('missing, incompatible, timed out and capability failures remain unavailable',()=>{
  for(const failure of ['missing','windows','arm64','timeout','capability']){
    const execute=(_binary:string,args:string[])=>({
      status:failure==='missing'||(failure==='capability'&&args[0]==='run')?1:0,
      ...(failure==='timeout'?{error:new Error('synthetic timeout')}:{}),
      stdout:JSON.stringify({Id:id,Os:failure==='windows'?'windows':'linux',Architecture:failure==='arm64'?'arm64':'amd64'}),stderr:'',
    });
    assert.equal(probeInstalledSandboxImage(id,{execute}),false,failure);
  }
});

test('a timed-out Docker probe cleans up only its own named container',()=>{
  const calls:string[][]=[];
  assert.equal(probeInstalledSandboxImage(id,{execute:(_binary,args)=>{
    calls.push(args);
    return args[0]==='image'?{status:0,stdout:JSON.stringify({Id:id,Os:'linux',Architecture:'amd64'})}:{status:null,error:new Error('synthetic timeout')};
  }}),false);
  const name=calls[1]!.find(arg=>arg.startsWith('--name='))!.slice(7);
  assert.match(name,/^babel-doctor-[a-f0-9-]{36}$/);
  assert.deepEqual(calls[2],['rm','--force',name]);
});
