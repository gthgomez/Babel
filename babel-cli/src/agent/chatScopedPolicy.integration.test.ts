import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatEngine } from './chatEngine.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { withExecutionPolicyChoice } from '../config/executionPolicySelection.js';
import { attachSessionAdmissionStore } from '../interactive/execution/chatTransport.js';
import { bindBdnsAfterCanonicalFlush } from '../diagnostics/bdns/sessionAttach.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js';

for(const scenario of ['host','docker'] as const)test(`a scoped ${scenario} session enforces its boundary through a real engine tool call`, {timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'babel-engine-scope-'));
  const keys=['BABEL_RUNS_DIR','BABEL_EXECUTION_PROFILE','BABEL_ALLOW_HOST_FALLBACK','BABEL_DOCKER_DISABLE','BABEL_BENCHMARK_DOCKER_IMAGE','BABEL_BENCHMARK_MODE','BABEL_BENCHMARK_AUTO_APPROVE','BABEL_DRY_RUN','BABEL_DRY_RUN_SOURCE','BABEL_AUTONOMY_LEASE','BABEL_CHAT_MAX_COST','BABEL_TOOL_PROFILE','OPENROUTER_API_KEY','COMMAND_CODE_API_KEY'] as const;
  const prior=keys.map(key=>[key,process.env[key]] as const);
  const canary='synthetic-scoped-provider-canary';
  let engine:ChatEngine | undefined;
  try{
    process.env['BABEL_RUNS_DIR']=join(root,'runs');process.env['BABEL_EXECUTION_PROFILE']=scenario==='host'?'safe_repo':'host_native';
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];delete process.env['BABEL_DOCKER_DISABLE'];delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];setDockerAvailableForTest(false);
    process.env['BABEL_BENCHMARK_MODE']='1';process.env['BABEL_BENCHMARK_AUTO_APPROVE']='1';
    process.env['BABEL_DRY_RUN']='0';process.env['BABEL_DRY_RUN_SOURCE']='session';
    process.env['BABEL_CHAT_MAX_COST']='unlimited';process.env['BABEL_TOOL_PROFILE']='native';
    process.env['OPENROUTER_API_KEY']=canary;process.env['COMMAND_CODE_API_KEY']='synthetic-other-provider-canary';
    process.env['BABEL_AUTONOMY_LEASE']=JSON.stringify({version:2,leaseId:'synthetic-scoped-policy',scope:{repository:'fixture',objective:'verify scoped execution'},allowedCapabilities:['run_arbitrary_code','run_local_command','run_tests','edit_task_files','inspect_repository']});
    writeFileSync(join(root,'check.mjs'),"import {writeFileSync} from 'node:fs'; const bad=['OPENROUTER_API_KEY','COMMAND_CODE_API_KEY'].some(k=>Object.hasOwn(process.env,k)); writeFileSync('result.txt',bad?'present':'absent');");
    for(const args of [['init','-q','--initial-branch=main'],['add','--','check.mjs'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']])execFileSync('git',args,{cwd:root,windowsHide:true,stdio:'ignore'});
    let calls=0;
    const runner={
      async *executeWithToolsStream(){
        if(calls++===0){yield {type:'tool_use' as const,id:'check-env',name:'run_command',input:{command:'node check.mjs'}};yield {type:'done' as const,finishReason:'tool_calls' as const};}
        else{yield {type:'text_delta' as const,text:'Fixture command completed.'};yield {type:'done' as const,finishReason:'stop' as const};}
      },getLastInvocationMetadata:()=>null,
    };
    const providerPolicy:ResolvedModelPolicy={policyPath:'fixture',family:'fixture',selectedTier:'cheap',resolvedBackendKey:'fixture',provider:'opencode-go',providerModelId:'fixture-model',expensive:false,enabled:true,experimental:true,blockedWithoutExplicitOptIn:false,approximateInputTokens:0,approximateOutputTokens:0,warnings:[],waterfall:[],stagePolicies:[],contextWindow:128000,contextLimit:128000,maxOutputTokens:1024,nativeToolUse:true};
    const choice=scenario==='host'?{profile:'host_native',source:'persisted',expectedBoundary:'host'} as const:{profile:'safe_repo',source:'persisted',expectedBoundary:'docker'} as const;
    engine=withExecutionPolicyChoice(choice,()=>new ChatEngine({task:'Run the fixture check.',operation:'CHANGE',projectRoot:root,model:'fixture-model',providerRunner:runner as never,providerPolicy,executionPolicy:choice}));
    attachSessionAdmissionStore(engine);
    const events:unknown[]=[];
    for await(const event of engine.submitMessageStream('Run node check.mjs and report the result.','execute'))events.push(event);
    const scrub=(value:unknown)=>String(value??'').replaceAll(canary,'[redacted]').replaceAll('synthetic-other-provider-canary','[redacted]').replaceAll(root,'[fixture]').slice(0,600);
    const summary=events.map(raw=>{
      const event=raw as Record<string,unknown>;
      const text=[event['error'],event['message'],event['answer'],event['result'],event['detail']].filter(value=>typeof value==='string').join(' ').toLowerCase();
      return {type:event['type'],error:scrub(event['error']),reason:typeof event['reason_code']==='string'?event['reason_code']:null,
        exitCode:typeof event['exitCode']==='number'?event['exitCode']:null,
        hints:['policy','isolation','docker','approval','budget','cancel','denied','invalid','setup','error','unavailable','autonomy','not found','enoent','command','execution','not allowed','simulated'].filter(hint=>text.includes(hint))};
    });
    const rows=(engine as unknown as {toolCallLog:Array<Record<string,unknown>>}).toolCallLog;
    const tools=rows.map(row=>({tool:row['tool'],detail:scrub(row['detail']),error:scrub(row['error']),stderr:scrub(row['stderr']),exit:row['exit_code'],started:row['processExecuted']}));
    if(scenario==='host'){
      assert.equal(existsSync(join(root,'result.txt')),true,`the actual host child must have run; event summary ${JSON.stringify(summary)} tool summary ${JSON.stringify(tools)}`);
      assert.equal(readFileSync(join(root,'result.txt'),'utf8'),'absent');
      const timing=engine.getLastTurnTelemetry()?.timing;
      assert.ok(timing,'the real engine must publish its turn timing');
      assert.equal(typeof timing.objectiveAdmissionMs,'number');
      assert.equal(typeof timing.repositoryContextMs,'number');
      assert.equal(typeof timing.systemPromptPreparationMs,'number');
      assert.equal(timing.providerRequestCreatedMs,null,'the synthetic runner did not report provider phases');
      assert.equal(typeof timing.firstUsefulToolCompletedMs,'number');
    }else{
      assert.equal(existsSync(join(root,'result.txt')),false,'a Docker-bound session must not fall back to a host child');
      assert.ok(events.some(raw=>(raw as {type?:string}).type==='tool_failed'));
    }
    assert.equal(JSON.stringify(events).includes(canary),false);
  }finally{
    if(engine){engine.closeAdmissionStore();await bindBdnsAfterCanonicalFlush({sessionId:engine.getEngineRunId(),runDir:chatSessionDir(engine.getEngineRunId()),close:true});}
    resetDockerAvailabilityCache();
    for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(root,{recursive:true,force:true});
  }
});
