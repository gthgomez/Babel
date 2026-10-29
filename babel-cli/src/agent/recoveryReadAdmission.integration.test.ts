import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ChatEngine } from './chatEngine.js'
import { applyWorkingStateEvent, createWorkingState, type WorkingState, type RecoveryCandidateBinding } from './codingLoop/workingState.js'
import type { ToolContext } from '../localTools.js'
import type { ChatToolAction } from './chatToolDefinitions.js'

function fixture(t: TestContext) {
  const storage = mkdtempSync(join(tmpdir(), 'babel-read-admission-'))
  const root = join(storage, 'project'); mkdirSync(root)
  writeFileSync(join(root, 'source.ts'), 'export const source = 1;\n')
  writeFileSync(join(root, 'large.ts'), Array.from({ length: 300 }, (_, i) => i === 209 ? 'export const bug = 1;' : `// line ${i + 1}`).join('\n') + '\n')
  for (let i = 0; i < 65; i++) writeFileSync(join(root, `discovery${i}.ts`), `export const value = ${i};\n`)
  for (const args of [['init', '-q'], ['add', '--all'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']]) execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true })
  const previous = process.env['BABEL_LIVE']; process.env['BABEL_LIVE'] = 'true'
  t.after(() => { if (previous === undefined) delete process.env['BABEL_LIVE']; else process.env['BABEL_LIVE'] = previous; rmSync(storage, { recursive: true, force: true }) })
  const engine = new ChatEngine({ task: 'Fix implementation. Preserve the regression and package metadata.', projectRoot: root })
  const host = engine as unknown as { workingState: WorkingState; currentRecoveryBinding: () => RecoveryCandidateBinding; activeSubmissionGeneration: number;
    executeOneAction: (action: ChatToolAction, context: object, callbacks: object, meta: object) => Promise<{ observation: string }> }
  let state = applyWorkingStateEvent(createWorkingState('fix'), { type: 'verifier', identity: 'npm test', exitCode: 1, summary: 'red' })
  const initialBinding = host.currentRecoveryBinding(); assert.ok(initialBinding, 'fixture needs a real Git candidate binding')
  state = applyWorkingStateEvent(state, { type: 'recovery_gate', failureSignature: 'red', binding: initialBinding, requiredEvidence: 'inspect', failingTargets: ['regression.test.ts'] })
  host.workingState = state
  let index = 0
  const context:ToolContext={ agentId: 'test', runId: 'test', runDir: join(storage, 'runtime'), babelRoot: root, projectRoot: root }
  const run = (action: ChatToolAction) => host.executeOneAction(action, context, {}, { index: index++, ownerGeneration: 0 })
  return { root, storage, host, run, context }
}

test('a >200-line target is repaired through its delivered range with ordinary governed replacement', async t => {
  const { root, host, run } = fixture(t)
  const observation = await run({ type: 'read_range', file_path: 'large.ts', start_line: 201, end_line: 220 })
  const gate = host.workingState.recoveryGate!
  const record = gate.readRecords![0]!; assert.ok(record, observation.observation)
  assert.deepEqual(record.window, { startLine: 201, endLine: 220, totalLines: 300, completeFile: false, byteTruncated: false })
  assert.ok(observation.observation.includes(record.id))
  const repair_plan = { schemaVersion: 2 as const, recoveryGateRef: gate.recoveryGateRef!, workspaceRevision: gate.binding!.workspaceRevision,
    // This mirrors the live model's normalized echo. It is diagnostic payload,
    // not the host's source of truth for the active failure.
    failureSignature: gate.failureSignature.replaceAll('\n', ' ').replaceAll('"', "'"),
    hypothesisClass: 'logic' as const, targetIdentities: ['large.ts'], actionFamily: 'str_replace' as const, criterionId: 'npm test', supportingObservationIds: [record.id] }
  await run({ type: 'str_replace', file_path: 'large.ts', old_str: 'export const bug = 1;', new_str: 'export const bug = 2;', repair_plan })
  assert.match(readFileSync(join(root, 'large.ts'), 'utf8'), /export const bug = 2;/)
  assert.equal(host.workingState.recoveryGate?.permitConsumed, true)
  assert.equal(host.workingState.recoveryGate?.readRecords?.length, 0, 'a mutation invalidates old read handles')
})

test('an evicted full read is physically delivered again without renewing progress or permits', async t => {
  const { host, run } = fixture(t)
  await run({ type: 'read_file', path: 'source.ts' })
  const first = host.workingState.recoveryGate!.readRecords![0]!
  for (let i = 0; i < 65; i++) await run({ type: 'read_file', path: `discovery${i}.ts` })
  assert.equal(host.workingState.recoveryGate?.readRecords?.length, 64)
  assert.ok(!host.workingState.recoveryGate?.readRecords?.some(record => record.id === first.id))
  const consumed = [...host.workingState.consumedRecoveryEvidence]
  const reread = await run({ type: 'read_file', path: 'source.ts' })
  assert.ok(reread.observation.includes(first.id))
  assert.match(reread.observation, /export const source/)
  assert.deepEqual(host.workingState.consumedRecoveryEvidence, consumed)
})

test('credential and outside-link denials retain no read authority', async t => {
  const { root, storage, host, run } = fixture(t)
  writeFileSync(join(root, '.env'), 'FIXTURE_ONLY=public-placeholder\n')
  const denied = await run({ type: 'read_file', path: '.env' })
  assert.match(denied.observation, /DENY|denied|credential/i)
  assert.equal(host.workingState.recoveryGate?.readRecords?.length, 0)
  const outside = join(storage, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'public.ts'), 'public fixture')
  symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const escaped = await run({ type: 'read_range', file_path: 'escape/public.ts', start_line: 1, end_line: 1 })
  assert.match(escaped.observation, /DENY|denied|outside|escape/i)
  assert.equal(host.workingState.recoveryGate?.readRecords?.length, 0)
  unlinkSync(join(root, 'escape'))
})

test('a read settling after ownership changes cannot publish a record', async t => {
  const { host, run } = fixture(t)
  const pending = run({ type: 'read_range', file_path: 'source.ts', start_line: 1, end_line: 1 })
  host.activeSubmissionGeneration += 1
  await pending
  assert.equal(host.workingState.recoveryGate?.readRecords?.length, 0)
})

test('an absent target appearing after admission is not overwritten at dispatch', async t => {
  const { root, host, run } = fixture(t)
  await run({ type: 'read_file', path: 'source.ts' })
  const gate = host.workingState.recoveryGate!
  const record = gate.readRecords![0]!
  const dispatchHost = host as unknown as { recoveredOperationDispatchAuthorization: (action: ChatToolAction) => { allowed: boolean } }
  const original = dispatchHost.recoveredOperationDispatchAuthorization.bind(dispatchHost)
  let checks = 0
  dispatchHost.recoveredOperationDispatchAuthorization = action => {
    if (++checks === 2) writeFileSync(join(root, 'created.ts'), 'concurrent original\n')
    return original(action)
  }
  const result = await run({ type: 'write_file', path: 'created.ts', content: 'replacement\n', repair_plan: {
    schemaVersion: 2, recoveryGateRef: gate.recoveryGateRef!, workspaceRevision: gate.binding!.workspaceRevision,
    hypothesisClass: 'logic', targetIdentities: ['created.ts'], actionFamily: 'write_file', criterionId: 'npm test', supportingObservationIds: [record.id],
  } })
  assert.equal(checks, 2, result.observation)
  assert.equal(readFileSync(join(root, 'created.ts'), 'utf8'), 'concurrent original\n')
  assert.match(result.observation, /RECOVERY_CANDIDATE_DRIFT/)
  assert.equal(host.workingState.recoveryGate?.permitConsumed, true)
})

test('a retained read outside the summary is delivered again with its handle and no progress renewal', async t => {
  const { host, run } = fixture(t)
  await run({ type: 'read_file', path: 'source.ts' })
  const first = host.workingState.recoveryGate!.readRecords![0]!
  for (let i = 0; i < 8; i++) await run({ type: 'read_file', path: `discovery${i}.ts` })
  const consumed = [...host.workingState.consumedRecoveryEvidence]
  const reread = await run({ type: 'read_file', path: 'source.ts' })
  assert.ok(reread.observation.includes(first.id))
  assert.match(reread.observation, /export const source/)
  assert.deepEqual(host.workingState.consumedRecoveryEvidence, consumed)
})

const patchExisting=(path:string,old:string,next:string)=>`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${old}\n+${next}\n`
const patchCreate=(path:string,content:string)=>`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${content}\n`
async function twoTargetPlan(host:ReturnType<typeof fixture>['host'],run:ReturnType<typeof fixture>['run'],targets:string[]) {
  await run({type:'read_file',path:'source.ts'})
  if(targets.includes('discovery0.ts'))await run({type:'read_file',path:'discovery0.ts'})
  const gate=host.workingState.recoveryGate!
  return {schemaVersion:2 as const,recoveryGateRef:gate.recoveryGateRef!,workspaceRevision:gate.binding!.workspaceRevision,hypothesisClass:'logic' as const,targetIdentities:targets,actionFamily:'apply_patch' as const,criterionId:'npm test',supportingObservationIds:gate.readRecords!.map(r=>r.id)}
}

test('one recovery plan supports two existing file writes without treating its first write as drift',async t=>{
  const {root,host,run}=fixture(t)
  const repair_plan=await twoTargetPlan(host,run,['source.ts','discovery0.ts'])
  const result=await run({type:'apply_patch',patch:patchExisting('source.ts','export const source = 1;','export const source = 2;')+patchExisting('discovery0.ts','export const value = 0;','export const value = 7;'),repair_plan})
  assert.match(readFileSync(join(root,'source.ts'),'utf8'),/source = 2/,result.observation)
  assert.match(readFileSync(join(root,'discovery0.ts'),'utf8'),/value = 7/,result.observation)
})

test('recovery patch can edit an existing file and create a genuinely absent target',async t=>{
  const {root,host,run}=fixture(t)
  const repair_plan=await twoTargetPlan(host,run,['source.ts','created.ts'])
  const result=await run({type:'apply_patch',patch:patchExisting('source.ts','export const source = 1;','export const source = 2;')+patchCreate('created.ts','export const created = true;'),repair_plan})
  assert.equal(readFileSync(join(root,'created.ts'),'utf8'),'export const created = true;\n',result.observation)
  assert.match(readFileSync(join(root,'source.ts'),'utf8'),/source = 2/)
})

for(const foreign of ['', 'foreign data\n'])test(`an absent later patch target appearing ${foreign?'nonempty':'empty'} causes compensation`,async t=>{
  const {root,host,run}=fixture(t)
  const repair_plan=await twoTargetPlan(host,run,['source.ts','created.ts'])
  const dispatchHost=host as unknown as {recoveredOperationDispatchAuthorization:(action:ChatToolAction)=>{allowed:boolean}}
  const original=dispatchHost.recoveredOperationDispatchAuthorization.bind(dispatchHost);let calls=0
  dispatchHost.recoveredOperationDispatchAuthorization=action=>{if(++calls===3)writeFileSync(join(root,'created.ts'),foreign);return original(action)}
  const result=await run({type:'apply_patch',patch:patchExisting('source.ts','export const source = 1;','export const source = 2;')+patchCreate('created.ts','export const created = true;'),repair_plan})
  assert.match(result.observation,/DRIFT|changed|Rolled back/)
  assert.equal(readFileSync(join(root,'source.ts'),'utf8'),'export const source = 1;\n')
  assert.equal(readFileSync(join(root,'created.ts'),'utf8'),foreign)
})

for(const variant of ['unrelated','later-target','completed-target','denied','cancelled','retired'] as const)test(`multi-file recovery preserves ${variant} boundary before second dispatch`,async t=>{
  const {root,host,run,context}=fixture(t)
  const repair_plan=await twoTargetPlan(host,run,['source.ts','discovery0.ts'])
  const dispatchHost=host as unknown as {recoveredOperationDispatchAuthorization:(action:ChatToolAction)=>{allowed:boolean;message?:string}}
  const original=dispatchHost.recoveredOperationDispatchAuthorization.bind(dispatchHost);let calls=0
  const controller=new AbortController();context.signal=controller.signal
  dispatchHost.recoveredOperationDispatchAuthorization=action=>{
    if(++calls===3){
      if(variant==='unrelated')writeFileSync(join(root,'discovery1.ts'),'foreign unrelated\n')
      if(variant==='later-target')writeFileSync(join(root,'discovery0.ts'),'foreign later\n')
      if(variant==='completed-target')writeFileSync(join(root,'source.ts'),'foreign completed\n')
      if(variant==='denied')return {allowed:false,message:'fixture second-file denial'}
      if(variant==='cancelled')controller.abort()
      if(variant==='retired')host.activeSubmissionGeneration++
    }
    return original(action)
  }
  await run({type:'apply_patch',patch:patchExisting('source.ts','export const source = 1;','export const source = 2;')+patchExisting('discovery0.ts','export const value = 0;','export const value = 7;'),repair_plan})
  assert.equal(readFileSync(join(root,'source.ts'),'utf8'),variant==='completed-target'?'foreign completed\n':'export const source = 1;\n')
  assert.equal(readFileSync(join(root,'discovery0.ts'),'utf8'),variant==='later-target'?'foreign later\n':'export const value = 0;\n')
  if(variant==='unrelated')assert.equal(readFileSync(join(root,'discovery1.ts'),'utf8'),'foreign unrelated\n')
})

for(const fault of ['foreign-bytes','capture-error'] as const)test(`post-dispatch ${fault} is compensated without adopting foreign state`,async t=>{
  const {root,host,run}=fixture(t)
  const repair_plan=await twoTargetPlan(host,run,['source.ts','discovery0.ts'])
  const nativePush=Array.prototype.push;let injected=false;let checking=false;const sourcePath=join(root,'source.ts')
  Array.prototype.push=function(this:unknown[],...items:unknown[]){
    const returned=nativePush.apply(this,items)
    if(!injected&&!checking&&items.length===1&&items[0]===sourcePath){
      checking=true
      try {
        if(readFileSync(sourcePath,'utf8')==='export const source = 2;\n'){
          injected=true
          if(fault==='foreign-bytes')writeFileSync(sourcePath,'foreign after settled write\n')
          else{unlinkSync(sourcePath);mkdirSync(sourcePath)}
        }
      } finally {checking=false}
    }
    return returned
  }
  try {
  const result=await run({type:'apply_patch',patch:patchExisting('source.ts','export const source = 1;','export const source = 2;')+patchExisting('discovery0.ts','export const value = 0;','export const value = 7;'),repair_plan})
  assert.equal(injected,true)
  assert.match(result.observation,/postimage|restored|unknown/i)
  assert.equal(readFileSync(join(root,'discovery0.ts'),'utf8'),'export const value = 0;\n')
  if(fault==='foreign-bytes')assert.equal(readFileSync(join(root,'source.ts'),'utf8'),'foreign after settled write\n')
  else assert.throws(()=>readFileSync(join(root,'source.ts'),'utf8'))
  } finally { Array.prototype.push=nativePush }
})

test('dot-relative multi-file headers retain the same recovery snapshot keys',async t=>{
 const {root,host,run}=fixture(t)
 const repair_plan=await twoTargetPlan(host,run,['source.ts','discovery0.ts'])
 const result=await run({type:'apply_patch',patch:patchExisting('./source.ts','export const source = 1;','export const source = 2;')+patchExisting('./discovery0.ts','export const value = 0;','export const value = 7;'),repair_plan})
 assert.match(readFileSync(join(root,'source.ts'),'utf8'),/source = 2/,result.observation)
 assert.match(readFileSync(join(root,'discovery0.ts'),'utf8'),/value = 7/,result.observation)
})
