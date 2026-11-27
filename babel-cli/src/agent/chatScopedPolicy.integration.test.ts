import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatEngine } from './chatEngine.js';
import type { ResolvedModelPolicy } from '../modelPolicy.js';
import { withExecutionPolicyChoice } from '../config/executionPolicySelection.js';
import { attachSessionAdmissionStore } from '../interactive/execution/chatTransport.js';
import { bindBdnsAfterCanonicalFlush } from '../diagnostics/bdns/sessionAttach.js';
import { chatSessionDir } from '../cli/runsLayout.js';
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js';
import { currentForegroundEffects } from './foregroundEffectReceipt.js';
import { loadEffectLedger } from '../executor/effectLedger.js';
import { parseSessionEventLog, serializeSessionEventLog } from './sessionEvents.js';

for(const scenario of ['host','docker','file-output','captured-output','concurrent-output','dry-run','retained-read-only'] as const)test(`a scoped ${scenario} session enforces its boundary through a real engine tool call`, {timeout:45000},async()=>{
  const fixtureRoot=mkdtempSync(join(tmpdir(),'babel-engine-scope-'));
  const root=join(fixtureRoot,'project');
  mkdirSync(root);
  const keys=['BABEL_RUNS_DIR','BABEL_EXECUTION_PROFILE','BABEL_ALLOW_HOST_FALLBACK','BABEL_DOCKER_DISABLE','BABEL_BENCHMARK_DOCKER_IMAGE','BABEL_BENCHMARK_MODE','BABEL_BENCHMARK_AUTO_APPROVE','BABEL_DRY_RUN','BABEL_DRY_RUN_SOURCE','BABEL_AUTONOMY_LEASE','BABEL_CHAT_MAX_COST','BABEL_TOOL_PROFILE','OPENROUTER_API_KEY','COMMAND_CODE_API_KEY'] as const;
  const prior=keys.map(key=>[key,process.env[key]] as const);
  const canary='synthetic-scoped-provider-canary';
  let engine:ChatEngine | undefined;
  try{
    process.env['BABEL_RUNS_DIR']=join(fixtureRoot,'runs');process.env['BABEL_EXECUTION_PROFILE']=scenario!=='docker'?'safe_repo':'host_native';
    delete process.env['BABEL_ALLOW_HOST_FALLBACK'];delete process.env['BABEL_DOCKER_DISABLE'];delete process.env['BABEL_BENCHMARK_DOCKER_IMAGE'];setDockerAvailableForTest(false);
    process.env['BABEL_BENCHMARK_MODE']='1';process.env['BABEL_BENCHMARK_AUTO_APPROVE']='1';
    if(scenario==='file-output'||scenario==='captured-output'||scenario==='concurrent-output'){
      delete process.env['BABEL_DRY_RUN'];delete process.env['BABEL_DRY_RUN_SOURCE'];
    }else{
      process.env['BABEL_DRY_RUN']=scenario==='dry-run'?'1':'0';process.env['BABEL_DRY_RUN_SOURCE']='session';
    }
    process.env['BABEL_CHAT_MAX_COST']='unlimited';process.env['BABEL_TOOL_PROFILE']='native';
    process.env['OPENROUTER_API_KEY']=canary;process.env['COMMAND_CODE_API_KEY']='synthetic-other-provider-canary';
    process.env['BABEL_AUTONOMY_LEASE']=JSON.stringify({version:2,leaseId:'synthetic-scoped-policy',scope:{repository:'fixture',objective:'verify scoped execution'},allowedCapabilities:['run_arbitrary_code','run_local_command','run_tests','edit_task_files','inspect_repository']});
    const capturedOutput = scenario === 'captured-output';
    const concurrentOutput = scenario === 'concurrent-output';
    const fileOutput = scenario === 'file-output' || capturedOutput || concurrentOutput;
    const retainedReadOnly = scenario === 'retained-read-only';
    writeFileSync(join(root,'check.mjs'),capturedOutput || concurrentOutput ? [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      "const bytes = readFileSync(process.argv[2], 'utf8').toUpperCase();",
      "if (process.env.BABEL_FOREGROUND_OUTPUT_PATH === process.argv[3]) {",
      ...(concurrentOutput ? [
        "  writeFileSync('child-started', 'running');",
        "  for (let i = 0; !existsSync(process.argv[3]) && i < 500; i++) await delay(20);",
      ] : []),
      "  process.stdout.write('BABEL_FOREGROUND_OUTPUT_V1\\n' + bytes);",
      "} else writeFileSync(process.argv[3], bytes);",
    ].join('\n') : fileOutput
      ? "import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync(process.argv[3],readFileSync(process.argv[2],'utf8').toUpperCase());"
      : retainedReadOnly ? "console.log('checked in a real process');"
        : "import {writeFileSync} from 'node:fs'; const bad=['OPENROUTER_API_KEY','COMMAND_CODE_API_KEY'].some(k=>Object.hasOwn(process.env,k)); writeFileSync('result.txt',bad?'present':'absent');");
    if(fileOutput)writeFileSync(join(root,'input.txt'),'café\n');
    for(const args of [['init','-q','--initial-branch=main'],['add','--','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']])execFileSync('git',args,{cwd:root,windowsHide:true,stdio:'ignore'});
    const command=retainedReadOnly?'node --version':fileOutput?'node check.mjs input.txt result.txt':'node check.mjs';
    let calls=0;
    const runner={
      async *executeWithToolsStream(_messages: unknown, tools: Array<{ function: { name: string } }>){
        const index=calls++;
        if (retainedReadOnly && index === 0) {
          assert.ok(tools.some(tool => tool.function.name === 'run_command'));
          assert.ok(!tools.some(tool => tool.function.name === 'write_file'));
          yield { type: 'tool_use' as const, id: 'undeclared', name: 'run_command', input: { command: 'node check.mjs' } };
          yield { type: 'tool_use' as const, id: 'background', name: 'run_command', input: { command, background: true } };
          yield { type: 'tool_use' as const, id: 'write', name: 'write_file', input: { path: 'result.txt', content: 'unauthorized' } };
          yield { type: 'done' as const, finishReason: 'tool_calls' as const };
        } else if(index===0||((fileOutput||scenario==='host'||retainedReadOnly)&&index===1)){
          const name=scenario==='host'&&index===0?'test_run':'run_command';
          yield {type:'tool_use' as const,id:`check-env-${index}`,name,input:{command}};
          yield {type:'done' as const,finishReason:'tool_calls' as const};
        }
        else{yield {type:'text_delta' as const,text:'Fixture command completed.'};yield {type:'done' as const,finishReason:'stop' as const};}
      },
      async executeRaw() {
        // The Go fixture may invoke the normal diff-critic lane in CI.
        const output = join(root, 'result.txt');
        const matches = existsSync(output) &&
          readFileSync(output, 'utf8') === (fileOutput ? 'CAFÉ\n' : 'absent');
        return JSON.stringify({
          verdict: matches ? 'pass' : 'reject',
          confidence: 1,
          reasons: [matches ? 'Fixture output matches the expected bytes' : 'Fixture output is missing or different'],
        });
      },
      getLastInvocationMetadata:()=>null,
    };
    const providerPolicy:ResolvedModelPolicy={policyPath:'fixture',family:'fixture',selectedTier:'cheap',resolvedBackendKey:'fixture',provider:'opencode-go',providerModelId:'fixture-model',expensive:false,enabled:true,experimental:true,blockedWithoutExplicitOptIn:false,approximateInputTokens:0,approximateOutputTokens:0,warnings:[],waterfall:[],stagePolicies:[],contextWindow:128000,contextLimit:128000,maxOutputTokens:1024,nativeToolUse:true};
    const choice=scenario!=='docker'?{profile:'host_native',source:'persisted',expectedBoundary:'host'} as const:{profile:'safe_repo',source:'persisted',expectedBoundary:'docker'} as const;
    const initial = retainedReadOnly ? 'Inspect check.mjs and explain what it does.' : undefined;
    const task=retainedReadOnly?'Also run `node --version`.':fileOutput?'Run check.mjs to create result.txt from input.txt.':'Run `node check.mjs`.';
    const initialTask = initial ?? task;
    engine=withExecutionPolicyChoice(choice,()=>new ChatEngine({task:initialTask,projectRoot:root,model:'fixture-model',providerRunner:runner as never,providerPolicy,executionPolicy:choice}));
    attachSessionAdmissionStore(engine);
    if (initial) engine.admitUserSubmission({ userInput: initial }, { model: 'fixture-model', provider: 'opencode-go' });
    const concurrentWriter = concurrentOutput ? (async () => {
      for (let i = 0; i < 1000; i++) {
        if (existsSync(join(root, 'child-started'))) {
          writeFileSync(join(root, 'result.txt'), 'other writer\n', { flag: 'wx' });
          return true;
        }
        await delay(20);
      }
      return false;
    })() : undefined;
    const events:unknown[]=[];
    for await(const event of engine.submitMessageStream(task))events.push(event);
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
    if(scenario==='host'||(fileOutput&&!concurrentOutput)){
      assert.equal(existsSync(join(root,'result.txt')),true,`the actual host child must have run; event summary ${JSON.stringify(summary)} tool summary ${JSON.stringify(tools)}`);
      assert.equal(readFileSync(join(root,'result.txt'),'utf8'),fileOutput?'CAFÉ\n':'absent');
      assert.equal(rows.filter(row=>row['target']===command&&row['processCompleted']===true).length,1);
      if(scenario==='host'){
        assert.equal(rows.filter(row=>row['detail']==='required_foreground_run_command').length,1);
        assert.equal(engine.getParityRuntime().sessionEvents.events.some(event=>event.kind==='tool_started'&&event.tool_name==='test_run'),false);
      }
      assert.equal(engine.getParityRuntime().sessionEvents.events.filter(event =>
        event.kind==='tool_completed' && event.foreground_effect?.argv.join(' ')===command).length,1,
      `foreground custody missing; tools ${JSON.stringify(tools)}`);
      const terminal = events.at(-1) as { outcome?: string; reason_code?: string };
      const log = engine.getParityRuntime().sessionEvents;
      const ledger = loadEffectLedger(chatSessionDir(engine.getEngineRunId()));
      const effects = currentForegroundEffects(root, engine.getTaskContract()!, log, ledger);
      assert.equal(terminal?.outcome,fileOutput&&!capturedOutput?'BLOCKED_POLICY':'VERIFIED_COMPLETE', JSON.stringify({
        reason: terminal?.reason_code, terminal: summary.at(-1), matches: effects.length,
      }));
      assert.equal(effects.length,1);
      const restored = parseSessionEventLog(serializeSessionEventLog(log), log.session_id);
      assert.deepEqual(currentForegroundEffects(root, engine.getTaskContract()!, restored, ledger), effects);
      const wrongArgv = structuredClone(restored);
      for (const event of wrongArgv.events) {
        if (event.kind === 'tool_completed' && event.foreground_effect) event.foreground_effect.argv.push('extra');
      }
      assert.equal(currentForegroundEffects(root, engine.getTaskContract()!, wrongArgv, ledger).length,0);
      if(fileOutput){
        assert.equal(readFileSync(join(root,'input.txt'),'utf8'),'café\n');
        assert.equal(rows.filter(row=>row['detail']==='required_foreground_already_started').length,1);
        assert.equal(effects[0]?.output?.path,'result.txt');
        assert.equal(effects[0]?.output?.before,null);
        assert.equal(effects[0]?.output?.source, capturedOutput ? 'child_stdout' : undefined);
        const withoutPublication = ledger.map(row => row.status === 'completed' && row.postImageHashes
          ? { ...row, postImageHashes: { workspace: row.postImageHashes['workspace']! } } : row);
        if (capturedOutput) assert.equal(currentForegroundEffects(root, engine.getTaskContract()!, log, withoutPublication).length, 0);
        assert.deepEqual(Object.keys(effects[0]!.input_hashes).sort(),['check.mjs','input.txt']);
      }
      const withoutStart = { ...log, events: log.events.filter(event => event.kind !== 'tool_started') };
      assert.equal(currentForegroundEffects(root, engine.getTaskContract()!, withoutStart, ledger).length,0);
      writeFileSync(join(root,'result.txt'),'changed after settlement');
      assert.equal(currentForegroundEffects(root, engine.getTaskContract()!, log, ledger).length,0);
      const timing=engine.getLastTurnTelemetry()?.timing;
      assert.ok(timing,'the real engine must publish its turn timing');
      assert.equal(typeof timing.objectiveAdmissionMs,'number');
      assert.equal(typeof timing.repositoryContextMs,'number');
      assert.equal(typeof timing.systemPromptPreparationMs,'number');
      assert.equal(timing.providerRequestCreatedMs,null,'the synthetic runner did not report provider phases');
      assert.equal(typeof timing.firstUsefulToolCompletedMs,'number');
    }else if(concurrentOutput){
      assert.equal(await concurrentWriter,true);
      assert.equal(readFileSync(join(root,'result.txt'),'utf8'),'other writer\n');
      assert.equal(engine.getParityRuntime().sessionEvents.events.some(event =>
        event.kind==='tool_completed' && event.foreground_effect?.output?.source === 'child_stdout'),false);
      assert.notEqual((events.at(-1) as {outcome?:string})?.outcome,'VERIFIED_COMPLETE');
    }else if(retainedReadOnly){
      assert.equal(engine.getTurnRuntimeSnapshot()?.effectiveOperation, 'READ_ONLY');
      assert.equal(engine.getTaskContract()?.user_request, initial);
      assert.equal(existsSync(join(root,'result.txt')),false);
      const log = engine.getParityRuntime().sessionEvents;
      assert.deepEqual(log.events.filter(event => event.kind === 'tool_started').map(event => event.target_summary), [command]);
      assert.equal(log.events.filter(event => event.kind === 'tool_completed' && event.foreground_effect).length, 1);
      assert.equal(rows.filter(row => row['target'] === command && row['processCompleted'] === true).length, 1);
    }else if(scenario==='docker'){
      assert.equal(existsSync(join(root,'result.txt')),false,'a Docker-bound session must not fall back to a host child');
      assert.ok(events.some(raw=>(raw as {type?:string}).type==='tool_failed'));
      assert.equal(engine.getParityRuntime().sessionEvents.events.some(event =>
        event.kind==='tool_completed' && event.foreground_effect),false);
    }else{
      assert.equal(existsSync(join(root,'result.txt')),false,'explicit dry-run never starts the requested process');
      assert.equal(engine.getParityRuntime().sessionEvents.events.some(event =>
        (event.kind==='tool_completed' && event.foreground_effect) ||
        (event.kind==='tool_started' && event.foreground_criterion_id)),false);
      assert.notEqual((events.at(-1) as {outcome?:string})?.outcome,'VERIFIED_COMPLETE');
    }
    assert.equal(JSON.stringify(events).includes(canary),false);
  }finally{
    if(engine){engine.closeAdmissionStore();await bindBdnsAfterCanonicalFlush({sessionId:engine.getEngineRunId(),runDir:chatSessionDir(engine.getEngineRunId()),close:true});}
    resetDockerAvailabilityCache();
    for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(fixtureRoot,{recursive:true,force:true});
  }
});
