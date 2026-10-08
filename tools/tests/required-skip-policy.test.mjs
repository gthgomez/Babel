// License: Apache-2.0 — see LICENSE
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewedSkip, skipPolicySha256 } from '../../babel-cli/scripts/required_skip_policy.mjs'

const windows = { path: 'src/ui/terminalProbe.test.ts', name: 'Windows Terminal defaults dec2026Sync to false', reason: 'Windows-specific fixture' }
test('skip policy binds exact source, name, reason, platform and suite', () => {
  assert.ok(reviewedSkip(windows, 'linux', 'unit', true))
  assert.match(skipPolicySha256, /^[a-f0-9]{64}$/)
  assert.equal(reviewedSkip(windows, 'win32', 'unit', true), null)
  assert.equal(reviewedSkip(windows, 'linux', 'native-rg', true), null)
  for (const override of [{path: 'src/other.test.ts'}, {name: 'new title'}, {reason: 'optional'}]) {
    assert.equal(reviewedSkip({...windows, ...override}, 'linux', 'unit', true), null)
  }
})

test('required native rg cannot use the optional unit-lane exclusion', () => {
  const record = { path: 'src/tools/ripgrep.test.ts', name: 'ripgrep basic match — finds known text in source files', reason: 'Standalone rg unavailable' }
  assert.ok(reviewedSkip(record, 'win32', 'unit', true))
  assert.equal(reviewedSkip(record, 'win32', 'native-rg', true), null)
})

test('local missing-tool or base exceptions never apply in hosted qualification', () => {
  for (const record of [
    {path: 'src/services/reviewControlPlaneParity.test.ts', name: 'immutable base preserves a supported V3 contract and rejects wrong-head and BLOCK evidence during migration', reason: 'Immutable trusted base unavailable for local qualification'},
    {path: 'src/services/worktreeSafety.test.ts', name: 'dirty target detection refuses tracked user changes', reason: 'Git unavailable on this local host'},
  ]) {
    assert.ok(reviewedSkip(record, 'win32', 'unit', false))
    assert.equal(reviewedSkip(record, 'win32', 'unit', true), null)
  }
})
