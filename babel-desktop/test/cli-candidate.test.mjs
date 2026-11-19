import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectCliCandidate, verifyCliCandidate } from '../scripts/lib/cli-candidate.mjs'

function candidateFixture(manifest = { name: 'babel-harness', version: '0.2.1' }) {
  const root = mkdtempSync(join(tmpdir(), 'babel-cli-candidate-'))
  mkdirSync(join(root, 'package'))
  writeFileSync(join(root, 'package/package.json'), JSON.stringify(manifest))
  const archive = join(root, `${manifest.name}-${manifest.version}.tgz`)
  const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  return { root, archive }
}

test('the qualified candidate manifest is read from the archive, not the working tree', () => {
  const { root, archive } = candidateFixture()
  try {
    assert.deepEqual(inspectCliCandidate({ archive }), { name: 'babel-harness', version: '0.2.1' })
    const verified = verifyCliCandidate({ archive, expectedName: 'babel-harness', expectedVersion: '0.2.1' })
    assert.equal(verified.filename, 'babel-harness-0.2.1.tgz')
    assert.equal(verified.sha256.length, 64)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a mismatched or missing candidate fails before packaging', () => {
  const { root, archive } = candidateFixture()
  try {
    assert.throws(() => verifyCliCandidate({ archive, expectedName: 'babel-harness', expectedVersion: '0.2.2' }), /version does not match/)
    assert.throws(() => verifyCliCandidate({ archive, expectedName: 'other', expectedVersion: '0.2.1' }), /name does not match/)
    assert.throws(() => verifyCliCandidate({ archive: join(root, 'missing.tgz'), expectedName: 'babel-harness', expectedVersion: '0.2.1' }), /missing/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
