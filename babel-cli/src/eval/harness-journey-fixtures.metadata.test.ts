import assert from 'node:assert/strict'
import test from 'node:test'
import { diffFixtureMetadataEntries } from './harness-journey-fixtures.js'

test('diffFixtureMetadataEntries reports only same-fixture path deltas', () => {
  const before: [string, string][] = [['config', 'aa'], ['index', 'bb'], ['refs/heads/main', 'cc']]
  const after: [string, string][] = [['config', 'aa'], ['index', 'bb2'], ['refs/heads/main', 'cc'], ['objects/ab/cd', 'dd']]
  const delta = diffFixtureMetadataEntries(before, after)
  assert.deepEqual(delta.map(entry => entry.path), ['index', 'objects/ab/cd'])
  assert.equal(delta.find(entry => entry.path === 'index')?.before, 'bb')
  assert.equal(delta.find(entry => entry.path === 'index')?.after, 'bb2')
})
