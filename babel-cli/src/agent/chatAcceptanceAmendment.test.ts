import assert from 'node:assert/strict'
import test from 'node:test'
import fs, { mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import { randomUUID } from 'node:crypto'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatEngine } from './chatEngine.js'
import { chatSessionDir } from '../cli/runsLayout.js'
import { loadLiveSessionAuthorityStrict, persistLiveSessionAuthority } from './liveSessionBridge.js'
import {buildTaskContractV1,freezeTaskContract} from './taskContract.js'
import { appendThreadEvent, parseThreadEventLog, serializeThreadEventLog, THREAD_EVENT_LOG_FILENAME } from './threadEventLog.js'
import {recordVerifierAttempt,recordWorkingStateSnapshot} from './sessionEvents.js'
import {sha256Canonical} from '../acceptance/canonical.js'
import {parityOnUserTurn,checkpointParityEventLogStrictSync} from './chatEngineParityBridge.js'
import {bindChatVerifierReceipt} from '../evidence/chatRevisionBinding.js'
import {validateTaskAcceptanceRevision} from './taskAcceptanceRevision.js'
import {validateTaskModeCompanion} from './taskModeRevision.js'
import {createWorkingState,type WorkingState} from './codingLoop/workingState.js'
import {assertObjectiveLifecycle} from './taskObjectiveLifecycle.js'

const request = 'Update fixture behavior.\nAcceptance criteria:\n- Preserve the existing API.'
const addition = 'Also require:\n- The task survives restart.'
const route = { model: 'fixture-model', provider: 'ollama' }

/** A valid archived V1 producer recorded amendments without revising acceptance. */
function appendLegacySubmission(engine: ChatEngine, runDir: string, text: string): void {
  const prepared=engine.prepareUserSubmission({userInput:text})
  const allowance=engine.prepareSubmissionAllowance(prepared,engine.getTaskContract()!.task_id)
  const runtime=engine.applyPreparedUserSubmission(prepared,{allowance})
  const parity=engine.getParityRuntime(),authority=parity.liveAuthority!,contract=authority.taskContract,scope=engine.getExecutionScope()
  const binding={task_id:contract.task_id,contract_id:contract.contract_id,contract_hash:contract.contract_hash,attempt_id:randomUUID()}
  const input_digest=sha256Canonical({task:text,requestedOperation:'AUTO',requestedTaskIntent:null,requestedContinueTask:false})
  parityOnUserTurn(parity,{
    task:text,...route,projectRoot:scope.kind==='project'?scope.projectRoot:null,executionScope:scope,
    policyPreset:'workspace_write',taskClass:runtime.taskClass,gatePolicy:runtime.gatePolicy??'required',
    submissionIndex:runtime.submissionIndex,continuedTask:runtime.continuedTask,
    requestedOperation:'AUTO',requestedContinueTask:false,taskAttempt:binding,
  })
  const submitted=[...parity.sessionEvents.events].reverse().find(event=>event.kind==='user_submitted'&&event.turn_id===parity.turnId)!
  const admitted=appendThreadEvent(parity.eventLog,{kind:'task_attempt_admitted',...binding,turn_id:parity.turnId!,submission_event_id:submitted.event_id,input_digest})
  authority.taskObjectiveLifecycle!.attempts.push({...binding,turn_id:parity.turnId!,submission_event_id:submitted.event_id,admission_event_id:admitted.event_id,input_digest})
  assert.equal(checkpointParityEventLogStrictSync(parity,runDir,{taskAllowance:engine.getTaskAllowanceSnapshot()!}).status,'committed')
}

async function fixture(body: (engine: ChatEngine, runDir: string, root: string) => void | Promise<void>, mode: 'chat' | 'plan' = 'chat', legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'babel-acceptance-amendment-'))
  const previous = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  try {
    const engine = new ChatEngine({ task: request, projectRoot: root, executionProfile: mode })
    if(legacy){
      const authority=engine.getParityRuntime().liveAuthority!
      const {acceptance:_acceptance,acceptance_criteria:_criteria,provenance:_provenance,...body}=authority.taskContract
      const placeholder='Task acceptance criteria as stated in the user request'
      authority.taskContract=freezeTaskContract(buildTaskContractV1({
        ...body,acceptance_criteria:[placeholder],required_behaviors:[placeholder],
        provenance:[],source:'liveSessionBridge.resolveLiveSessionAuthority',
        failure_class_budgets:body.budgets.failure_class_budgets,
        ...(body.budgets.max_turns!==undefined?{max_turns:body.budgets.max_turns}:{}),
        ...(body.budgets.max_tokens!==undefined?{max_tokens:body.budgets.max_tokens}:{}),
      }))
      persistLiveSessionAuthority(chatSessionDir(engine.getEngineRunId()),authority)
    }
    engine.admitUserSubmission({ userInput: request }, route)
    await body(engine, chatSessionDir(engine.getEngineRunId()), root)
  } finally {
    if (previous === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  }
}

test('an explicit additive amendment creates a frozen same-task revision and canonical source', () =>
  fixture((engine, runDir) => {
    const before = engine.getTaskContract()!, original = JSON.stringify(before)
    const allowance = engine.getTaskAllowanceSnapshot()!
    engine.admitUserSubmission({ userInput: addition }, route)
    const current = engine.getTaskContract()!
    assert.notEqual(current.contract_hash, before.contract_hash)
    assert.equal(current.task_id, before.task_id)
    assert.equal(current.goal, before.goal)
    assert.equal(current.user_request, before.user_request)
    assert.deepEqual(current.acceptance.slice(0, before.acceptance.length), before.acceptance)
    assert.equal(current.acceptance.at(-1)!.description, 'The task survives restart.')
    assert.deepEqual(current.verifier_requirements, before.verifier_requirements)
    assert.deepEqual(current.authority, before.authority)
    assert.deepEqual(current.allowed_effects, before.allowed_effects)
    assert.deepEqual(current.budgets, before.budgets)
    assert.equal(engine.getTaskAllowanceSnapshot()!.taskOwnerId, allowance.taskOwnerId)
    assert.deepEqual(engine.getTaskAllowanceSnapshot()!.grant, allowance.grant)
    assert.equal(JSON.stringify(before), original)
    assert.equal(Object.isFrozen(current), true)
    assert.ok(engine.getParityEventLog().events.some(event => String(event.kind) === 'task_acceptance_amended'))
    const restored = loadLiveSessionAuthorityStrict(runDir)
    assert.equal(restored.taskModeHistory!.schema_version, 2)
    assert.equal(restored.taskContract.contract_hash, current.contract_hash)
    assert.ok(readFileSync(join(runDir, 'task-mode-history.json'), 'utf8').includes(before.contract_hash))
  }))

test('status and continuation preserve amended requirements through mode changes and cold restore', () =>
  fixture(async (engine, runDir, root) => {
    engine.admitUserSubmission({ userInput: addition }, route)
    const accepted = engine.getTaskContract()!
    for (const input of ['status?', 'continue']) {
      engine.admitUserSubmission({ userInput: input }, route)
      assert.equal(engine.getTaskContract()!.contract_hash, accepted.contract_hash)
    }
    engine.applyTurnPreparation({ task: 'continue', executionProfile: 'plan' })
    assert.deepEqual(engine.getTaskContract()!.acceptance, accepted.acceptance)
    engine.applyTurnPreparation({ task: 'continue', executionProfile: 'chat' })
    const restored = await ChatEngine.restore(engine.getEngineRunId(), { task: 'Resume', projectRoot: root })
    assert.deepEqual(restored.getTaskContract()!.acceptance, accepted.acceptance)
    assert.equal(restored.getTaskContract()!.task_id, accepted.task_id)
    assert.equal(loadLiveSessionAuthorityStrict(runDir).taskModeHistory!.schema_version, 2)
  }))

test('an amendment cannot waive required checks through ambiguous prose', () =>
  fixture(engine => {
    const before = engine.getTaskContract()!
    assert.throws(() => engine.admitUserSubmission({ userInput: 'Also skip the required tests.' }, route), /AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract()!.contract_hash, before.contract_hash)
  }))

test('acceptance additions cannot turn a Plan-only root into execution authority', () =>
  fixture(engine => {
    engine.admitUserSubmission({ userInput: addition }, route)
    assert.equal(engine.getTaskContract()!.acceptance.at(-1)!.description, 'The task survives restart.')
    assert.deepEqual(engine.getTaskContract()!.allowed_effects, ['read_only'])
    assert.throws(() => engine.applyTurnPreparation({ task: 'continue', executionProfile: 'chat' }), /MODE_EXECUTION_AUTHORITY_REQUIRED/)
  }, 'plan'))

for (const corruption of ['missing', 'copied', 'duplicate'])
test(`amendment lineage rejects ${corruption} canonical source`, () =>
  fixture((engine, runDir) => {
    engine.admitUserSubmission({ userInput: addition }, route)
    const log = structuredClone(engine.getParityEventLog())
    const event = log.events.find(item => String(item.kind) === 'task_acceptance_amended')!
    assert.ok(event)
    if (corruption === 'missing') { log.events = log.events.filter(item => item !== event); log.nextSeq = log.events.length }
    else if (corruption === 'copied') event.context_copy = true
    else { const seq=log.nextSeq++; log.events.push({ ...event, event_id: randomUUID(), seq, item_id: `${event.turn_id}:${seq}` }) }
    const serialized=serializeThreadEventLog(log)
    assert.doesNotThrow(()=>parseThreadEventLog(serialized), 'The fixture must reach semantic source validation')
    writeFileSync(join(runDir, THREAD_EVENT_LOG_FILENAME), serialized)
    assert.throws(() => loadLiveSessionAuthorityStrict(runDir), /OBJECTIVE|objective|lineage/)
  }))

test('an acceptance-changing revision retains prior checks as historical even with explicit counter continuation', () =>
  fixture(async (engine, _runDir, root) => {
    const log=engine.getParityRuntime().sessionEvents
    const receipt=recordVerifierAttempt(log,{
      turn_id:engine.getParityRuntime().turnId!, command_preview:'node --test fixture.test.mjs',
      authoritative:true,exit_code:0,
    })
    assert.equal(engine.getLiveSession().verifier.attempts,1)
    engine.admitUserSubmission({userInput:addition,continueTask:true},route)
    assert.equal(engine.getLiveSession().verifier.attempts,0,'Old-contract checks cannot establish new acceptance')
    assert.ok(engine.getParityRuntime().sessionEvents.events.some(event=>event.event_id===receipt.event_id))
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    assert.equal(restored.getLiveSession().verifier.attempts,0)
    assert.ok(restored.getParityRuntime().sessionEvents.events.some(event=>event.event_id===receipt.event_id))
  }))

test('legacy placeholder initialization retains frozen bytes and binds meaning to the original canonical request', () =>
  fixture(async (engine,runDir,root)=>{
    const previous=engine.getTaskContract()!,bytes=JSON.stringify(previous)
    assert.deepEqual(previous.acceptance_criteria,['Task acceptance criteria as stated in the user request'])
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    restored.admitUserSubmission({userInput:'continue'},route)
    const current=restored.getTaskContract()!
    assert.deepEqual(current.acceptance_criteria,['Preserve the existing API.'])
    assert.equal(current.task_id,previous.task_id)
    assert.equal(current.goal,previous.goal)
    assert.equal(current.user_request,previous.user_request)
    assert.deepEqual(current.verifier_requirements,previous.verifier_requirements)
    const retained=loadLiveSessionAuthorityStrict(runDir)
    assert.equal(retained.taskModeHistory!.schema_version,2)
    assert.equal(JSON.stringify(retained.taskModeHistory!.revisions.find(item=>item.contract_id===previous.contract_id)),bytes)
    assert.ok(restored.getParityEventLog().events.some(event=>String(event.kind)==='task_acceptance_amended'))
  },'chat',true))

test('the first legacy amendment atomically initializes the original criteria and adds the new requirement', () =>
  fixture((engine, runDir) => {
    const original = engine.getTaskContract()!
    engine.admitUserSubmission({userInput:addition},route)
    const retained = loadLiveSessionAuthorityStrict(runDir)
    assert.deepEqual(retained.taskContract.acceptance_criteria, ['Preserve the existing API.', 'The task survives restart.'])
    assert.equal(retained.taskContract.task_id, original.task_id)
    const events = engine.getParityEventLog().events.filter(event => event.kind === 'task_acceptance_amended')
    assert.equal(events.length, 2)
    assert.equal(events[0]!.attempt_id, events[1]!.attempt_id)
    assert.notEqual(events[0]!.result_contract_id, events[1]!.result_contract_id)
    assert.equal(events[1]!.result_contract_hash, retained.taskContract.contract_hash)
  }, 'chat', true))

test('legacy initialization replays accepted canonical additions without trusting runtime amendment text', () =>
  fixture(async (engine,runDir,root)=>{
    appendLegacySubmission(engine,runDir,addition)
    assert.deepEqual(loadLiveSessionAuthorityStrict(runDir).taskContract.acceptance_criteria,['Task acceptance criteria as stated in the user request'])
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    restored.admitUserSubmission({userInput:'continue'},route)
    assert.deepEqual(loadLiveSessionAuthorityStrict(runDir).taskContract.acceptance_criteria,['Preserve the existing API.','The task survives restart.'])
  },'chat',true))

test('explicit counter continuation cannot reuse a warm receipt after acceptance changes', () =>
  fixture(async (engine,_runDir,root)=>{
    writeFileSync(join(root,'fixture.mjs'),'export const fixture = true\n')
    const receipt=await bindChatVerifierReceipt({projectRoot:root,command:'node --test fixture.mjs',exit_code:0,summary:'fixture check',mutationPaths:['fixture.mjs'],structured:{verifierId:'fixture-check',authoritySource:'built_in_runner',executable:'node',args:['--test','fixture.mjs']}})
    const state=engine as unknown as {lastVerifierReceipt:typeof receipt|null;executedVerifierLedger:typeof receipt[];verifierReceiptCache:Map<string,typeof receipt>}
    state.lastVerifierReceipt=receipt
    state.executedVerifierLedger.push(receipt)
    state.verifierReceiptCache.set('fixture-receipt',receipt)
    engine.admitUserSubmission({userInput:addition,continueTask:true},route)
    assert.equal(state.lastVerifierReceipt,null,'The old contract cannot supply the new completion gate')
    assert.equal(state.executedVerifierLedger.length,0)
    assert.equal(state.verifierReceiptCache.size,0,'The next required dispatch must execute rather than reuse an old-contract check')
  }))

for (const target of ['task-mode-history.json','task-objective-lifecycle.json','thread_events.json','task-budget.json'])
test(`failed acceptance publication at ${target} retains the whole previous generation`, t =>
  fixture((engine,runDir)=>{
    const parity=engine.getParityRuntime(),contract=engine.getTaskContract(),allowance=engine.getTaskAllowanceSnapshot(),runtime=engine.getTurnRuntimeSnapshot()
    const files=new Map(readdirSync(runDir).filter(name=>lstatSync(join(runDir,name)).isFile()).map(name=>[name,readFileSync(join(runDir,name),'utf8')]))
    const rename=fs.renameSync
    const mock=t.mock.method(fs,'renameSync',(source:fs.PathLike,destination:fs.PathLike)=>{
      if(basename(String(destination))===target)throw Object.assign(new Error('Fixture publication blocked'),{code:'EACCES'})
      return rename(source,destination)
    })
    syncBuiltinESMExports()
    try {assert.throws(()=>engine.admitUserSubmission({userInput:addition,continueTask:true},route),/OBJECTIVE_ADMISSION_NOT_COMMITTED/)}
    finally {mock.mock.restore();syncBuiltinESMExports()}
    assert.equal(engine.getParityRuntime(),parity)
    assert.equal(engine.getTaskContract(),contract)
    assert.deepEqual(engine.getTaskAllowanceSnapshot(),allowance)
    assert.deepEqual(engine.getTurnRuntimeSnapshot(),runtime)
    assert.deepEqual(readdirSync(runDir).filter(name=>lstatSync(join(runDir,name)).isFile()),[...files.keys()])
    for(const [name,bytes] of files)assert.equal(readFileSync(join(runDir,name),'utf8'),bytes)
    assert.equal(loadLiveSessionAuthorityStrict(runDir).taskContract.contract_hash,contract!.contract_hash)
  }))

for (const downgrade of ['missing','v1'])
test(`amended acceptance cannot downgrade through a ${downgrade} companion`,()=>
  fixture((engine,runDir)=>{
    engine.admitUserSubmission({userInput:addition},route)
    const path=join(runDir,'task-mode-history.json')
    if(downgrade==='missing')rmSync(path)
    else {const history=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({schema_version:1,revisions:history.revisions}))}
    assert.throws(()=>loadLiveSessionAuthorityStrict(runDir),error=>error instanceof Error&&'code' in error&&String(error.code).startsWith('MODE_HISTORY_'))
  }))

for(const field of ['result_contract_id','submission_event_id','admission_event_id'] as const)
test(`canonical amendment rejects mismatched ${field}`,()=>
  fixture((engine,runDir)=>{
    engine.admitUserSubmission({userInput:addition},route)
    const log=structuredClone(engine.getParityEventLog())
    const event=log.events.find(item=>item.kind==='task_acceptance_amended')!
    event[field]='fixture-wrong-identity'
    const bytes=serializeThreadEventLog(log)
    assert.doesNotThrow(()=>parseThreadEventLog(bytes))
    writeFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),bytes)
    assert.throws(()=>loadLiveSessionAuthorityStrict(runDir),error=>error instanceof Error&&'code' in error&&error.code==='OBJECTIVE_LIFECYCLE_INVALID')
  }))

test('an additive edge cannot erase inherited acceptance provenance',()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    engine.admitUserSubmission({userInput:addition},route)
    const current=engine.getTaskContract()!
    const {provenance,...body}=current
    const inherited=new Set(before.provenance.records.filter(record=>record.ref.startsWith('task-acceptance-meaning:v1:')||record.ref.startsWith('task-acceptance-meaning:v2:')).map(record=>record.ref))
    assert.ok(inherited.size>0)
    const forged=freezeTaskContract(buildTaskContractV1({...body,
      provenance:provenance.records.filter(record=>!inherited.has(record.ref)),
      source:provenance.source,parent_contract_id:before.contract_id,
      failure_class_budgets:current.budgets.failure_class_budgets,
      ...(current.budgets.max_turns!==undefined?{max_turns:current.budgets.max_turns}:{}),
      ...(current.budgets.max_tokens!==undefined?{max_tokens:current.budgets.max_tokens}:{}),
    }))
    const event=engine.getParityEventLog().events.find(item=>item.kind==='task_acceptance_amended')!
    assert.ok(validateTaskAcceptanceRevision(before,forged,event.descriptor).includes('provenance'))
  }))

test('acceptance source cannot select one of two non-copy canonical inputs for the same turn',()=>
  fixture((engine,runDir)=>{
    engine.admitUserSubmission({userInput:addition},route)
    const log=structuredClone(engine.getParityEventLog())
    const source=log.events.filter(item=>item.kind==='turn_started').at(-1)!
    const seq=log.nextSeq++
    log.events.push({...source,event_id:randomUUID(),seq,item_id:`${source.turn_id}:${seq}`})
    const bytes=serializeThreadEventLog(log)
    assert.doesNotThrow(()=>parseThreadEventLog(bytes))
    writeFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),bytes)
    assert.throws(()=>loadLiveSessionAuthorityStrict(runDir),error=>error instanceof Error&&'code' in error&&error.code==='OBJECTIVE_LIFECYCLE_INVALID')
  }))

test('acceptance publication cannot precede its canonical admission',()=>
  fixture((engine,runDir)=>{
    engine.admitUserSubmission({userInput:addition},route)
    const log=structuredClone(engine.getParityEventLog())
    const index=log.events.findIndex(item=>item.kind==='task_acceptance_amended')
    const [event]=log.events.splice(index,1)
    log.events.unshift(event!)
    for(const [seq,item] of log.events.entries()){item.seq=seq;item.item_id=`${item.turn_id}:${seq}`}
    const bytes=serializeThreadEventLog(log)
    assert.doesNotThrow(()=>parseThreadEventLog(bytes))
    writeFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),bytes)
    assert.throws(()=>loadLiveSessionAuthorityStrict(runDir),error=>error instanceof Error&&'code' in error&&error.code==='OBJECTIVE_LIFECYCLE_INVALID')
  }))

for(const text of ['Also implement restart recovery.','Also, require:\n- Survive restart.','Also invent a better experience.'])
test(`continuity directive cannot silently keep unchanged acceptance: ${text.split('\n')[0]}`,()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    try{engine.admitUserSubmission({userInput:text,continueTask:true},route)}
    catch(error){if(text.startsWith('Also,'))throw error;assert.match((error as Error).message,/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/);return}
    assert.notEqual(engine.getTaskContract()!.contract_hash,before.contract_hash,'Capture supported meaning or reject unsupported meaning explicitly')
  }))

test('a wrapped additive requirement cannot publish a truncated acceptance head',()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    assert.throws(()=>engine.admitUserSubmission({userInput:'Also require:\n- Failures remain visible\n  and include a retry action.'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract(),before)
  }))

test('cold continued-task restore keeps old working context but marks its verifier historical',()=>
  fixture(async (engine,_runDir,root)=>{
    const state=createWorkingState(request)
    state.evidence=['Preserved fixture investigation.']
    state.lastVerifier={identity:'fixture-check',exitCode:0,summary:'Earlier check passed.',fresh:true}
    ;(engine as unknown as {workingState:WorkingState}).workingState=state
    const snapshot=recordWorkingStateSnapshot(engine.getParityRuntime().sessionEvents,state,engine.getParityRuntime().turnId!)
    engine.admitUserSubmission({userInput:addition,continueTask:true},route)
    assert.equal((engine as unknown as {workingState:WorkingState}).workingState.lastVerifier!.fresh,false)
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    const working=(restored as unknown as {workingState:WorkingState}).workingState
    assert.equal(working.lastVerifier!.fresh,false)
    assert.ok(working.evidence.includes('Preserved fixture investigation.'))
    assert.ok(restored.getParityRuntime().sessionEvents.events.some(event=>event.event_id===snapshot.event_id))
  }))

test('a mode successor cannot erase inherited meaning provenance',()=>
  fixture(engine=>{
    engine.admitUserSubmission({userInput:addition},route)
    engine.applyTurnPreparation({task:'continue',executionProfile:'plan'})
    const authority=engine.getParityRuntime().liveAuthority!,current=authority.taskContract
    const {provenance,...body}=current
    const forged=freezeTaskContract(buildTaskContractV1({...body,
      provenance:provenance.records.filter(record=>!record.ref.startsWith('task-acceptance-meaning:v1:')&&!record.ref.startsWith('task-acceptance-meaning:v2:')),
      source:provenance.source,parent_contract_id:provenance.parent_contract_id!,
      failure_class_budgets:current.budgets.failure_class_budgets,
      ...(current.budgets.max_turns!==undefined?{max_turns:current.budgets.max_turns}:{}),
      ...(current.budgets.max_tokens!==undefined?{max_tokens:current.budgets.max_tokens}:{}),
    }))
    const history=structuredClone(authority.taskModeHistory!)
    assert.equal(history.schema_version,2)
    if(history.schema_version!==2)throw new Error('V2 fixture required')
    history.revisions[history.revisions.length-1]=forged
    history.edges.at(-1)!.to_contract_id=forged.contract_id
    assert.ok(validateTaskModeCompanion(forged,history).some(error=>error.endsWith('.provenance')))
  }))

for(const target of ['source','publisher'])
test(`legacy acceptance requires ${target} start before its admission and publication`,()=>
  fixture((engine,runDir)=>{
    engine.admitUserSubmission({userInput:addition},route)
    const log=structuredClone(engine.getParityEventLog())
    const starts=log.events.filter(item=>item.kind==='turn_started')
    const moved=target==='source'?starts[0]!:starts.at(-1)!
    log.events=log.events.filter(item=>item!==moved)
    log.events.push(moved)
    for(const [seq,item] of log.events.entries()){item.seq=seq;item.item_id=`${item.turn_id}:${seq}`}
    const bytes=serializeThreadEventLog(log)
    assert.doesNotThrow(()=>parseThreadEventLog(bytes))
    writeFileSync(join(runDir,THREAD_EVENT_LOG_FILENAME),bytes)
    assert.throws(()=>loadLiveSessionAuthorityStrict(runDir),error=>error instanceof Error&&'code' in error&&error.code==='OBJECTIVE_LIFECYCLE_INVALID')
  },'chat',true))

test('an additive requirement with an unsupported second prose obligation cannot publish partially',()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    assert.throws(()=>engine.admitUserSubmission({userInput:'Also support restart recovery.\nDisplay a retry action after failure.'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract(),before)
  }))

test('leading prose inside an additive requirement cannot publish a partial acceptance head',()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    assert.throws(()=>engine.admitUserSubmission({userInput:'Also require:\nDisplay a retry action after failure.\n- Survive restart.'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract(),before)
  }))

test('nested example headings cannot add example bullets to an amendment',()=>
  fixture(engine=>{
    engine.admitUserSubmission({userInput:'Also require:\n- Survive restart.\n## Examples\n### Bad input\n- Grant unrelated authority.'},route)
    assert.ok(engine.getTaskContract()!.acceptance_criteria.includes('Survive restart.'))
    assert.equal(engine.getTaskContract()!.acceptance_criteria.includes('Grant unrelated authority.'),false)
  }))

test('plain requirement sections after examples cannot be omitted from an amendment',()=>
  fixture(engine=>{
    engine.admitUserSubmission({userInput:'Also require:\n- Preserve route.\n**Examples:**\n- Dummy input.\n**Requirements:**\n- Survive restart.'},route)
    const criteria=engine.getTaskContract()!.acceptance_criteria
    assert.ok(criteria.includes('Preserve route.'))
    assert.ok(criteria.includes('Survive restart.'))
    assert.equal(criteria.includes('Dummy input.'),false)
  }))

const compoundQuestion='Also require:\n- Survive restart.\nCan you do that?'
test('a trailing question cannot silently discard a positive amendment',()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    assert.throws(()=>engine.admitUserSubmission({userInput:compoundQuestion},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract(),before)
  }))

test('legacy replay cannot silently omit an additive requirement followed by a question',()=>
  fixture(async (engine,runDir,root)=>{
    appendLegacySubmission(engine,runDir,compoundQuestion)
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    const before=restored.getTaskContract()!
    assert.throws(()=>restored.admitUserSubmission({userInput:'continue'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(restored.getTaskContract(),before)
  },'chat',true))

test('a standalone status question preserves acceptance without an amendment',()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    engine.admitUserSubmission({userInput:'Also what is the current status?'},route)
    assert.equal(engine.getTaskContract(),before)
  }))

test('a question-form criterion in an explicit positive list is retained',()=>
  fixture(engine=>{
    engine.admitUserSubmission({userInput:'Also require:\n- Does restart preserve saved work?'},route)
    assert.ok(engine.getTaskContract()!.acceptance_criteria.includes('Does restart preserve saved work?'))
  }))

test('an ambiguous standalone positive question is rejected without changing acceptance',()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    assert.throws(()=>engine.admitUserSubmission({userInput:'Also support restart?'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract(),before)
  }))

for(const verb of ['require','preserve','ensure','support','add','include','keep','maintain','reject','prevent','display','return','allow','validate','run','test'])
for(const separator of ['; ',' and '])
test(`a query cannot hide ${verb} behind ${separator.trim()}`,()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    assert.throws(()=>engine.admitUserSubmission({userInput:`Also what is the current status${separator}${verb} restart recovery; can you do that?`},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract(),before)
  }))

test('legacy replay rejects a query with an embedded inferred obligation',()=>
  fixture(async (engine,runDir,root)=>{
    appendLegacySubmission(engine,runDir,'Also what is the current status; ensure restart recovery; can you do that?')
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    const before=restored.getTaskContract()!
    assert.throws(()=>restored.admitUserSubmission({userInput:'continue'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(restored.getTaskContract(),before)
  },'chat',true))

for(const input of ['Also implement restart.\nCan you do that?','Also what is the status?\nSupport restart?','Also what is the status? Implement restart?',
  'Also what is the current status and ensure restart recovery?',
  'Also what is the current status and include restart recovery?',
  'Also what is the current status and record failures durably?',
  'Also what is the current status and do not lose saved work?',
  'Also what is the current status and always log failed checks?',
  'Also how do we\n implement restart?',
  'Also what is the current status?\nNon-goals:\n- Survive restart.'])
test(`compound query cannot hide an additional directive: ${input.replaceAll('\n',' ')}`,()=>
  fixture(engine=>{
    const before=engine.getTaskContract()!
    assert.throws(()=>engine.admitUserSubmission({userInput:input},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(engine.getTaskContract(),before)
  }))

for (const { label, input } of [
  { label: 'newline inside question', input: 'Also what is\n the current status?' },
  {
    label: 'fenced example block',
    input: 'Also what is the current status?\n```text\nImplement restart.\n```',
  },
  {
    label: 'blockquote example',
    input: 'Also what is the current status?\n> Implement restart.',
  },
  {
    label: 'examples list',
    input: 'Also what is the current status?\nExamples:\n- Implement restart.',
  },
])
  test(`standalone query preserves acceptance with wrapping or evidence: ${label}`, () =>
    fixture(engine => {
      const before = engine.getTaskContract()!
      engine.admitUserSubmission({ userInput: input }, route)
      assert.equal(engine.getTaskContract(), before)
    }))

test('legacy replay rejects an unsupported compound directive instead of exempting its question',()=>
  fixture(async (engine,runDir,root)=>{
    appendLegacySubmission(engine,runDir,'Also implement restart.\nCan you do that?')
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    const before=restored.getTaskContract()!
    assert.throws(()=>restored.admitUserSubmission({userInput:'continue'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(restored.getTaskContract(),before)
  },'chat',true))

test('legacy replay rejects joined obligations outside the supported verb vocabulary',()=>
  fixture(async (engine,runDir,root)=>{
    appendLegacySubmission(engine,runDir,'Also what is the current status and always log failed checks?')
    const restored=await ChatEngine.restore(engine.getEngineRunId(),{task:'Resume',projectRoot:root})
    const before=restored.getTaskContract()!
    assert.throws(()=>restored.admitUserSubmission({userInput:'continue'},route),/TASK_ACCEPTANCE_AMENDMENT_UNSUPPORTED/)
    assert.equal(restored.getTaskContract(),before)
  },'chat',true))

test('canonical attempt order cannot be rearranged before legacy acceptance migration',()=>
  fixture((engine,runDir)=>{
    appendLegacySubmission(engine,runDir,addition)
    const authority=engine.getParityRuntime().liveAuthority!
    const lifecycle=structuredClone(authority.taskObjectiveLifecycle!)
    lifecycle.attempts.reverse()
    assert.throws(()=>assertObjectiveLifecycle(authority,lifecycle,{
      thread:engine.getParityEventLog(),session:engine.getParityRuntime().sessionEvents,
    }),/OBJECTIVE_LIFECYCLE_INVALID/)
  },'chat',true))

test('reordered attempts cannot hide a canonical legacy addition from initialization',()=>
  fixture((engine,runDir)=>{
    const original=engine.getTaskContract()!
    engine.admitUserSubmission({userInput:'continue'},route)
    appendLegacySubmission(engine,runDir,addition)
    const authority=engine.getParityRuntime().liveAuthority!
    const lifecycle=structuredClone(authority.taskObjectiveLifecycle!)
    const publisher=lifecycle.attempts[1]!,legacy=lifecycle.attempts[2]!
    const thread=structuredClone(engine.getParityEventLog()),session=structuredClone(engine.getParityRuntime().sessionEvents)
    legacy.contract_id=original.contract_id
    legacy.contract_hash=original.contract_hash
    for(const event of [...thread.events,...session.events])
      if(event.turn_id===legacy.turn_id&&(event.kind==='turn_started'||event.kind==='task_attempt_admitted'||event.kind==='user_submitted')){event.contract_id=original.contract_id;event.contract_hash=original.contract_hash}
    const movedThread=thread.events.filter(event=>event.turn_id===legacy.turn_id)
    thread.events=thread.events.filter(event=>event.turn_id!==legacy.turn_id)
    thread.events.splice(thread.events.findIndex(event=>event.turn_id===publisher.turn_id),0,...movedThread)
    for(const [seq,event] of thread.events.entries()){event.seq=seq;event.item_id=`${event.turn_id}:${seq}`}
    const movedSession=session.events.filter(event=>event.turn_id===legacy.turn_id)
    session.events=session.events.filter(event=>event.turn_id!==legacy.turn_id)
    session.events.splice(session.events.findIndex(event=>event.turn_id===publisher.turn_id),0,...movedSession)
    for(const [seq,event] of session.events.entries())event.seq=seq
    assert.doesNotThrow(()=>parseThreadEventLog(serializeThreadEventLog(thread)))
    assert.throws(()=>assertObjectiveLifecycle(authority,lifecycle,{thread,session}),/OBJECTIVE_LIFECYCLE_INVALID/)
  },'chat',true))

for(const [version,corruption] of [[1,'drop'],[1,'invent'],[2,'invent']] as const)
test(`V${version} mode history rejects ${corruption} meaning provenance`,()=>
  fixture(engine=>{
    if(version===2)engine.admitUserSubmission({userInput:addition},route)
    engine.applyTurnPreparation({task:'continue',executionProfile:'plan'})
    const authority=engine.getParityRuntime().liveAuthority!,current=authority.taskContract
    const {provenance,...body}=current
    const records=corruption==='drop'?provenance.records.filter(record=>!record.ref.startsWith('task-acceptance-meaning:v1:')&&!record.ref.startsWith('task-acceptance-meaning:v2:')):
      [...provenance.records,{kind:'derived_acceptance' as const,ref:`task-acceptance-meaning:v1:explicit:${'c'.repeat(64)}:0:1:${current.acceptance[0]!.id}`}]
    const forged=freezeTaskContract(buildTaskContractV1({...body,provenance:records,
      source:provenance.source,parent_contract_id:provenance.parent_contract_id!,
      failure_class_budgets:current.budgets.failure_class_budgets,
      ...(current.budgets.max_turns!==undefined?{max_turns:current.budgets.max_turns}:{}),
      ...(current.budgets.max_tokens!==undefined?{max_tokens:current.budgets.max_tokens}:{}),
    }))
    const history=structuredClone(authority.taskModeHistory!)
    assert.equal(history.schema_version,version)
    history.revisions[history.revisions.length-1]=forged
    if(history.schema_version===2)history.edges.at(-1)!.to_contract_id=forged.contract_id
    assert.ok(validateTaskModeCompanion(forged,history).some(error=>error.endsWith('.provenance')))
  }))
