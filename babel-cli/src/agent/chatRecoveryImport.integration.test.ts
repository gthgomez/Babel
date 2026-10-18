import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {ChatEngine} from './chatEngine.js'
import type {ChatToolAction} from './chatToolDefinitions.js'
import type {ToolContext} from '../localTools.js'
import {createWorkingState,type WorkingState} from './codingLoop/workingState.js'
import {ingestVerifierResult} from './codingLoop/chatBindings.js'
import {recoveryObservationId} from './codingLoop/recoveryPlan.js'
import {SafeExecutor} from '../sandbox.js'
import {resetDockerAvailabilityCache,setDockerAvailableForTest} from '../config/benchmarkContainer.js'

const fixtures = [
  {name:'named import',path:'math.js',testPath:'math.test.js',label:'addition',source:'export function add(a,b) { return a-b; }\n',old:'return a-b;',replacement:'return a+b;',
    testSource:"import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from './math.js'; test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(0,7),7)});\n"},
  {name:'static stylesheet read',path:'styles.css',testPath:'style.test.js',label:'busy style',source:'.status { display: inline-flex; }\n',old:'.status { display: inline-flex; }',replacement:'.status { display: inline-flex; }\n.status-busy { opacity: 0.6; }',
    testSource:"import test from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('busy style',()=>assert.match(readFileSync(new URL('./styles.css',import.meta.url),'utf8'),/\\.status-busy\\s*\\{[^}]*opacity\\s*:\\s*0?\\.6/s));\n"},
]

test('an earlier mutation preserves direct non-test recovery without assertion localization',t=>{
  const root=mkdtempSync(join(tmpdir(),'babel-direct-recovery-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  writeFileSync(join(root,'source.ts'),'export const count: string = 1;\n')
  const state=createWorkingState('Fix the type error')
  state.lastMutation={path:'source.ts',at:1,fingerprint:'fixture-prior-edit'}
  const result=ingestVerifierResult({state,tool:'test_run',target:'npm run typecheck',exitCode:1,
    stdout:'',stderr:"source.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.",
    summary:'typecheck failed',recoveryProjectRoot:root,recoveryBinding:{schemaVersion:1,taskId:'fixture-task',contractHash:'fixture-contract',repositoryIdentity:'fixture-repo',workspaceRevision:'fixture-revision'}})
  assert.ok(result.state.recoveryGate?.failingTargets?.includes('source.ts'))
  assert.equal(result.state.recoveryGate?.satisfied,false,'the prior edit alone is not fresh recovery evidence')
  assert.equal(result.state.localization,undefined,'preserve direct recovery for an already implicated non-test target')
})

for (const fixture of fixtures) for (const priorMutation of [false,true]) test(`real recovery dispatch links the failed assertion through its ${fixture.name}${priorMutation ? ' after an earlier mutation' : ''} and verifies the scoped repair`, async t => {
  const storage=mkdtempSync(join(tmpdir(),'babel-recovery-import-'))
  const root=join(storage,'project'), runDir=join(storage,'runtime')
  mkdirSync(root);mkdirSync(runDir)
  const names=['BABEL_EXECUTION_PROFILE','BABEL_BENCHMARK_DOCKER_IMAGE','BABEL_DOCKER_DISABLE','BABEL_ALLOW_HOST_FALLBACK','BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] as const
  const old=names.map(name=>[name,process.env[name]] as const)
  t.after(()=>{for(const [name,value] of old){if(value===undefined)delete process.env[name];else process.env[name]=value}resetDockerAvailabilityCache();rmSync(storage,{recursive:true,force:true})})
  process.env['BABEL_EXECUTION_PROFILE']='safe_repo';process.env['BABEL_BENCHMARK_DOCKER_IMAGE']='synthetic/recovery-import:unit'
  delete process.env['BABEL_DOCKER_DISABLE'];delete process.env['BABEL_ALLOW_HOST_FALLBACK'];delete process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS']
  setDockerAvailableForTest(true)
  const {source,testSource}=fixture
  writeFileSync(join(root,fixture.path),source);writeFileSync(join(root,fixture.testPath),testSource)
  writeFileSync(join(root,'package.json'),'{"type":"module","scripts":{"test":"node --test"}}\n')
  if(priorMutation)writeFileSync(join(root,'preparation.js'),'export const prepared = false;\n')
  for(const args of [['init','-q'],['add','--',fixture.path,fixture.testPath,'package.json',...(priorMutation?['preparation.js']:[])],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']])
    execFileSync('git',args,{cwd:root,windowsHide:true}) // disposable fixture; every failure throws
  let verifiers=0
  const childEnv={...process.env};delete childEnv['NODE_TEST_CONTEXT']
  t.mock.method(SafeExecutor.prototype,'testRunAsync',async()=>{
    verifiers++
    try{return {exit_code:0,stdout:execFileSync(process.execPath,['--test','--test-reporter=tap',fixture.testPath],{cwd:root,env:childEnv,encoding:'utf8',windowsHide:true}),stderr:''}}
    catch(error){const e=error as {status:number;stdout:string;stderr:string};return {exit_code:e.status,stdout:String(e.stdout),stderr:String(e.stderr)}}
  })
  const engine=new ChatEngine({task:'Fix the failing tests. Preserve tests and package metadata.',projectRoot:root})
  const probe=engine as unknown as {workingState:WorkingState;lastVerifierReceipt:{exit_code:number;stale:boolean}|null;executeActions:(actions:ChatToolAction[],callbacks:object)=>Promise<unknown>;executeOneAction:(action:ChatToolAction,context:ToolContext,callbacks:object,meta:{index:number;ownerGeneration:number})=>Promise<{observation:string}>}
  const context:ToolContext={agentId:'test',runId:'test',runDir,babelRoot:root,projectRoot:root}
  let index=0
  const run=(action:ChatToolAction)=>probe.executeOneAction(action,context,{}, {index:index++,ownerGeneration:0})
  // An earlier valid edit must not prevent localizing the remaining failure
  // in a different implementation/data file. This is the installed C1 branch.
  if(priorMutation)await run({type:'write_file',path:'preparation.js',content:'export const prepared = true;\n'})
  // Ordinary journeys inspect first. Pre-failure cached reads cannot stand in
  // for the controller's required fresh post-failure observations.
  await run({type:'read_file',path:fixture.testPath})
  await run({type:'read_file',path:fixture.path})
  await run({type:'test_run',command:'npm test'})
  assert.equal(probe.lastVerifierReceipt?.exit_code,1)
  // Three ordinary reads in one model turn must not poison the first two
  // recovery observations when the third exceeds the localization scope cap.
  await probe.executeActions([{type:'read_file',path:fixture.testPath},{type:'read_file',path:fixture.path},{type:'read_file',path:'package.json'}],{})
  const gate=probe.workingState.recoveryGate!
  assert.ok(gate.failingTargets?.includes(fixture.path))
  assert.ok(!gate.failingTargets?.includes('package.json'),'an unrelated read cannot broaden repair scope')
  if(priorMutation)assert.ok(gate.failingTargets?.includes('preparation.js'),'retain the previously implicated edit target')
  assert.equal(gate.observedKeys?.length,2)
  const plan={schemaVersion:1 as const,failureSignature:gate.failureSignature,workspaceRevision:gate.binding!.workspaceRevision,
    hypothesisClass:'logic' as const,targetIdentities:[fixture.path],actionFamily:'str_replace' as const,criterionId:'npm test',supportingObservationIds:gate.observedKeys!.map(recoveryObservationId)}
  const wrongCriterion=await run({type:'str_replace',file_path:fixture.path,old_str:fixture.old,new_str:fixture.replacement,repair_plan:{...plan,criterionId:fixture.label}})
  assert.match(wrongCriterion.observation,/criterion_identity_mismatch/)
  assert.match(wrongCriterion.observation,/criterion_id_expected="npm test"/)
  assert.equal(readFileSync(join(root,fixture.path),'utf8'),source)
  assert.notEqual(probe.workingState.recoveryGate?.permitConsumed,true)
  const wrongTarget=await run({type:'str_replace',file_path:fixture.path,old_str:fixture.old,new_str:fixture.replacement,repair_plan:{...plan,targetIdentities:[`${fixture.path}:symbol`]}})
  assert.match(wrongTarget.observation,/target_identity_mismatch/)
  assert.ok(wrongTarget.observation.includes(`target_identities_expected=${JSON.stringify([fixture.path])}`))
  assert.equal(readFileSync(join(root,fixture.path),'utf8'),source)
  const mutation=await run({type:'str_replace',file_path:fixture.path,old_str:fixture.old,new_str:fixture.replacement,repair_plan:plan})
  assert.doesNotMatch(mutation.observation,/RECOVERY_(?:PLAN|EVIDENCE|CANDIDATE).*REQUIRED|isolation_unavailable/)
  assert.equal(readFileSync(join(root,fixture.path),'utf8'),source.replace(fixture.old,fixture.replacement))
  assert.equal(readFileSync(join(root,fixture.testPath),'utf8'),testSource)
  assert.equal(probe.workingState.recoveryGate?.permitConsumed,true)
  await run({type:'test_run',command:'npm test'})
  assert.equal(verifiers,2)
  assert.equal(probe.lastVerifierReceipt?.exit_code,0)
  assert.equal(probe.lastVerifierReceipt?.stale,false)
  assert.equal(probe.workingState.recoveryGate,undefined)
})
