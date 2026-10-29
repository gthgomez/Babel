import { recordToolProposed, recordToolTerminal } from './sessionEvents.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {execFileSync} from 'node:child_process'
import {ChatEngine} from './chatEngine.js'
import type {ChatToolAction} from './chatToolDefinitions.js'
import type {ToolContext} from '../localTools.js'
import {createWorkingState,type WorkingState} from './codingLoop/workingState.js'
import {ingestVerifierResult} from './codingLoop/chatBindings.js'
import {recoveryObservationId} from './codingLoop/recoveryPlan.js'
import {SafeExecutor} from '../sandbox.js'
import {buildBenchmarkContainerCommand,resetDockerAvailabilityCache,setDockerAvailableForTest} from '../config/benchmarkContainer.js'

const fixtures = [
  {name:'named import',path:'math.js',testPath:'math.test.js',label:'addition',source:'export function add(a,b) { return a-b; }\n',old:'return a-b;',replacement:'return a+b;',
    testSource:"import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from './math.js'; test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(0,7),7)});\n"},
  {name:'TypeScript named import',path:'math.js',testPath:'math.test.ts',label:'addition',source:'export function add(a,b) { return a-b; }\n',old:'return a-b;',replacement:'return a+b;',
    testSource:"import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from './math.js'; test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(0,7),7)});\n"},
  {name:'TypeScript local const and parent import',path:'src/math.ts',testPath:'tests/math.test.ts',label:'addition',source:'export function add(a: number,b: number) { return a-b; }\n',old:'return a-b;',replacement:'return a+b;',
    testSource:"import test from 'node:test'; import assert from 'node:assert/strict'; import {add} from '../src/math.ts'; test('addition',()=>{const actual = add(2,3);assert.equal(actual,5)});\n"},
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

for (const fixture of fixtures) for (const priorMutation of [false,true]) test(`real recovery dispatch links the failed assertion through its ${fixture.name}${priorMutation ? ' after an earlier mutation' : ''} with fresh evidence`, async t => {
  const storage=mkdtempSync(join(tmpdir(),'babel-recovery-import-'))
  const root=join(storage,'project'), runDir=join(storage,'runtime')
  mkdirSync(root);mkdirSync(runDir)
  const names=['BABEL_LIVE','BABEL_EXECUTION_PROFILE','BABEL_BENCHMARK_DOCKER_IMAGE','BABEL_DOCKER_DISABLE','BABEL_ALLOW_HOST_FALLBACK','BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] as const
  const old=names.map(name=>[name,process.env[name]] as const)
  t.after(()=>{for(const [name,value] of old){if(value===undefined)delete process.env[name];else process.env[name]=value}resetDockerAvailabilityCache();rmSync(storage,{recursive:true,force:true})})
  process.env['BABEL_LIVE']='true' // opt in to the test-owned native adapter, never ambient provider inference
  process.env['BABEL_EXECUTION_PROFILE']='safe_repo';process.env['BABEL_BENCHMARK_DOCKER_IMAGE']='synthetic/recovery-import:unit'
  delete process.env['BABEL_DOCKER_DISABLE'];delete process.env['BABEL_ALLOW_HOST_FALLBACK'];delete process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS']
  setDockerAvailableForTest(true)
  const {source,testSource}=fixture
  mkdirSync(dirname(join(root,fixture.path)),{recursive:true});mkdirSync(dirname(join(root,fixture.testPath)),{recursive:true})
  writeFileSync(join(root,fixture.path),source);writeFileSync(join(root,fixture.testPath),testSource)
  writeFileSync(join(root,'README.md'),'Inspect the project and implementation before repairing.\n')
  for(let i=0;i<3;i++)writeFileSync(join(root,`discovery${i}.ts`),`export const value${i} = ${i};\n`)
  writeFileSync(join(root,'package.json'),'{"type":"module","scripts":{"test":"node --test"}}\n')
  if(priorMutation)writeFileSync(join(root,'preparation.js'),'export const prepared = false;\n')
  for(const args of [['init','-q'],['add','--',fixture.path,fixture.testPath,'package.json','README.md','discovery0.ts','discovery1.ts','discovery2.ts',...(priorMutation?['preparation.js']:[])],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']])
    execFileSync('git',args,{cwd:root,windowsHide:true}) // disposable fixture; every failure throws
  let verifiers=0
  const childEnv={...process.env};delete childEnv['NODE_TEST_CONTEXT']
  t.mock.method(SafeExecutor.prototype,'testRunAsync',async()=>{
    verifiers++
    // This test-owned adapter really executes Node outside the mocked Docker
    // transport; retain factual start evidence only after native completion.
    try{return {exit_code:0,stdout:execFileSync(process.execPath,['--test','--test-reporter=tap',fixture.testPath],{cwd:root,env:childEnv,encoding:'utf8',windowsHide:true}),stderr:'',process_started:true,process_termination:'exited' as const}}
    catch(error){const e=error as {status:number|null;stdout:string;stderr:string};return {exit_code:e.status??1,stdout:String(e.stdout),stderr:String(e.stderr),process_started:Number.isInteger(e.status)}}
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
  // Authorized discovery is not vetoed by AST candidates or a two-scope cap.
  // Each delivered read retains a current target/window-specific handle.
  const delivered = await probe.executeActions([{type:'read_file',path:'README.md'},{type:'read_file',path:fixture.testPath},{type:'read_file',path:'discovery0.ts'},{type:'read_file',path:'discovery1.ts'},{type:'read_file',path:fixture.path}],{}) as { observationList: string[] }
  const gate=probe.workingState.recoveryGate!
  assert.ok(gate.readRecords?.some(record => record.target === fixture.path))
  assert.ok(!gate.failingTargets?.includes('package.json'),'an unrelated read cannot broaden repair scope')
  if(priorMutation)assert.ok(gate.failingTargets?.includes('preparation.js'),'retain the previously implicated edit target')
  assert.equal(gate.observedKeys?.length,5)
  const sourceRecord=gate.readRecords?.find(record=>record.target===fixture.path)
  assert.ok(sourceRecord)
  assert.ok(delivered.observationList[4]?.includes(sourceRecord.id),'the fifth read exposes its own current handle')
  assert.equal(sourceRecord.window.completeFile,true)
  assert.equal(probe.workingState.localization?.calls,5,'the fifth authorized read is not refused')
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

test('an actually started red without a receipt can rerun through normal governed dispatch', async t => {
  const storage = mkdtempSync(join(tmpdir(), 'babel-unbound-red-')); const root = join(storage, 'project'); mkdirSync(root)
  const names = ['BABEL_LIVE','BABEL_RUNS_DIR','BABEL_EXECUTION_PROFILE','BABEL_BENCHMARK_DOCKER_IMAGE','BABEL_DOCKER_DISABLE','BABEL_ALLOW_HOST_FALLBACK'] as const
  const old = names.map(name => [name, process.env[name]] as const)
  t.after(() => { for (const [name,value] of old) { if (value === undefined) delete process.env[name]; else process.env[name] = value }; resetDockerAvailabilityCache(); rmSync(storage, { recursive:true, force:true }) })
  process.env['BABEL_LIVE'] = 'true'; process.env['BABEL_RUNS_DIR'] = join(storage, 'runs'); process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'synthetic/recovery-import:unit'; delete process.env['BABEL_DOCKER_DISABLE']; delete process.env['BABEL_ALLOW_HOST_FALLBACK']; setDockerAvailableForTest(true)
  writeFileSync(join(root,'source.cjs'),'module.exports = 1;\n')
  writeFileSync(join(root,'proof.test.cjs'),"const test=require('node:test');const assert=require('node:assert/strict');test('value',()=>assert.equal(require('./source.cjs'),2));\n")
  writeFileSync(join(root,'package.json'),'{"scripts":{"test":"node --test proof.test.cjs"}}\n')
  for (const args of [['init','-q'],['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']]) execFileSync('git',args,{cwd:root,windowsHide:true})
  let executed = 0; const childEnv = {...process.env}; delete childEnv['NODE_TEST_CONTEXT']
  t.mock.method(SafeExecutor.prototype,'testRunAsync',async () => {
    executed++
    try { return { exit_code:0, stdout:execFileSync(process.execPath,['--test','--test-reporter=tap','proof.test.cjs'],{cwd:root,env:childEnv,encoding:'utf8',windowsHide:true}),stderr:'',process_started:true,process_termination:'exited' as const } }
    catch (error) { const e=error as {status:number;stdout:string;stderr:string}; return {exit_code:e.status,stdout:String(e.stdout),stderr:String(e.stderr),process_started:true,process_termination:'exited' as const} }
  })
  const { RevisionManager } = await import('../evidence/revisionBoundReceipt.js')
  const compute = RevisionManager.computeRevision.bind(RevisionManager)
  let captureFails = true
  t.mock.method(RevisionManager,'computeRevision',async (...args: Parameters<typeof compute>) => {
    if (captureFails) throw new Error('fixture receipt capture unavailable after actual execution')
    return compute(...args)
  })
  const task = 'Fix the implementation and run npm test. Preserve the test.'
  const engine = new ChatEngine({task,projectRoot:root,requiredVerifierCommands:['npm test']})
  engine.admitUserSubmission({userInput:task},{model:'fixture-model',provider:'ollama'})
  const host = engine as unknown as { _turnIndex:number; workingState:WorkingState; parity: import('./chatEngineParityBridge.js').ParityRuntime;
    toolCallLog:Array<{exit_code?:number;error?:string}>; executeOneAction:(action:ChatToolAction,context:ToolContext,callbacks:object,meta:object)=>Promise<{observation:string}>;
    lastVerifierReceipt:{exit_code:number}|null }
  const run = async (action:ChatToolAction) => {
    const id = `native-replay-${++host._turnIndex}`; const turn = host.parity.turnId!;
    recordToolProposed(host.parity.sessionEvents,{turn_id:turn,tool_call_id:id,tool_name:action.type})
    const result = await host.executeOneAction(action,{agentId:'test',runId:'test',runDir:join(storage,'runtime'),babelRoot:root,projectRoot:root},{},{index:host._turnIndex, idempotencyKey:id})
    const row = host.toolCallLog.at(-1)!
    const started = host.parity.sessionEvents.events.some(event => event.kind === 'tool_started' && event.tool_call_id === id)
    recordToolTerminal(host.parity.sessionEvents,{turn_id:turn,tool_call_id:id,tool_name:action.type,
      ...(started ? { ...(row.exit_code !== undefined ? {exit_code:row.exit_code} : {}), content:result.observation, failed:!!row.error }
        : { cancelled:true, reason:'pre_dispatch_denied_or_invalid', recovery_state:'TOOL_NOT_STARTED' as const }) })
    return {observationList:[result.observation]}
  }
  const preparation = await run({type:'write_file',path:'preparation.cjs',content:'module.exports = true;\n'})
  const firstRed = await run({type:'test_run',command:'npm test'})
  assert.equal(executed,1,JSON.stringify({preparation,firstRed}))
  assert.equal(host.lastVerifierReceipt,null)
  assert.equal(host.workingState.recoveryGate?.failureSignature,'unbound-red-verifier')
  assert.ok(host.workingState.settledFailedVerifier, 'actual dispatch/settlement survives receipt capture failure')
  captureFails = false
  const rerun = await run({type:'test_run',command:'npm test'})
  assert.equal(executed,2,JSON.stringify(rerun.observationList))
  assert.equal((host.lastVerifierReceipt as {exit_code:number}|null)?.exit_code,1)
  assert.notEqual(host.workingState.recoveryGate?.failureSignature,'unbound-red-verifier')
  const denied = await run({type:'run_command',command:'node -e "process.exit(0)"'})
  assert.equal(executed,2)
  assert.match(denied.observationList.join('\n'), /RECOVERY_|DENY|denied/i)
})

test('a Python verifier does not invalidate the current recovery candidate with container bytecode', async t => {
  const storage = mkdtempSync(join(tmpdir(), 'babel-python-recovery-cache-'))
  const root = join(storage, 'project'), runDir = join(storage, 'runtime')
  mkdirSync(root); mkdirSync(runDir)
  const names = ['BABEL_LIVE','BABEL_RUNS_DIR','BABEL_EXECUTION_PROFILE','BABEL_BENCHMARK_DOCKER_IMAGE','BABEL_DOCKER_DISABLE','BABEL_ALLOW_HOST_FALLBACK','BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] as const
  const old = names.map(name => [name, process.env[name]] as const)
  t.after(() => { for (const [name,value] of old) { if (value === undefined) delete process.env[name]; else process.env[name] = value }; resetDockerAvailabilityCache(); rmSync(storage, { recursive:true, force:true }) })
  process.env['BABEL_LIVE'] = 'true'; process.env['BABEL_RUNS_DIR'] = join(storage, 'runs'); process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'synthetic/python:unit'; delete process.env['BABEL_DOCKER_DISABLE']; delete process.env['BABEL_ALLOW_HOST_FALLBACK']; delete process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS']; setDockerAvailableForTest(true)

  const command = 'python -m doctest solution.py -v'
  const source = 'def answer():\n    """Return the expected value.\n    >>> answer()\n    1\n    """\n    return -1\n'
  writeFileSync(join(root, 'solution.py'), source)
  execFileSync('git', ['init', '-q'], { cwd:root, windowsHide:true })
  execFileSync('git', ['add', 'solution.py'], { cwd:root, windowsHide:true })
  execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture'], { cwd:root, windowsHide:true })

  t.mock.method(SafeExecutor.prototype, 'testRunAsync', async (actualCommand: string) => {
    assert.equal(actualCommand, command)
    const prepared = buildBenchmarkContainerCommand({
      dockerImage: process.env['BABEL_BENCHMARK_DOCKER_IMAGE']!, projectRoot:root, cwd:root, command:actualCommand,
    })
    const containerEnv = new Map<string,string>()
    for (let index = 0; index < prepared.args.length - 1; index++) {
      if (prepared.args[index] !== '-e') continue
      const pair = prepared.args[index + 1] ?? '', eq = pair.indexOf('=')
      if (eq > 0) containerEnv.set(pair.slice(0,eq),pair.slice(eq + 1))
    }
    // Model Python's normal import cache side effect at the Docker transport
    // seam. Before the runtime fix, the untracked .pyc changes the candidate
    // between the red receipt and the controller's next recovery action.
    if (containerEnv.get('PYTHONDONTWRITEBYTECODE') !== '1') {
      mkdirSync(join(root,'__pycache__'), { recursive:true })
      writeFileSync(join(root,'__pycache__','solution.cpython-311.pyc'), 'container-generated cache')
    }
    return {
      exit_code:1,
      stdout:'*** Failed example:\n    answer()\nExpected: 1\nGot: 0\nFile "/app/solution.py", line 4, in answer\n',
      stderr:'', process_started:true, process_termination:'exited' as const,
    }
  })

  const task = 'Fix the failing doctest in solution.py. Run `python -m doctest solution.py -v` before completion. Preserve the examples.'
  const engine = new ChatEngine({ task, projectRoot:root, requiredVerifierCommands:[command] })
  engine.admitUserSubmission({ userInput:task }, { model:'fixture-model', provider:'ollama' })
  const host = engine as unknown as {
    _turnIndex:number; parity:{turnId:string;sessionEvents:import('./sessionEvents.js').SessionEventLog};
    workingState:WorkingState; toolCallLog:Array<{error?:string;exit_code?:number}>;
    lastVerifierReceipt:{exit_code:number;stale:boolean}|null;
    currentRecoveryBinding:()=>{workspaceRevision:string}|null;
    executeOneAction:(action:ChatToolAction,context:ToolContext,callbacks:object,meta:{index:number;idempotencyKey:string;ownerGeneration:number})=>Promise<{observation:string}>;
  }
  const context:ToolContext = { agentId:'test', runId:'test', runDir, babelRoot:root, projectRoot:root }
  const run = async (action:ChatToolAction) => {
    const id = `python-cache-${++host._turnIndex}`, turn = host.parity.turnId
    recordToolProposed(host.parity.sessionEvents, { turn_id:turn, tool_call_id:id, tool_name:action.type })
    const result = await host.executeOneAction(action, context, {}, { index:host._turnIndex, idempotencyKey:id, ownerGeneration:0 })
    const row = host.toolCallLog.at(-1)!
    const started = host.parity.sessionEvents.events.some(event => event.kind === 'tool_started' && event.tool_call_id === id)
    recordToolTerminal(host.parity.sessionEvents, { turn_id:turn, tool_call_id:id, tool_name:action.type,
      ...(started ? { ...(row.exit_code !== undefined ? {exit_code:row.exit_code} : {}), content:result.observation, failed:!!row.error }
        : { cancelled:true, reason:'pre_dispatch_denied_or_invalid', recovery_state:'TOOL_NOT_STARTED' as const }) })
    return result
  }

  const firstEdit = await run({ type:'str_replace', file_path:'solution.py', old_str:'    return -1', new_str:'    return 0' })
  assert.doesNotMatch(firstEdit.observation, /CAPABILITY_DENIED|DENY_MISSING_AUTHORITY/)
  const initial = host.currentRecoveryBinding()
  assert.ok(initial?.workspaceRevision)
  const red = await run({ type:'test_run', command })
  assert.match(red.observation, /exit_code: 1/)
  assert.equal(host.lastVerifierReceipt?.exit_code, 1, 'the actual tool settlement path captures the red receipt')
  assert.equal(host.workingState.lastVerifier?.exitCode, 1, 'the actual tool settlement path records the red verifier result')
  assert.ok(host.workingState.settledFailedVerifier, 'actual process execution is retained as a failed-verifier descriptor')
  assert.equal(host.currentRecoveryBinding()?.workspaceRevision, initial.workspaceRevision,
    'container-generated bytecode must not change the failed candidate identity')
  assert.ok(host.parity.sessionEvents.events.some(event => event.kind === 'verifier_attempt'),
    'the test action must traverse durable verifier event settlement')

  await run({ type:'read_file', path:'solution.py' })
  const gate = host.workingState.recoveryGate!
  assert.ok(gate?.satisfied, 'the fresh source read should satisfy the red-verifier recovery gate')
  const plan = {
    schemaVersion:1 as const, failureSignature:gate.failureSignature, workspaceRevision:gate.binding!.workspaceRevision,
    hypothesisClass:'logic' as const, targetIdentities:['solution.py'], actionFamily:'str_replace' as const,
    criterionId:host.workingState.lastVerifier!.identity,
    supportingObservationIds:gate.observedKeys!.map(recoveryObservationId),
  }
  const repair = await run({ type:'str_replace', file_path:'solution.py', old_str:'    return 0', new_str:'    return 1', repair_plan:plan })
  assert.doesNotMatch(repair.observation, /RECOVERY_CANDIDATE_DRIFT|RECOVERY_EVIDENCE_REQUIRED|RECOVERY_PLAN_REQUIRED/)
  assert.equal(readFileSync(join(root,'solution.py'),'utf8'), source.replace('    return -1','    return 1'))
})
