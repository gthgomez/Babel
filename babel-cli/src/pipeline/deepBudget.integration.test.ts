import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isSyntheticProviderFixtureReady,prepareSyntheticProviderFixture,removeSyntheticProviderFixture,summarizeSyntheticProviderOutput} from '../testinfra/synthetic-provider-fixture.mjs';

if (!isSyntheticProviderFixtureReady()) {
  test('Deep consumption regression runs without ambient credentials or external inference', async t => {
    const fixture=prepareSyntheticProviderFixture();
    t.after(()=>removeSyntheticProviderFixture(fixture.root));
    const child=spawn(process.execPath,[
      '--import',new URL('../testinfra/synthetic-provider-fixture.mjs',import.meta.url).href,
      '--import',import.meta.resolve('tsx'),'--test','--test-reporter=tap',fileURLToPath(import.meta.url),
    ],{cwd:fixture.cwd,env:fixture.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});
    const code=await new Promise<number>(resolve=>{child.once('error',()=>resolve(1));child.once('close',value=>resolve(value??1));});
    t.diagnostic(summarizeSyntheticProviderOutput(output,code));
    for(const line of output.split('\n').filter(line=>/^not ok \d+ - /.test(line)))t.diagnostic(line);
    for(const line of output.split('\n').filter(line=>line.startsWith('# DEEP_BUDGET_FIXTURE ')))t.diagnostic(line);
    assert.equal(code,0,'prior model consumption must not become instruction-stack capacity');
  });
} else {
  process.env['BABEL_LIVE']='true';process.env['BABEL_DRY_RUN']='false';
  process.env['BABEL_EXECUTION_PROFILE']='safe_repo';
  process.env['BABEL_DESKTOP_PROVIDER']='openrouter';process.env['BABEL_DESKTOP_MODEL_ROUTE']='glm-5.3-flash';
  const {EvidenceBundle}=await import('../evidence.js');
  const {SwePlanSchema}=await import('../schemas/agentContracts.js');
  const {globalCostTracker}=await import('../services/costTracker.js');
  const {runExecutorLoop}=await import('./executorLoop.js');
  const {withPipelineModelRoute}=await import('../execute.js');
  const {getEffectiveBudgetLimit}=await import('../budgetPolicy.js');
  const task='Read existing.txt and explain its contents. Do not modify any files.';
  const plan=SwePlanSchema.parse({plan_version:'1.0',plan_type:'IMPLEMENTATION_PLAN',task_summary:task,
    assumptions:[],risks:[],out_of_scope:[],root_cause:'Controlled read-only task',
    minimal_action_set:[{step:1,tool:'file_read',target:'existing.txt',description:'Inspect the requested file',rationale:'Owner request',reversible:true,verification:'Read the original bytes'}]});

  test('approved Deep executor reads and completes after cumulative consumption exceeds the stack limit',async t=>{
    writeFileSync('existing.txt','preserved fixture bytes');
    globalCostTracker.resetSession();
    globalCostTracker.trackUsage('glm-5.3-flash',75119,49700,null,null,undefined,true,'openrouter',0);
    assert.equal(getEffectiveBudgetLimit({}),3600);
    assert.ok(globalCostTracker.getSessionSummary().totalTokens>3600);
    const evidence=new EvidenceBundle(task,process.env['BABEL_RUNS_DIR']!);
    evidence.writeQaVerdict({verdict:'PASS',overall_confidence:5},1);
    let calls=0;
    t.mock.method(globalThis,'fetch',async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
      const body=JSON.parse(String(init?.body));assert.equal(body.model,'z-ai/glm-5.3-flash');
      const turn=++calls===1?{type:'tool_call',thinking:'Inspect the authorized file',tool:'file_read',path:'existing.txt'}:{type:'completion',status:'EXECUTION_COMPLETE'};
      return new Response('data: '+JSON.stringify({model:body.model,choices:[{index:0,delta:{content:JSON.stringify(turn)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    });
    // The legacy executor target is a schema family; the pinned route above and
    // request assertion are authoritative for the effective provider/model.
    const result=await withPipelineModelRoute('glm-5.3-flash',()=>runExecutorLoop(plan,evidence,'deepseek',[],[],task));
    t.diagnostic('DEEP_BUDGET_FIXTURE '+JSON.stringify({status:result.terminalStatus,haltTag:result.haltTag??null,modelCalls:calls}));
    assert.equal(result.terminalStatus,'EXECUTION_COMPLETE');
    assert.equal(calls,2,'one controlled tool turn followed by completion');
    assert.equal(result.toolCallLog.length,1);assert.equal(result.toolCallLog[0]?.tool,'file_read');
    assert.equal(result.toolCallLog[0]?.exit_code,0);
    assert.equal(readFileSync('existing.txt','utf8'),'preserved fixture bytes');
    assert.equal(existsSync('forbidden.txt'),false);
    const unreviewed=new EvidenceBundle('unreviewed-task',process.env['BABEL_RUNS_DIR']!);
    await assert.rejects(()=>runExecutorLoop(plan,unreviewed,'deepseek',[],[],task),/requires an explicit PASS verdict/);
    assert.equal(calls,2,'missing QA approval still prevents executor activation');
    const {runGoalLoop}=await import('../services/goalLoop.js');
    const goal=await runGoalLoop(task,{tokenBudget:0});
    assert.equal(goal.status,'token_budget_exhausted');
    assert.equal(goal.iterations.length,0);
    assert.equal(calls,2,'an exhausted explicit goal budget still prevents another model request');
  });
}
