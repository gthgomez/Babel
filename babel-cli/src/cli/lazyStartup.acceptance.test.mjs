// Importing the interactive shell must not start the task and command graphs.
// This uses a synthetic profile and a network-denying preload in a fresh process.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture} from '../testinfra/synthetic-provider-fixture.mjs';

const repl=new URL('../../dist/interactive/BabelRepl.js',import.meta.url);
const bootstrap=new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href;
const dispatch=new URL('../../dist/cliEntryDispatch.js',import.meta.url).href;
const policy=new URL('../../dist/runners/providerRegistry.js',import.meta.url).href;
const invocation=new URL('../../dist/config/invocationSettings.js',import.meta.url).href;

test('loading the composer defers task, command and session-resume implementations',
  {skip:!existsSync(fileURLToPath(repl)),timeout:120000},()=>{
    const fixture=prepareSyntheticProviderFixture();
    try{
      const probe=`import {registerHooks} from 'node:module';
        const loaded=[],parents=new Map();
        registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,context);if(!parents.has(result.url))parents.set(result.url,context.parentURL);if(['/interactive/commands.js','/interactive/execution/dispatch.js','/interactive/chatSessionResume.js','/agent/chatEngine.js'].some(name=>result.url.endsWith(name)))loaded.push({url:result.url,parent:context.parentURL});return result;}});
        await import(${JSON.stringify(repl.href)});
        for(const item of loaded){item.chain=[];let parent=item.parent;while(parent&&item.chain.length<20){item.chain.push(parent);parent=parents.get(parent);}}
        process.stdout.write(JSON.stringify(loaded));`;
      const result=spawnSync(process.execPath,['--import',bootstrap,'--input-type=module','-e',probe],
        {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:110000});
      assert.equal(result.status,0,`import probe failed; status=${result.status}; signal=${result.signal}`);
      const loaded=JSON.parse(result.stdout);
      for(const name of ['/interactive/commands.js','/interactive/execution/dispatch.js',
        '/interactive/chatSessionResume.js','/agent/chatEngine.js']){
        const occurrence=loaded.find(item=>item.url.endsWith(name));
        assert.equal(occurrence,undefined,`${name} loaded before the composer needed it: ${occurrence?.chain?.join(' <- ')}`);
      }
    }finally{removeSyntheticProviderFixture(fixture.root);}
  });

test('plain interactive launches use the normal product and invocation scopes without loading workflow commands',
  {skip:!existsSync(fileURLToPath(repl)),timeout:120000},()=>{
    const fixture=prepareSyntheticProviderFixture();
    try{
      const stub=`import {isProductProviderPolicyActive} from ${JSON.stringify(policy)};
        import {currentInvocationSettings} from ${JSON.stringify(invocation)};
        export class BabelRepl {}
        export async function startInteractiveSession(state){globalThis.records.push({policy:isProductProviderPolicyActive(),invocation:Boolean(currentInvocationSettings()),envLoaded:process.env.BABEL_ENV_LOADED,state});}`;
      const probe=`import {registerHooks} from 'node:module';
        globalThis.records=[];let loadedWorkflow=false;
        const stub=${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)};
        registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,context);if(result.url.endsWith('/commands/workflowCommands.js'))loadedWorkflow=true;if(result.url.endsWith('/interactive/BabelRepl.js'))return {url:stub,shortCircuit:true};return result;}});
        const {dispatchExecutableCli}=await import(${JSON.stringify(dispatch)});
        for(const args of [[],['interactive'],['app']])await dispatchExecutableCli(['node','babel.js',...args]);
        process.stdout.write(JSON.stringify({records:globalThis.records,loadedWorkflow}));`;
      const result=spawnSync(process.execPath,['--import',bootstrap,'--input-type=module','-e',probe],
        {cwd:fixture.cwd,env:fixture.env,encoding:'utf8',windowsHide:true,timeout:110000});
      assert.equal(result.status,0,`entry probe failed; status=${result.status}; signal=${result.signal}`);
      const outcome=JSON.parse(result.stdout);
      assert.equal(outcome.loadedWorkflow,false,'plain interactive startup loaded workflow registration');
      assert.deepEqual(outcome.records,Array.from({length:3},()=>({policy:true,invocation:true,envLoaded:'true',state:{}})));
    }finally{removeSyntheticProviderFixture(fixture.root);}
  });
