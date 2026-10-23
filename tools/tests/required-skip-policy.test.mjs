// License: Apache-2.0 — see LICENSE
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewedSkip, skipPolicySha256 } from '../../babel-cli/scripts/required_skip_policy.mjs'

const windows = { path: 'src/ui/terminalProbe.test.ts', name: 'Windows Terminal defaults dec2026Sync to false', reason: 'Windows-specific fixture' }
test('native directory sharing exclusions bind only the two Windows contracts off Windows', () => {
  for (const name of [
    'Windows directory anchors prevent leaf and ancestor rename until released',
    'Windows directory anchors refuse an already open DELETE handle',
  ]) {
    const record = { path: 'src/executor/effectDirectoryAnchors.test.ts', name, reason: 'Windows native directory sharing requires Windows' }
    for (const platform of ['linux', 'darwin']) {
      assert.ok(reviewedSkip(record, platform, 'unit', true))
      assert.equal(reviewedSkip(record, platform, 'chat-truth', true), null)
      for (const override of [{ path: 'src/other.test.ts' }, { name: 'new title' }, { reason: 'optional' }]) {
        assert.equal(reviewedSkip({ ...record, ...override }, platform, 'unit', true), null)
      }
    }
    assert.equal(reviewedSkip(record, 'win32', 'unit', true), null)
  }
})

test('skip policy binds exact source, name, reason, platform and suite', () => {
  assert.ok(reviewedSkip(windows, 'linux', 'unit', true))
  assert.match(skipPolicySha256, /^[a-f0-9]{64}$/)
  assert.equal(reviewedSkip(windows, 'win32', 'unit', true), null)
  assert.equal(reviewedSkip(windows, 'linux', 'native-rg', true), null)
  for (const override of [{path: 'src/other.test.ts'}, {name: 'new title'}, {reason: 'optional'}]) {
    assert.equal(reviewedSkip({...windows, ...override}, 'linux', 'unit', true), null)
  }
})

test('physical-state symlink skips are reviewed only on Windows unit lanes', () => {
  const reason = 'POSIX symlink physical-state binding; Windows reparse points are outside this contract'
  const names = [
    'leaf symlink targets are metadata bound without reading their outside content',
    'hidden tracked paths through a symlink parent refuse binding before input reads',
    'a parent swapped during file opening cannot read outside bytes',
    'a leaf symlink named node_modules binds its target string without reading dependency content',
  ]
  for (const name of names) {
    const record = { path: 'src/evidence/repositoryPhysicalState.test.ts', name, reason }
    assert.ok(reviewedSkip(record, 'win32', 'unit', true))
    assert.equal(reviewedSkip(record, 'linux', 'unit', true), null)
    assert.equal(reviewedSkip(record, 'win32', 'native-rg', true), null)
  }
})

test('required native rg cannot use the optional unit-lane exclusion', () => {
  const record = { path: 'src/tools/ripgrep.test.ts', name: 'ripgrep basic match — finds known text in source files', reason: 'Standalone rg unavailable' }
  assert.ok(reviewedSkip(record, 'win32', 'unit', true))
  assert.equal(reviewedSkip(record, 'win32', 'native-rg', true), null)
})

test('compensation mode exclusion binds only the POSIX permission test on Windows', () => {
  const record = { path: 'src/agent/patchCompensation.test.ts', name: 'exclusive restoration preserves POSIX mode despite a restrictive umask', reason: 'POSIX mode/umask semantics are not available on Windows' }
  assert.ok(reviewedSkip(record, 'win32', 'unit', true))
  for (const platform of ['linux', 'darwin']) assert.equal(reviewedSkip(record, platform, 'unit', true), null)
  assert.equal(reviewedSkip(record, 'win32', 'chat-truth', true), null)
  assert.equal(reviewedSkip({ ...record, name: 'optional run directory keeps retained compensation outside the project and preserves open writers' }, 'win32', 'unit', true), null)
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
