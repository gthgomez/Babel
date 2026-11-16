// An installed candidate is supplied explicitly; all provider networking is denied.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs';

const installed=process.env.BABEL_TEST_INSTALLED_CLI;
const bootstrap=new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href;
test('clean npm install starts, retains a selected account, and rejects offline dispatch',
  {skip:!installed||!existsSync(installed),timeout:300000},async()=>{
    const entry=resolve(installed),packageRoot=dirname(dirname(entry));
    const fixture=prepareSyntheticProviderFixture();
    try{
      const run=(args,{offline=false}={})=>{
        const preload=join(fixture.root,'offline-preload.mjs');
        if(offline)writeFileSync(preload,"process.env.BABEL_OFFLINE='1';\n");
        const child=spawnSync(process.execPath,['--import',bootstrap,...(offline?['--import',pathToFileURL(preload).href]:[]),entry,...args],
          {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
        const output=(child.stdout??'')+(child.stderr??'');
        assert.equal(child.status,0,`Installed command failed: ${args.join(' ')}; status=${child.status}; network blocked=${output.includes('SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED')}`);
        assert.doesNotMatch(output,/synthetic-router-credential|synthetic-deepseek-credential|SYNTHETIC_PROVIDER_NETWORK_DISPATCH_BLOCKED/);
        return child.stdout;
      };
      run(['provider','connect','openrouter','--model','vendor/fixture']);
      run(['provider','use','openrouter','--save','user']);
      const status=JSON.parse(run(['provider','status','--json']));
      assert.equal(status.connection,'openrouter');assert.equal(status.model,'vendor/fixture');assert.equal(status.state,'configured_unverified');
      const offline=JSON.parse(run(['provider','status','--json'],{offline:true}));
      assert.equal(offline.state,'action_required');assert.equal(offline.reason,'offline');
      assert.ok(JSON.parse(run(['model','list','--json'])).manualEntry);
      assert.ok(existsSync(join(packageRoot,'dist','config','sharedCredential.windows.ps1')));
      assert.ok(existsSync(join(packageRoot,'dist','config','sharedCredential.worker.js')));
      assert.ok(existsSync(join(packageRoot,'resources','prompt_catalog.yaml')));
      assert.equal(typeof createRequire(join(packageRoot,'package.json'))('@napi-rs/keyring').Entry,'function');
      const worker=spawnSync(process.execPath,[join(packageRoot,'dist','config','sharedCredential.worker.js')],{
        input:JSON.stringify({operation:'selftest',id:'11111111-1111-4111-8111-111111111111'}),encoding:'utf8',env:fixture.env,windowsHide:true,timeout:10000});
      assert.equal(worker.status,0);assert.deepEqual(JSON.parse(worker.stdout),{ok:true,result:true});
      if(process.platform==='win32'){
        const {createWindowsHelperRunner}=await import(pathToFileURL(join(packageRoot,'dist','config','sharedCredentialStore.js')).href);
        const helper=createWindowsHelperRunner({systemRoot:fixture.env.SystemRoot,helper:join(packageRoot,'dist','config','sharedCredential.windows.ps1'),temp:join(fixture.root,'tmp'),tmp:join(fixture.root,'tmp')});
        const response=helper(JSON.stringify({operation:'selftest',id:'11111111-1111-4111-8111-111111111111'}));
        assert.equal(response.status,0);assert.deepEqual(JSON.parse(response.stdout),{ok:true,result:true});
      }
      const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));
      for(const name of ['babel','babel-agent','babel-harness'])assert.equal(manifest.bin[name],'bin/babel.js');
    }finally{removeSyntheticProviderFixture(fixture.root);}
  });

test('installed plain interactive entry keeps its provider policy and invocation scope',
  {skip:!installed||!existsSync(installed),timeout:300000},()=>{
    const entry=resolve(installed),packageRoot=dirname(dirname(entry)),fixture=prepareSyntheticProviderFixture();
    try{
      const hook=join(fixture.root,'interactive-probe.mjs');
      const policy=pathToFileURL(join(packageRoot,'dist','runners','providerRegistry.js')).href;
      const invocation=pathToFileURL(join(packageRoot,'dist','config','invocationSettings.js')).href;
      const stub=`import {isProductProviderPolicyActive} from ${JSON.stringify(policy)};import {currentInvocationSettings} from ${JSON.stringify(invocation)};
        export class BabelRepl {};
        export async function startInteractiveSession(){process.stdout.write(JSON.stringify({policy:isProductProviderPolicyActive(),invocation:Boolean(currentInvocationSettings()),envLoaded:process.env.BABEL_ENV_LOADED,loadedWorkflow:globalThis.loadedWorkflow}));}`;
      writeFileSync(hook,`import {registerHooks} from 'node:module';globalThis.loadedWorkflow=false;const stub=${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)};
        registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,context);if(result.url.endsWith('/commands/workflowCommands.js'))globalThis.loadedWorkflow=true;if(result.url.endsWith('/interactive/BabelRepl.js'))return {url:stub,shortCircuit:true};return result;}});`);
      for(const args of [[],['interactive'],['app']]){
        const child=spawnSync(process.execPath,['--import',bootstrap,'--import',pathToFileURL(hook).href,entry,...args],
          {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:60000});
        assert.equal(child.status,0,`Installed interactive entry failed; status=${child.status}; signal=${child.signal}`);
        assert.deepEqual(JSON.parse(child.stdout),{policy:true,invocation:true,envLoaded:'true',loadedWorkflow:false});
      }
    }finally{removeSyntheticProviderFixture(fixture.root);}
  });

test('installed Windows command shims start with a synthetic offline profile',
  {skip:process.platform!=='win32'||!installed||!existsSync(installed),timeout:300000},()=>{
    const packageRoot=dirname(dirname(resolve(installed))),fixture=prepareSyntheticProviderFixture();
    try{
      // Explicit socket deny guard; no provider credentials from the host enter this process.
      const guard=join(fixture.root,'deny-network.cjs');
      writeFileSync(guard,`const http=require('node:http'),https=require('node:https'),net=require('node:net'),tls=require('node:tls');const deny=()=>{throw Error('TEST_NETWORK_BLOCKED')};globalThis.fetch=async()=>deny();http.request=http.get=https.request=https.get=net.connect=net.createConnection=net.Socket.prototype.connect=tls.connect=deny;require('node:module').syncBuiltinESMExports();`);
      const env={...fixture.env,BABEL_OFFLINE:'1',NODE_OPTIONS:`--require="${guard.replaceAll('\\','/')}"`};
      for(const name of ['babel','babel-agent','babel-harness']){
        const shim=join(dirname(packageRoot),'.bin',`${name}.cmd`);
        assert.ok(existsSync(shim));assert.doesNotMatch(shim,/["&|^%!\r\n]/);
        const child=spawnSync(fixture.env.ComSpec,['/d','/s','/c',`""${shim}" provider status --json"`],
          {cwd:fixture.cwd,env,encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:60000});
        const diagnostic=(child.stdout??'')+(child.stderr??'');
        const hints=['TEST_NETWORK_BLOCKED','Cannot find module','NODE_OPTIONS','not recognized','cannot find the path','unexpected'].filter(text=>diagnostic.toLowerCase().includes(text.toLowerCase()));
        assert.equal(child.status,0,`${name} shim failed; signal=${child.signal}; matched diagnostics=${hints.join(',')||'none'}`);
        assert.equal(JSON.parse(child.stdout).state,'setup_required');
        assert.doesNotMatch(diagnostic,/TEST_NETWORK_BLOCKED|synthetic-router-credential/);
      }
    }finally{removeSyntheticProviderFixture(fixture.root);}
  });
