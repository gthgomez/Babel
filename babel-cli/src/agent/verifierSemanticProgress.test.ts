import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifierSemanticProgress } from './verifierSemanticProgress.js'
import { executedVerifierProgressSignature } from './toolExecutionIdentity.js'

const base = { executionContextKey: 'context', candidateRevision: 'revision', command: 'node --test a.test.js', exitCode: 1,
  stdout: 'TAP version 13\n# Subtest: adds\nnot ok 1 - adds\n  ---\n  duration_ms: 1.234\n  error: AssertionError: wrong sum\n  ...\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 4.21', stderr: '' }

test('identical red timing and formatting changes do not manufacture semantic progress', () => {
  const signature = verifierSemanticProgress(base)
  assert.equal(verifierSemanticProgress({ ...base, stdout: base.stdout.replaceAll('1.234', '999.5').replace('4.21', '12345.6') }), signature)
  for (const altered of [{ executionContextKey: 'different' }, { candidateRevision: 'new' }, { exitCode: 0 }, { stdout: base.stdout.replace('wrong sum', 'wrong product') }, { stdout: base.stdout.replace('# tests 1', '# tests 2').replace('# fail 1', '# fail 2') }]) {
    assert.notEqual(verifierSemanticProgress({ ...base, ...altered }), signature)
  }
  assert.equal(executedVerifierProgressSignature([{ tool_name: 'test_run', target: base.command, verifierExecuted: true, content: base.stdout }]), null)
  assert.equal(executedVerifierProgressSignature([{ tool_name: 'test_run', target: base.command, verifierExecuted: false, verifierSemanticSignature: signature }]), null)
  assert.equal(executedVerifierProgressSignature([{ tool_name: 'test_run', target: base.command, verifierExecuted: true, verifierSemanticSignature: signature }]), signature)
})
