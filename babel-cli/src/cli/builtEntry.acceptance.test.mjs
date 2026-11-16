// Exercises the built command in an isolated profile with all provider networking denied.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs';

const executable=fileURLToPath(new URL('../../bin/babel.js',import.meta.url));
const built=fileURLToPath(new URL('../../dist/cliEntryDispatch.js',import.meta.url));
const fixtureBootstrap=new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href;

test('built CLI retains a configured connection across processes without inference', {skip:!existsSync(built),timeout:300000},()=>{
  const fixture=prepareSyntheticProviderFixture();
  try{
    const offlinePreload=join(fixture.root,'offline-fixture.mjs');
    writeFileSync(offlinePreload,"process.env.BABEL_OFFLINE='1';\n");
    const run=(args,{offline=false}={})=>{
      const result=spawnSync(process.execPath,['--import',fixtureBootstrap,...(offline?['--import',pathToFileURL(offlinePreload).href]:[]),executable,...args],
        {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:process.platform==='linux'?90000:45000});
      const output=(result.stdout??'')+(result.stderr??'');
      assert.equal(result.status,0,`command failed: ${args.join(' ')}; status=${result.status}; signal=${result.signal}; network blocked=${output.includes('SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED')}`);
      assert.doesNotMatch(output,/synthetic-router-credential|synthetic-deepseek-credential/);
      assert.doesNotMatch(output,/SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED/);
      return output;
    };
    run(['provider','connect','openrouter','--model','vendor/fixture']);
    run(['provider','use','openrouter','--save','user']);
    const status=JSON.parse(run(['provider','status','--json']));
    assert.equal(status.connection,'openrouter');
    assert.equal(status.model,'vendor/fixture');
    assert.equal(status.state,'configured_unverified');
    const offline=JSON.parse(run(['provider','status','--json'],{offline:true}));
    assert.equal(offline.state,'action_required');assert.equal(offline.reason,'offline');
  }finally{removeSyntheticProviderFixture(fixture.root);}
});
