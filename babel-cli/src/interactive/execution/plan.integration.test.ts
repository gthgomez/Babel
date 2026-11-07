import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {prepareSyntheticProviderFixture,removeSyntheticProviderFixture,summarizeSyntheticProviderOutput} from '../../testinfra/synthetic-provider-fixture.mjs';

function runPlanScenario(task: string, cancel: boolean | 'provider' = false) {
  const fixture=prepareSyntheticProviderFixture();
  try{
    writeFileSync(join(fixture.cwd,'calc.js'),'export const value=1;\n');
    writeFileSync(join(fixture.root,'state','preferences.json'),JSON.stringify({schemaVersion:1,connections:{},defaults:{plans:{autoApply:true},budgetUsd:'unlimited'}}));
    const driver=join(fixture.root,'interactive-plan.mjs');
    writeFileSync(driver,`
      process.env.BABEL_LITE_OFFLINE='${cancel === 'provider' ? '0' : '1'}';
      process.env.BABEL_OFFLINE='${cancel === 'provider' ? '0' : '1'}';
      process.env.BABEL_PIPELINE_V9_OFFLINE='${cancel === 'provider' ? '0' : '1'}';
      process.env.BABEL_DAEMON_ENABLED='false';
      const {PassThrough}=await import('node:stream');
      const {createInterface}=await import('node:readline');
      const {readFileSync,readdirSync}=await import('node:fs');
      const {join}=await import('node:path');
      const {executePlanTask}=await import(${JSON.stringify(new URL('./plan.ts',import.meta.url).href)});
      const {loadSavedPlan}=await import(${JSON.stringify(new URL('../../services/savedPlan.ts',import.meta.url).href)});
      const {handleCancelTurn}=await import(${JSON.stringify(new URL('../commands/review.ts',import.meta.url).href)});
      const input=new PassThrough();
      const rl=createInterface({input,terminal:false});
      let staleChatCancellations=0;
      const ctx={state:{router:'v9',operatorMode:'default',model:'glm-5.3-flash'},rl,isRunning:false,lastRunDir:null,
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
    const line=child.stdout.split(/\r?\n/).find(value=>value.startsWith('PLAN_RESULT '));
    assert.ok(line,'the real interactive handler settles and emits its scalar result');
    const result=JSON.parse(line.slice('PLAN_RESULT '.length));
    assert.equal(readFileSync(join(fixture.cwd,'calc.js'),'utf8'),'export const value=1;\n');
    return result;
  }finally{removeSyntheticProviderFixture(fixture.root);}
}

test('interactive Plan saves the complete canonical read-only plan for named files without applying it',()=>{
  assert.deepEqual(runPlanScenario('Plan-only: inspect calc.js and propose a regression test. Do not modify any files.'),{
    status:'PLAN_READY',settlement:'complete',saved:true,ready:true,project:true,body:true,fullBody:true,unchanged:true,
    staleChatCancellations:0,cancelHookCleared:true,targetUnchanged:true,
  });
});

test('an explicit no-modification instruction overrides the auto-apply preference',()=>{
  assert.equal(runPlanScenario('Inspect calc.js and propose a regression test. Do not modify any files.').ready,true);
});

test('cancelling interactive Plan aborts the active plan without saving or cancelling an old chat engine',()=>{
  assert.deepEqual(runPlanScenario('Plan-only: inspect calc.js and propose a regression test.',true),{
    status:'CANCELLED',settlement:'cancelled',saved:false,ready:false,project:false,body:false,fullBody:false,unchanged:true,
    staleChatCancellations:0,cancelHookCleared:true,targetUnchanged:true,
  });
});

test('Plan forwards the exact model and target scope, and aborts an in-flight synthesis request',()=>{
  assert.deepEqual(runPlanScenario('Plan-only: inspect calc.js and propose a regression test.','provider'),{
    status:'CANCELLED',settlement:'cancelled',saved:false,ready:false,project:false,body:false,fullBody:false,unchanged:true,
    staleChatCancellations:0,cancelHookCleared:true,targetUnchanged:true,
    providerRequests:2,providerAborted:true,liveModelsCorrect:true,liveScopeCorrect:true,
  });
});
