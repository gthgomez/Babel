import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture,summarizeSyntheticProviderOutput} from '../../testinfra/synthetic-provider-fixture.mjs';

function runPlanScenario(task: string, cancel: boolean | 'provider' = false, previousPlanId?: string, savingUnavailable = false) {
  const fixture=prepareSyntheticProviderFixture();
  try{
    writeFileSync(join(fixture.cwd,'calc.js'),'export const value=1;\n');
    writeFileSync(join(fixture.root,'state','preferences.json'),JSON.stringify({schemaVersion:1,connections:{},defaults:{plans:{autoApply:true},budgetUsd:'unlimited'}}));
    if (savingUnavailable) symlinkSync(join(fixture.root,'tmp'), join(fixture.root,'state','plans'), 'dir');
    const driver=join(fixture.root,'interactive-plan.mjs');
    writeFileSync(driver,`
      process.env.BABEL_LITE_OFFLINE='${cancel === 'provider' ? '0' : '1'}';
      process.env.BABEL_OFFLINE='${cancel === 'provider' ? '0' : '1'}';
      process.env.BABEL_PIPELINE_V9_OFFLINE='${cancel === 'provider' ? '0' : '1'}';
      process.env.BABEL_DAEMON_ENABLED='false';
      const {PassThrough}=await import('node:stream');
      const {createInterface}=await import('node:readline');
      const {readFileSync,readdirSync}=await import('node:fs');
      const {basename,join}=await import('node:path');
      const {executePlanTask}=await import(${JSON.stringify(new URL('./plan.ts',import.meta.url).href)});
      const {loadSavedPlan}=await import(${JSON.stringify(new URL('../../services/savedPlan.ts',import.meta.url).href)});
      const {handleCancelTurn}=await import(${JSON.stringify(new URL('../commands/review.ts',import.meta.url).href)});
      const input=new PassThrough();
      const rl=createInterface({input,terminal:false});
      let staleChatCancellations=0;
      const ctx={state:{router:'v9',operatorMode:'default',model:'glm-5.3-flash',...(${JSON.stringify(previousPlanId ?? null)}?{savedPlanId:${JSON.stringify(previousPlanId ?? null)}}:{})},rl,isRunning:false,lastRunDir:null,
        chatEngine:{abortTurn(){staleChatCancellations++;}},
        appendTurn(){},saveSessionState(){},settleShellTurn(status){this.settlement=status;}};
      let providerRequests=0,providerAborted=false,liveModelsCorrect=true,liveScopeCorrect=true;
      if(${cancel === 'provider'})globalThis.fetch=async(url,init)=>{
        if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')throw Error('Unexpected synthetic route');
        const body=JSON.parse(init.body);
        providerRequests++;
        liveModelsCorrect &&= body.model==='z-ai/glm-5.3-flash';
        liveScopeCorrect &&= process.env.BABEL_ALLOWED_ROOTS===process.cwd();
        if(body.messages.some(message=>message.content.includes('# Babel Lite Plan'))){
          return await new Promise((resolve,reject)=>{
            init.signal.addEventListener('abort',()=>{
              providerAborted=true;reject(new DOMException('Cancelled synthetic request','AbortError'));
            },{once:true});
            queueMicrotask(()=>handleCancelTurn(ctx));
          });
        }
        return new Response(JSON.stringify({model:body.model,
          choices:[{message:{content:JSON.stringify({actions:[{type:'finish',summary:'Read-only discovery complete.',verification:[]}]})}}],
          usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15,cost:0}}));
      };
      const task=${JSON.stringify(task)};
      const pending=executePlanTask(ctx,task,task,{targetRoot:process.cwd(),workspaceRoot:null});
      if(${cancel === true})handleCancelTurn(ctx);
      await pending;
      const saved=ctx.state.savedPlanId?loadSavedPlan(ctx.state.savedPlanId):null;
      console.log('PLAN_RESULT '+JSON.stringify({status:ctx.lastAssistantStatus??null,settlement:ctx.settlement,
        saved:!!saved,ready:saved?.state==='ready',project:saved?.projectRoot===process.cwd(),
        body:!!saved?.body.trim(),fullBody:!!saved?.body.includes(readFileSync(join(ctx.lastRunDir,'plan.md'),'utf8').trim()),
        unchanged:readFileSync('calc.js','utf8')==='export const value=1;\\n',
        staleChatCancellations,cancelHookCleared:ctx.cancelActiveRun===undefined,
        targetUnchanged:readdirSync(process.cwd()).sort().join('|')==='.git|calc.js',
        sourceBound:!!saved && saved.sourceRunId===basename(ctx.lastRunDir),
        ...(${cancel === 'provider'}?{providerRequests,providerAborted,liveModelsCorrect,liveScopeCorrect}:{})}));
      rl.close();input.destroy();
    `);
    const child=spawnSync(process.execPath,[
      '--experimental-wasm-modules','--import',new URL('../../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',import.meta.resolve('tsx'),driver,
    ],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(child.error===undefined,true);
    assert.equal(child.status,0,summarizeSyntheticProviderOutput(child.stdout+child.stderr,child.status));
    assert.doesNotMatch(child.stdout,/Automatic application: enabled/);
    if (previousPlanId) assert.ok(child.stdout.includes(`Previous saved Plan ID: ${previousPlanId}.`));
    const line=child.stdout.split(/\r?\n/).find(value=>value.startsWith('PLAN_RESULT '));
    assert.ok(line,'the real interactive handler settles and emits its scalar result');
    const result=JSON.parse(line.slice('PLAN_RESULT '.length));
    if (result.status === 'PLAN_READY') {
      assert.match(child.stdout,/Plan application is temporarily unavailable/i);
      assert.doesNotMatch(child.stdout,/Apply with \/apply/i);
    }
    assert.equal(readFileSync(join(fixture.cwd,'calc.js'),'utf8'),'export const value=1;\n');
    return result;
  }finally{removeSyntheticProviderFixture(fixture.root);}
}

test('interactive Plan saves the complete canonical read-only plan for named files without applying it',()=>{
  assert.deepEqual(runPlanScenario('Plan-only: inspect calc.js and propose a regression test. Do not modify any files.'),{
    status:'PLAN_READY',settlement:'complete',saved:true,ready:true,project:true,body:true,fullBody:true,unchanged:true,
    staleChatCancellations:0,cancelHookCleared:true,targetUnchanged:true,sourceBound:true,
  });
});

test('an explicit no-modification instruction overrides the auto-apply preference',()=>{
  assert.equal(runPlanScenario('Inspect calc.js and propose a regression test. Do not modify any files.').ready,true);
});

test('cancelling interactive Plan aborts the active plan without saving or cancelling an old chat engine',()=>{
  assert.deepEqual(runPlanScenario('Plan-only: inspect calc.js and propose a regression test.',true),{
    status:'CANCELLED',settlement:'cancelled',saved:false,ready:false,project:false,body:false,fullBody:false,unchanged:true,
    staleChatCancellations:0,cancelHookCleared:true,targetUnchanged:true,sourceBound:false,
  });
});

test('Plan forwards the exact model and target scope, and aborts an in-flight synthesis request',()=>{
  assert.deepEqual(runPlanScenario('Plan-only: inspect calc.js and propose a regression test.','provider'),{
    status:'CANCELLED',settlement:'cancelled',saved:false,ready:false,project:false,body:false,fullBody:false,unchanged:true,
    staleChatCancellations:0,cancelHookCleared:true,targetUnchanged:true,sourceBound:false,
    providerRequests:2,providerAborted:true,liveModelsCorrect:true,liveScopeCorrect:true,
  });
});

test('manual saved-plan application cancels its own request and settles without aborting a stale chat engine',()=>{
  const fixture=prepareSyntheticProviderFixture();
  try{
    writeFileSync(join(fixture.cwd,'calc.js'),'export const value=1;\n');
    writeFileSync(join(fixture.root,'state','preferences.json'),JSON.stringify({schemaVersion:1,connections:{},defaults:{budgetUsd:'unlimited'}}));
    const driver=join(fixture.root,'interactive-apply.mjs');
    writeFileSync(driver,`
      process.env.BABEL_LIVE='true';process.env.BABEL_DRY_RUN='false';
      process.env.BABEL_PIPELINE_V9_OFFLINE='0';process.env.BABEL_DAEMON_ENABLED='false';
      process.env.BABEL_DESKTOP_PROVIDER='openrouter';process.env.BABEL_DESKTOP_MODEL_ROUTE='glm-5.3-flash';
      const {PassThrough}=await import('node:stream');
      const {createInterface}=await import('node:readline');
      const {readFileSync,writeFileSync,mkdirSync}=await import('node:fs');
      const {join}=await import('node:path');
      const {handleCommand}=await import(${JSON.stringify(new URL('../commands.ts',import.meta.url).href)});
      const {handleCancelTurn}=await import(${JSON.stringify(new URL('../commands/review.ts',import.meta.url).href)});
      const {savePlan,loadSavedPlan}=await import(${JSON.stringify(new URL('../../services/savedPlan.ts',import.meta.url).href)});
      const input=new PassThrough();const rl=createInterface({input,terminal:false});
      let staleChatCancellations=0,providerRequests=0,providerAborted=false;
      const ctx={state:{router:'v9',operatorMode:'default',mode:'plan',model:'glm-5.3-flash'},rl,isRunning:false,
        logBuffer:[],appendTurn(){},saveSessionState(){},
        resolveCurrentTarget(){return {targetRoot:process.cwd(),workspaceRoot:null};},
        chatEngine:{abortTurn(){staleChatCancellations++;}},
        settleShellTurn(status){this.settlement=status;}};
      globalThis.fetch=async(url,init)=>{
        if(String(url)!=='https://openrouter.ai/api/v1/chat/completions')throw Error('Unexpected synthetic route');
        if(JSON.parse(init.body).model!=='z-ai/glm-5.3-flash')throw Error('Unexpected synthetic model');
        providerRequests++;
        handleCancelTurn(ctx);
        providerAborted=init.signal?.aborted===true;
        throw providerAborted?init.signal.reason:Error('Application request did not receive cancellation');
      };
      const sourceRunId='20260610T180000Z-plan-abcdef01';
      const source=join(process.cwd(),'runs','babel-lite',sourceRunId);
      mkdirSync(source,{recursive:true});
      writeFileSync(join(source,'model_plan.json'),JSON.stringify({summary:'Refactor calc.js.',likely_files:['calc.js']}));
      writeFileSync(join(source,'contract.json'),JSON.stringify({schema_version:1,mode:'babel-lite-plan',likely_files:['calc.js'],required_reads:[]}));
      writeFileSync(join(source,'plan.md'),'Keep the exported value while improving its implementation.');
      const saved=savePlan({projectRoot:process.cwd(),task:'Refactor calc.js.',body:'Keep the exported value while improving its implementation.',sourceRunId});
      let stopped=false;
      try{await handleCommand(ctx,'/apply '+saved.id);}catch{stopped=true;}
      writeFileSync(${JSON.stringify(join(fixture.root,'apply-result.json'))},JSON.stringify({stopped,status:ctx.state.lastRunUserStatus,
        assistantStatus:ctx.lastAssistantStatus,settlement:ctx.settlement,
        savedState:loadSavedPlan(saved.id).state,providerRequests,providerAborted,staleChatCancellations,
        cancelHookCleared:ctx.cancelActiveRun===undefined,running:ctx.isRunning,
        unchanged:readFileSync('calc.js','utf8')==='export const value=1;\\n'}));
      rl.close();input.destroy();
    `);
    const child=spawnSync(process.execPath,[
      '--experimental-wasm-modules','--import',new URL('../../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',import.meta.resolve('tsx'),driver,
    ],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(child.error===undefined,true);
    assert.equal(child.status,0,summarizeSyntheticProviderOutput(child.stdout+child.stderr,child.status));
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.root,'apply-result.json'),'utf8')),{
      stopped:true,status:'cancelled',assistantStatus:'CANCELLED',settlement:'cancelled',savedState:'unknown',
      providerRequests:1,providerAborted:true,staleChatCancellations:0,cancelHookCleared:true,running:false,unchanged:true,
    });
  }finally{removeSyntheticProviderFixture(fixture.root);}
});

test('interactive Apply retains a sensitive Plan body without provider dispatch',()=>{
  const fixture=prepareSyntheticProviderFixture();
  try {
    writeFileSync(join(fixture.root,'state','preferences.json'),JSON.stringify({schemaVersion:1,connections:{},defaults:{budgetUsd:'unlimited'}}));
    const driver=join(fixture.root,'interactive-private-apply.mjs');
    writeFileSync(driver,`
      const {mkdirSync,writeFileSync}=await import('node:fs'); const {join}=await import('node:path');
      const {handleCommand}=await import(${JSON.stringify(new URL('../commands.ts',import.meta.url).href)});
      const {savePlan,loadSavedPlan}=await import(${JSON.stringify(new URL('../../services/savedPlan.ts',import.meta.url).href)});
      const sourceRunId='20260610T180000Z-plan-abcdef01', source=join(process.cwd(),'runs','babel-lite',sourceRunId);
      mkdirSync(source,{recursive:true}); writeFileSync(join(source,'model_plan.json'),JSON.stringify({summary:'Safe fixture'}));
      writeFileSync(join(source,'contract.json'),JSON.stringify({schema_version:1,mode:'babel-lite-plan',likely_files:[],required_reads:[]}));
      const body='OPENAI_API_KEY=SYNTHETIC_INTERACTIVE_PLAN_SECRET'; writeFileSync(join(source,'plan.md'),body);
      const saved=savePlan({projectRoot:process.cwd(),task:'Implement fixture',body,sourceRunId}); let calls=0;
      globalThis.fetch=async()=>{calls++;throw Error('unexpected synthetic dispatch')};
      const ctx={isRunning:false,state:{operatorMode:'default'},resolveCurrentTarget(){return {targetRoot:process.cwd(),workspaceRoot:null}}};
      let rejected=false;try{await handleCommand(ctx,'/apply '+saved.id)}catch(error){rejected=/credential-shaped/i.test(String(error))}
      const retained=loadSavedPlan(saved.id);writeFileSync(${JSON.stringify(join(fixture.root,'private-result.json'))},JSON.stringify({rejected,calls,retained:retained.body===body,state:retained.state}));
    `);
    const child=spawnSync(process.execPath,['--experimental-wasm-modules','--import',new URL('../../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,'--import',import.meta.resolve('tsx'),driver],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(child.error,undefined); assert.equal(child.status,0,summarizeSyntheticProviderOutput(child.stdout+child.stderr,child.status));
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.root,'private-result.json'),'utf8')),{rejected:true,calls:0,retained:true,state:'ready'});
    assert.equal((child.stdout+child.stderr).includes('SYNTHETIC_INTERACTIVE_PLAN_SECRET'),false);
  } finally {removeSyntheticProviderFixture(fixture.root)}
});

test('interactive Apply admits a valid Plan through the scoped boundary without out-of-scope mutation',()=>{
  const fixture=prepareSyntheticProviderFixture();
  try {
    writeFileSync(join(fixture.cwd,'calc.js'),'original fixture\n');
    const driver=join(fixture.root,'interactive-contained-apply.mjs');
    writeFileSync(driver,`
      const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');const {join}=await import('node:path');
      const {PassThrough}=await import('node:stream');const {createInterface}=await import('node:readline');
      const {handleCommand}=await import(${JSON.stringify(new URL('../commands.ts',import.meta.url).href)});
      const {savePlan,loadSavedPlan}=await import(${JSON.stringify(new URL('../../services/savedPlan.ts',import.meta.url).href)});
      const input=new PassThrough(),rl=createInterface({input,terminal:false});
      const id='20260610T180000Z-plan-abcdef01',source=join(process.cwd(),'runs','babel-lite',id);mkdirSync(source,{recursive:true});
      writeFileSync(join(source,'model_plan.json'),JSON.stringify({summary:'Plan'}));writeFileSync(join(source,'contract.json'),JSON.stringify({schema_version:1,mode:'babel-lite-plan',likely_files:['calc.js'],required_reads:[]}));writeFileSync(join(source,'plan.md'),'Update calc.js.');
      const saved=savePlan({projectRoot:process.cwd(),task:'Update calc.js',body:'Update calc.js.',sourceRunId:id});let calls=0,reason='';
      globalThis.fetch=async()=>{calls++;throw Error('unexpected synthetic dispatch')};
      const ctx={isRunning:false,rl,state:{operatorMode:'default'},resolveCurrentTarget(){return {targetRoot:process.cwd(),workspaceRoot:null}}};
      try{await handleCommand(ctx,'/apply '+saved.id)}catch(error){reason=String(error)}
      writeFileSync(${JSON.stringify(join(fixture.root,'contained-result.json'))},JSON.stringify({reason,calls,state:loadSavedPlan(saved.id).state,unchanged:readFileSync('calc.js','utf8')==='original fixture\\n'}));rl.close();input.destroy();
    `);
    const child=spawnSync(process.execPath,['--experimental-wasm-modules','--import',new URL('../../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,'--import',import.meta.resolve('tsx'),driver],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(child.error,undefined);assert.equal(child.status,0,summarizeSyntheticProviderOutput(child.stdout+child.stderr,child.status));
    const result=JSON.parse(readFileSync(join(fixture.root,'contained-result.json'),'utf8'));
    assert.doesNotMatch(result.reason,/Plan application is temporarily unavailable/i);assert.ok(result.calls>=1,`apply must reach provider admission: ${result.reason}`);assert.equal(result.unchanged,true);assert.equal(result.state,'unknown');
  } finally {removeSyntheticProviderFixture(fixture.root);}
});

test('interactive Apply sends selected Plan A after newer Plan B exists',()=>{
  const fixture=prepareSyntheticProviderFixture();
  try {
    writeFileSync(join(fixture.cwd,'calc.js'),'export const value=1;\n');
    writeFileSync(join(fixture.root,'state','preferences.json'),JSON.stringify({schemaVersion:1,connections:{},defaults:{budgetUsd:'unlimited'}}));
    const driver=join(fixture.root,'interactive-exact-apply.mjs');
    writeFileSync(driver,`
      process.env.BABEL_LIVE='true';process.env.BABEL_DRY_RUN='false';process.env.BABEL_PIPELINE_V9_OFFLINE='0';process.env.BABEL_DAEMON_ENABLED='false';
      process.env.BABEL_DESKTOP_PROVIDER='openrouter';process.env.BABEL_DESKTOP_MODEL_ROUTE='glm-5.3-flash';
      const {PassThrough}=await import('node:stream');const {createInterface}=await import('node:readline');
      const {mkdirSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
      const {handleCommand}=await import(${JSON.stringify(new URL('../commands.ts',import.meta.url).href)});
      const {handleCancelTurn}=await import(${JSON.stringify(new URL('../commands/review.ts',import.meta.url).href)});
      const {savePlan,loadSavedPlan}=await import(${JSON.stringify(new URL('../../services/savedPlan.ts',import.meta.url).href)});
      const input=new PassThrough(),rl=createInterface({input,terminal:false});let calls=0,seenA=false,seenB=false;
      const ctx={state:{router:'v9',operatorMode:'default',mode:'plan',model:'glm-5.3-flash'},rl,isRunning:false,logBuffer:[],appendTurn(){},saveSessionState(){},
        resolveCurrentTarget(){return {targetRoot:process.cwd(),workspaceRoot:null}},chatEngine:{abortTurn(){throw Error('wrong engine')}}};
      globalThis.fetch=async(_url,init)=>{calls++;const wire=String(init.body);seenA||=wire.includes('SYNTHETIC_PLAN_A');seenB||=wire.includes('SYNTHETIC_PLAN_B');handleCancelTurn(ctx);throw init.signal?.reason??Error('synthetic cancellation')};
      const ids=['20260610T180000Z-plan-abcdef01','20260610T180001Z-plan-abcdef02'];const plans=[];
      for(let i=0;i<ids.length;i++){const path=join(process.cwd(),'runs','babel-lite',ids[i]);mkdirSync(path,{recursive:true});
        const body='SYNTHETIC_PLAN_'+(i===0?'A':'B');writeFileSync(join(path,'contract.json'),JSON.stringify({schema_version:1,mode:'babel-lite-plan',likely_files:['calc.js'],required_reads:[]}));writeFileSync(join(path,'model_plan.json'),JSON.stringify({summary:body,likely_files:['calc.js']}));writeFileSync(join(path,'plan.md'),body);
        plans.push(savePlan({projectRoot:process.cwd(),task:'Refactor calc.js',body,sourceRunId:ids[i]}));}
      let stopped=false,reason='';try{await handleCommand(ctx,'/apply '+plans[0].id)}catch(error){stopped=true;reason=String(error)}
      writeFileSync(${JSON.stringify(join(fixture.root,'exact-result.json'))},JSON.stringify({stopped,calls,seenA,seenB,a:loadSavedPlan(plans[0].id).state,b:loadSavedPlan(plans[1].id).state,reason}));rl.close();input.destroy();
    `);
    const child=spawnSync(process.execPath,['--experimental-wasm-modules','--import',new URL('../../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,'--import',import.meta.resolve('tsx'),driver],{cwd:fixture.cwd,env:fixture.env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(child.error,undefined);assert.equal(child.status,0,summarizeSyntheticProviderOutput(child.stdout+child.stderr,child.status));
    const result=JSON.parse(readFileSync(join(fixture.root,'exact-result.json'),'utf8'));assert.equal(result.calls,1,`pre-dispatch failure: ${result.reason}`);
    assert.deepEqual({stopped:result.stopped,calls:result.calls,seenA:result.seenA,seenB:result.seenB,a:result.a,b:result.b},{stopped:true,calls:1,seenA:true,seenB:false,a:'unknown',b:'ready'});
  } finally {removeSyntheticProviderFixture(fixture.root)}
});

test('interactive Plan preserves useful output when canonical saving is unavailable', () => {
  const result = runPlanScenario('Plan-only: inspect calc.js and propose a regression test. Do not modify any files.', false, 'plan_11111111-1111-1111-1111-111111111111', true);
  assert.equal(result.status, 'PLAN_READY'); assert.equal(result.settlement, 'blocked');
  assert.equal(result.saved, false); assert.equal(result.unchanged, true); assert.equal(result.sourceBound, false);
});
