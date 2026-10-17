import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {ChatEngine} from './chatEngine.js'
import type {ChatToolAction} from './chatToolDefinitions.js'
import type {ToolContext} from '../localTools.js'
import type {WorkingState} from './codingLoop/workingState.js'
import {recoveryObservationId} from './codingLoop/recoveryPlan.js'
import {SafeExecutor} from '../sandbox.js'
import {resetDockerAvailabilityCache,setDockerAvailableForTest} from '../config/benchmarkContainer.js'

test('real recovery dispatch links the failed assertion to its implementation and verifies the scoped repair', async t => {
  const storage=mkdtempSync(join(tmpdir(),'babel-recovery-import-'))
  const root=join(storage,'project'), runDir=join(storage,'runtime')
  mkdirSync(root);mkdirSync(runDir)
  const names=['BABEL_EXECUTION_PROFILE','BABEL_BENCHMARK_DOCKER_IMAGE','BABEL_DOCKER_DISABLE','BABEL_ALLOW_HOST_FALLBACK','BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] as const
  const old=names.map(name=>[name,process.env[name]] as const)
  t.after(()=>{for(const [name,value] of old){if(value===undefined)delete process.env[name];else process.env[name]=value}resetDockerAvailabilityCache();rmSync(storage,{recursive:true,force:true})})
  process.env['BABEL_EXECUTION_PROFILE']='safe_repo';process.env['BABEL_BENCHMARK_DOCKER_IMAGE']='synthetic/recovery-import:unit'
  delete process.env['BABEL_DOCKER_DISABLE'];delete process.env['BABEL_ALLOW_HOST_FALLBACK'];delete process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS']
  setDockerAvailableForTest(true)
  const source='export function add(a,b) { return a-b; }\n'
  const testSource="import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from './math.js'; test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(0,7),7)});\n"
  writeFileSync(join(root,'math.js'),source);writeFileSync(join(root,'math.test.js'),testSource)
  writeFileSync(join(root,'package.json'),'{"type":"module","scripts":{"test":"node --test"}}\n')
  for(const args of [['init','-q'],['add','--','math.js','math.test.js','package.json'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']])
    execFileSync('git',args,{cwd:root,windowsHide:true}) // disposable fixture; every failure throws
  let verifiers=0
  const childEnv={...process.env};delete childEnv['NODE_TEST_CONTEXT']
  t.mock.method(SafeExecutor.prototype,'testRunAsync',async()=>{
    verifiers++
    try{return {exit_code:0,stdout:execFileSync(process.execPath,['--test','math.test.js'],{cwd:root,env:childEnv,encoding:'utf8',windowsHide:true}),stderr:''}}
    catch(error){const e=error as {status:number;stdout:string;stderr:string};return {exit_code:e.status,stdout:String(e.stdout),stderr:String(e.stderr)}}
  })
  const engine=new ChatEngine({task:'Fix the failing tests. Preserve tests and package metadata.',projectRoot:root})
  const probe=engine as unknown as {workingState:WorkingState;lastVerifierReceipt:{exit_code:number;stale:boolean}|null;executeOneAction:(action:ChatToolAction,context:ToolContext,callbacks:object,meta:{index:number;ownerGeneration:number})=>Promise<{observation:string}>}
  const context:ToolContext={agentId:'test',runId:'test',runDir,babelRoot:root,projectRoot:root}
  let index=0
  const run=(action:ChatToolAction)=>probe.executeOneAction(action,context,{}, {index:index++,ownerGeneration:0})
  // Ordinary journeys inspect first. Pre-failure cached reads cannot stand in
  // for the controller's required fresh post-failure observations.
  await run({type:'read_file',path:'math.test.js'})
  await run({type:'read_file',path:'math.js'})
  await run({type:'test_run',command:'npm test'})
  assert.equal(probe.lastVerifierReceipt?.exit_code,1)
  await run({type:'read_file',path:'math.test.js'})
  assert.deepEqual(probe.workingState.recoveryGate?.failingTargets,['math.test.js'])
  assert.equal(probe.workingState.localization?.importCandidates?.[0]?.path,'math.js')
  await run({type:'read_file',path:'math.js'})
  const gate=probe.workingState.recoveryGate!
  assert.ok(gate.failingTargets?.includes('math.js'))
  assert.equal(gate.observedKeys?.length,2)
  const plan={schemaVersion:1 as const,failureSignature:gate.failureSignature,workspaceRevision:gate.binding!.workspaceRevision,
    hypothesisClass:'logic' as const,targetIdentities:['math.js'],actionFamily:'str_replace' as const,criterionId:'npm test',supportingObservationIds:gate.observedKeys!.map(recoveryObservationId)}
  const mutation=await run({type:'str_replace',file_path:'math.js',old_str:'return a-b;',new_str:'return a+b;',repair_plan:plan})
  assert.doesNotMatch(mutation.observation,/RECOVERY_(?:PLAN|EVIDENCE|CANDIDATE).*REQUIRED|isolation_unavailable/)
  assert.equal(readFileSync(join(root,'math.js'),'utf8'),source.replace('a-b','a+b'))
  assert.equal(readFileSync(join(root,'math.test.js'),'utf8'),testSource)
  assert.equal(probe.workingState.recoveryGate?.permitConsumed,true)
  await run({type:'test_run',command:'npm test'})
  assert.equal(verifiers,2)
  assert.equal(probe.lastVerifierReceipt?.exit_code,0)
  assert.equal(probe.lastVerifierReceipt?.stale,false)
  assert.equal(probe.workingState.recoveryGate,undefined)
})
