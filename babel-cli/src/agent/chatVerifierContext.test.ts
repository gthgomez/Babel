import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { chatVerifierOwner, chatVerifierRequirements } from './chatVerifierContext.js'

test('requirements bind host owner, exact targeted selectors and current environment independently from receipts', () => {
  const owner = chatVerifierOwner({ projectRoot: tmpdir(), sessionId: 'session', taskId: 'task', contractHash: 'contract' })!
  assert.equal(owner.workspaceRoot, realpathSync.native(tmpdir()))
  const [record] = chatVerifierRequirements(owner, ['node --test "test/Alpha  beta.test.js"'], 'Fix the parser and run its targeted tests')
  assert.equal(record!.executionContext.taskId, 'task')
  assert.equal(record!.requiredScope, 'targeted')
  assert.ok(record!.executionContext.targetSelectors.includes('test/Alpha  beta.test.js'))
  assert.equal(chatVerifierRequirements(owner, ['node --test test/a.js'], 'Run the full suite')[0]!.requiredScope, 'full_suite')
  assert.deepEqual(chatVerifierRequirements(undefined, ['npm test'], 'fix'), [])
})

test('a verifier changing source cannot certify its pre-dispatch candidate', async () => {
  const { mkdtempSync,writeFileSync,rmSync }=await import('node:fs')
  const { join }=await import('node:path')
  const { freezeChatVerifierCandidate,chatVerifierCandidateCurrent }=await import('./chatVerifierContext.js')
  const root=mkdtempSync(join(tmpdir(),'babel-verifier-candidate-'))
  try {
    writeFileSync(join(root,'package.json'),'{"scripts":{"test":"node --test"}}\n')
    writeFileSync(join(root,'source.js'),'export const value=1;\n')
    const candidate=freezeChatVerifierCandidate(root);assert.ok(candidate)
    assert.equal(chatVerifierCandidateCurrent(root,candidate),true)
    writeFileSync(join(root,'source.js'),'export const value=2;\n')
    assert.equal(chatVerifierCandidateCurrent(root,candidate),false)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('default engine currency uses live bytes; explicit missing-currency test override remains fail closed', async () => {
  const { ChatEngine }=await import('./chatEngine.js')
  const { captureAndRecordVerifierReceipt }=await import('./chatEngineVerifierAdapter.js')
  const { mkdtempSync,writeFileSync,rmSync }=await import('node:fs');const {join}=await import('node:path')
  const {execFileSync}=await import('node:child_process');const root=mkdtempSync(join(tmpdir(),'babel-engine-currency-'))
  try {
    writeFileSync(join(root,'package.json'),'{"scripts":{"test":"node --test"}}\n');writeFileSync(join(root,'source.js'),'export const value=1;\n')
    for(const args of [['init','-q'],['add','--all'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']])execFileSync('git',args,{cwd:root,windowsHide:true})
    const engine=new ChatEngine({ model: 'deepseek-v4-flash-openrouter',task:'Run npm test before completing.',projectRoot:root,requiredVerifierCommands:['npm test']})
    const host=engine as unknown as {currentVerifierOwner:()=>import('../executor/contracts.js').VerifierEvidenceOwner;parity:import('./chatEngineParityBridge.js').ParityRuntime;executedVerifierLedger:import('../evidence/chatRevisionBinding.js').BoundChatVerifierReceipt[];verifierReceiptCache:Map<string,never>;buildVerifierInput:()=>{currentWorkspaceRevisionHash?:string;currentReceiptRevisionHashes:Record<string,string>}}
    const receipt=await captureAndRecordVerifierReceipt({projectRoot:root,command:'npm test',exitCode:0,summary:'# tests 1\n# skipped 0',mutationPaths:['source.js'],sessionEvents:host.parity.sessionEvents,turnId:'fixture',ledger:host.executedVerifierLedger,cache:host.verifierReceiptCache,writeCount:1,verifierOwner:host.currentVerifierOwner()})
    assert.ok(receipt)
    assert.equal(host.buildVerifierInput().currentWorkspaceRevisionHash,receipt.boundRevision!.compositeTreeHash)
    engine.setTestWorkspaceRevisionHash(null)
    assert.equal(host.buildVerifierInput().currentWorkspaceRevisionHash,undefined)
    assert.deepEqual(host.buildVerifierInput().currentReceiptRevisionHashes,{})
  } finally {rmSync(root,{recursive:true,force:true})}
})
