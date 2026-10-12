import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  downloadTrustedCandidate,
  stagePromotionCandidate,
  verifyQualifiedCandidate,
} from '../qualified-consumer-promotion.mjs'

function fixtureCandidate(root, {sourceSha, version, bytes = 'qualified-bytes'}) {
  const tarball = `babel-harness-${version}.tgz`
  writeFileSync(join(root, tarball), bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(root, 'SHA256SUMS'), `${sha256}  ${tarball}\n`)
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    sourceSha,
    tarball,
    sha256,
    version,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
  }, null, 2) + '\n')
  return {tarball, sha256}
}

test('verifyQualifiedCandidate rejects wrong source, version, and mutated bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-consumer-'))
  const source = 'a'.repeat(40)
  try {
    fixtureCandidate(root, {sourceSha: source, version: '0.1.1'})
    assert.equal(verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: source, expectedVersion: '0.1.1'}).digest.length, 64)
    assert.throws(() => verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: 'b'.repeat(40), expectedVersion: '0.1.1'}), /sourceSha/)
    assert.throws(() => verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: source, expectedVersion: '0.1.2'}), /version/)
    writeFileSync(join(root, 'babel-harness-0.1.1.tgz'), 'mutated')
    assert.throws(() => verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: source, expectedVersion: '0.1.1'}), /digest/)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test('stagePromotionCandidate copies exact bytes without repacking', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-stage-'))
  const out = mkdtempSync(join(tmpdir(), 'qualified-stage-out-'))
  const source = 'c'.repeat(40)
  try {
    const {tarball, sha256} = fixtureCandidate(root, {sourceSha: source, version: '0.1.1'})
    const staged = stagePromotionCandidate({candidateDir: root, outputDir: out, expectedSourceSha: source, expectedVersion: '0.1.1'})
    assert.equal(staged.digest, sha256)
    assert.equal(createHash('sha256').update(readFileSync(join(out, tarball))).digest('hex'), sha256)
  } finally {
    rmSync(root, {recursive: true, force: true})
    rmSync(out, {recursive: true, force: true})
  }
})

test('downloadTrustedCandidate rejects wrong producer runs and expired artifacts', async () => {
  const source = 'd'.repeat(40)
  const fetchImpl = async url => {
    if (url.includes('/actions/workflows/')) {
      return {ok: true, json: async () => ({workflow_runs: [{id: 9, head_sha: source, conclusion: 'success', event: 'push'}]})}
    }
    if (url.includes('/artifacts?')) {
      return {ok: true, json: async () => ({artifacts: [{name: 'consumer-candidate', id: 3, expired: true}]})}
    }
    throw new Error('unexpected url ' + url)
  }
  await assert.rejects(() => downloadTrustedCandidate({
    repository: 'gthgomez/Babel',
    sourceSha: source,
    token: 'fixture',
    fetchImpl,
  }), /producer run/)
})
