import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settleChatVerifierResult } from './chatVerifierSettlement.js'

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
