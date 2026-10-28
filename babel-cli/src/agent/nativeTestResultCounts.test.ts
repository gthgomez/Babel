import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeNodeResultCounts } from './nativeTestResultCounts.js'

const footer = '# tests 2\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'
test('native Node counts require a complete consistent runner footer and command family', () => {
  assert.deepEqual(nativeNodeResultCounts('node --test proof.cjs', footer), { tests_total: 2, tests_skipped: 1, tests_passed: 1, tests_failed: 0 })
  for (const text of ['1 test passed', footer + '# tests 2\n# pass 2\n', footer.replace('# fail 0\n', ''), footer.replace('# pass 1', '# pass 2'), footer.replace('# pass 1', '# pass 9007199254740992')])
    assert.equal(nativeNodeResultCounts('node --test proof.cjs', text), null)
  assert.equal(nativeNodeResultCounts('echo ok', footer), null)
  assert.equal(nativeNodeResultCounts('pytest', footer), null)
  assert.equal(nativeNodeResultCounts('node --test proof.cjs', footer.replaceAll('#', 'ℹ'))?.tests_passed, 1)
})
