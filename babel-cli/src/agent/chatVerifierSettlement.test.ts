import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { settleChatVerifierResult } from './chatVerifierSettlement.js'
import { createWorkingState } from './codingLoop/workingState.js'

test('started cancellation, timeout, termination and pre-start denial produce no receipt or replay history', async () => {
  const host = new Proxy({}, { get(_target, key) { throw new Error(`unexpected host mutation/read: ${String(key)}`) } }) as never
  for (const result of [
    { process_started: true, process_termination: 'cancelled' as const },
    { process_started: true, process_termination: 'timed_out' as const },
    { process_started: true, process_termination: 'terminated' as const },
    { process_started: false },
  ]) {
    const settled = await settleChatVerifierResult({ host, action:{type:'test_run',command:'npm test'},
      result:{exit_code:1,stdout:'',stderr:'stopped',...result},target:'npm test',tool:'test_run',meta:{index:0},
      ownerGeneration:1,confirmedShellMutation:false,obsParts:[] })
    assert.equal(settled,null)
  }
  const controller = new AbortController(); controller.abort()
  assert.equal(await settleChatVerifierResult({host,action:{type:'test_run',command:'npm test'},
    result:{exit_code:1,stdout:'',stderr:'stopped',process_started:true,process_termination:'exited'},target:'npm test',tool:'test_run',meta:{index:0},ownerGeneration:1,
    confirmedShellMutation:false,obsParts:[],foregroundDispatch:{candidate:null,identity:{cwd:'/repo',envKey:'env'},signal:controller.signal}}),null)
})

test('a non-executing version probe cannot open the failed-verifier recovery gate', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'babel-version-probe-not-red-'))
  let persisted = 0
  const host = {
    options: { projectRoot },
    _streamNativeToolCallIds: [],
    parity: { sessionEvents: { events: [] } },
    isSubmissionCurrent: () => true,
    workingState: { ...createWorkingState('implement solution'), lastMutation: { path: 'solution.py', at: Date.now() } },
    persistRecoveryWorkingState: () => { persisted += 1 },
    lastVerifierFailed: false,
  }
  try {
    await settleChatVerifierResult({ host: host as never, action: { type: 'test_run', command: 'python3 -m pytest --version' },
      result: { exit_code: 1, stdout: '', stderr: 'pytest is not installed', process_started: true, process_termination: 'exited' },
      target: 'python3 -m pytest --version', tool: 'test_run', meta: { index: 0 }, ownerGeneration: 1,
      confirmedShellMutation: false, obsParts: [] })
    assert.equal(host.workingState.lastMutation?.path, 'solution.py')
    assert.equal(host.workingState.recoveryGate, undefined)
    assert.equal(host.lastVerifierFailed, false)
    assert.equal(persisted, 0)
  } finally { rmSync(projectRoot, { recursive: true, force: true }) }
})
