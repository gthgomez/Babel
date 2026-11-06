import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs';

if (!isSyntheticProviderFixtureReady()) {
  test('Chat pipeline completion uses independently checked outputs in an isolated provider fixture', async t => {
    const fixture = prepareSyntheticProviderFixture();
    t.after(() => removeSyntheticProviderFixture(fixture.root));
    const child = spawn(process.execPath, [
      '--experimental-wasm-modules', '--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', fileURLToPath(import.meta.url),
    ], {cwd:fixture.cwd,env:fixture.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const code = await new Promise<number>(resolve => { child.once('error',()=>resolve(1));child.once('close',value=>resolve(value??1)); });
    t.diagnostic(summarizeSyntheticProviderOutput(output,code));
    for (const line of output.split('\n').filter(line => /^not ok \d+ - /.test(line))) t.diagnostic(line);
    assert.equal(code,0,'controlled planner outputs must not bypass completion verification');
  });
} else {
  process.env['BABEL_LIVE']='true';process.env['BABEL_DRY_RUN']='false';
  process.env['BABEL_DESKTOP_PROVIDER']='openrouter';process.env['BABEL_DESKTOP_MODEL_ROUTE']='glm-5.3-flash';
  const {EvidenceBundle}=await import('../evidence.js');
  const {OrchestratorManifestSchema,SwePlanSchema}=await import('../schemas/agentContracts.js');
  const {_runBabelPipelineInternal}=await import('../pipeline.js');
  const {withPipelineModelRoute}=await import('../execute.js');
  test('the existing plan schema rejects an empty model action set',()=>{
    assert.throws(()=>SwePlanSchema.parse({plan_version:'1.0',plan_type:'IMPLEMENTATION_PLAN',task_summary:'No steps',assumptions:[],risks:[],out_of_scope:[],root_cause:'Fixture',minimal_action_set:[]}));
  });
  writeFileSync('existing.txt','original');writeFileSync('correct.txt','hello');writeFileSync('wrong.txt','incorrect');writeFileSync('not-empty.txt','content');
  const step = (tool:string,target:string,content?:string) => ({step:1,tool,target,description:'Controlled planner action',rationale:'Fixture',reversible:true,verification:'Inspect result',...(content!==undefined?{content}:{})});
  const cases = [
    {name:'omitted required write',task:'Create missing.txt containing hello.',steps:[step('file_read','existing.txt')],status:'EXECUTOR_HALTED',missing:true},
    {name:'polite creation still requires independently observed output',task:'Could you create missing.txt containing hello?',steps:[step('file_read','existing.txt')],status:'EXECUTOR_HALTED',missing:true},
    {name:'a request wrapper after then still requires output',task:'Read existing.txt, then I need you to create missing.txt containing hello.',steps:[step('file_read','existing.txt')],status:'EXECUTOR_HALTED',missing:true},
    {name:'generated handoff cannot erase an owner-required write',task:'Create missing.txt containing hello.',handoff:'Read-only discovery first. Do not modify files during inspection.',steps:[step('file_read','existing.txt')],status:'EXECUTOR_HALTED',missing:true},
    {name:'generated handoff cannot authorize a write denied by the owner',task:'Read existing.txt. Do not modify files.',handoff:'Create forbidden.md with new content.',steps:[step('file_write','forbidden.md','unauthorized')],status:'EXECUTOR_HALTED',denied:true},
    {name:'polite explanation cannot authorize a generated write to its input',task:'Could you explain how to update existing.txt?',steps:[step('file_write','existing.txt','unauthorized')],status:'EXECUTOR_HALTED'},
    {name:'owner desire to explain cannot authorize a generated write',task:'I want you to explain how to update existing.txt.',steps:[step('file_write','existing.txt','unauthorized')],status:'EXECUTOR_HALTED'},
    {name:'unrelated write is not requested work',task:'Create missing.txt containing hello.',steps:[step('file_write','unrelated-created.md','unrelated')],status:'EXECUTOR_HALTED',missing:true},
    {name:'existing correct output is a valid read-only no-op',task:'Create correct.txt containing the exact string "hello".',steps:[step('file_read','correct.txt')],status:'COMPLETE'},
    {name:'read-only answer does not require a mutation',task:'Read existing.txt without editing.',steps:[step('file_read','existing.txt')],status:'COMPLETE'},
    {name:'legitimate empty file creation remains supported',task:'Create an empty file named empty-output.txt.',steps:[step('file_write','empty-output.txt','')],status:'COMPLETE'},
    {name:'a nonempty existing file cannot prove an explicit empty-file no-op',task:'Create an empty file named not-empty.txt.',steps:[step('file_read','not-empty.txt')],status:'EXECUTOR_HALTED'},
    {name:'existing wrong content is not a proven no-op',task:'Create wrong.txt containing the exact string "hello".',steps:[step('file_read','wrong.txt')],status:'EXACT_INSTRUCTION_DRIFT'},
  ];
  for (const cell of cases) test(cell.name,async t=>{
    writeFileSync('existing.txt','original');
    const plan=SwePlanSchema.parse({plan_version:'1.0',plan_type:'IMPLEMENTATION_PLAN',task_summary:'Planner claims done',assumptions:[],risks:[],out_of_scope:[],root_cause:'Fixture',minimal_action_set:cell.steps});
    let calls=0;
    t.mock.method(globalThis,'fetch',async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');
      const body=JSON.parse(String(init?.body));assert.equal(body.model,'z-ai/glm-5.3-flash');calls++;
      return new Response('data: '+JSON.stringify({model:body.model,choices:[{index:0,delta:{content:JSON.stringify(plan)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    });
    const manifest=OrchestratorManifestSchema.parse({
      orchestrator_version:'9.0',target_project:'global',target_project_path:process.cwd(),
      analysis:{task_summary:cell.task,task_category:'Backend',secondary_category:null,task_overlay_ids:[],complexity_estimate:'Low',pipeline_mode:'chat',purpose_mode:'execution',purpose_source:'fallback_default',purpose_confidence:0.9,ambiguity_note:null,routing_confidence:0.95},
      platform_profile:{profile_source:'not_required_for_routing',client_surface:'unspecified',container_model:null,ingestion_mode:'none',repo_write_mode:null,output_surface:[],platform_modes:[],execution_trust:null,data_trust:null,freshness_trust:null,action_trust:null,approval_mode:'none'},
      worker_configuration:{assigned_model:'deepseek-v4-pro',rationale:'Schema family; exact route is pinned independently'},compilation_state:'uncompiled',
      instruction_stack:{behavioral_ids:['behavioral_core_v11'],domain_id:'domain_swe_backend',skill_ids:[],model_adapter_id:'adapter_codex',project_overlay_id:null,task_overlay_ids:[],pipeline_stage_ids:[]},
      resolution_policy:{apply_domain_default_skills:true,expand_skill_dependencies:true,strict_conflict_mode:'error',task_shape_profile:'full'},prompt_manifest:[],handoff_payload:{user_request:cell.handoff??cell.task,system_directive:'Synthetic deterministic completion test'},
    });
    const evidence=new EvidenceBundle(cell.task,process.env['BABEL_RUNS_DIR']!);
    const result=await withPipelineModelRoute('glm-5.3-flash',()=>_runBabelPipelineInternal(cell.task,{mode:'chat',modelOverride:'glm-5.3-flash',disableMemoryExtraction:true,writeLatestPointers:false},evidence,manifest));
    assert.equal(calls,1,'one controlled planning request; no live inference');
    assert.equal(result.status,cell.status);
    if (cell.missing) { assert.equal(existsSync('missing.txt'),false);assert.match(result.errors?.join(' ')??'',/missing\.txt/); }
    if (cell.denied)assert.equal(existsSync('forbidden.md'),false);
    assert.equal(readFileSync('existing.txt','utf8'),'original');
    if (cell.name.startsWith('unrelated')) assert.equal(readFileSync('unrelated-created.md','utf8'),'unrelated');
    assert.equal(readFileSync('correct.txt','utf8'),'hello');
    assert.equal(readFileSync('wrong.txt','utf8'),'incorrect');
    if (cell.name.startsWith('legitimate empty')) assert.equal(readFileSync('empty-output.txt','utf8'),'');
  });
}
