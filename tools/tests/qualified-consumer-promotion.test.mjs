import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  downloadTrustedCandidate,
  extractCommand,
  stagePromotionCandidate,
  verifyManifestBinding,
  verifyQualifiedCandidate,
} from '../qualified-consumer-promotion.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'babel-cli/package.json'), 'utf8'))
const digest = path => createHash('sha256').update(readFileSync(join(repoRoot, path))).digest('hex')
const bin = Object.entries(pkg.bin).map(([alias, target]) => ({ alias, target }))
const packedFiles = [
  { path: 'package.json' }, ...bin.map(entry => ({ path: entry.target })),
  { path: 'LICENSE' }, { path: 'resources/prompt_catalog.yaml' },
  { path: 'dist/index.js' }, { path: 'dist/cliEntryDispatch.js' },
  { path: 'dist/cli/build-info.json' },
  { path: 'bin/check-node-engine.mjs' },
  { path: 'dist/voice/audio-capture-worker.mjs' }, { path: 'dist/voice/vad-worker.mjs' },
  { path: 'dist/bridge/claude-agent-sdk-pin.json' }, { path: 'dist/bridge/opencode-acp-source-pin.json' },
  { path: 'dist/bridge/claudeCodeIsolatedResolveWorker.mjs' },
  { path: 'dist/authority/ownedFileAssertion.windows.ps1' },
  { path: 'dist/services/playbooks/single-file.json' },
  { path: 'dist/tools/tool-manifest.json' },
].map(file => ({ ...file, size: 1 }))
const tree = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' })
const sourceTreeSha = tree.stdout.trim()

function fixtureCandidate(root, {sourceSha, version = pkg.version, bytes = 'qualified-bytes', mutate}) {
  const tarball = `babel-harness-${version}.tgz`
  writeFileSync(join(root, tarball), bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(root, 'SHA256SUMS'), `${sha256}  ${tarball}\n`)
  const manifest = {
    schemaVersion: 2,
    sourceSha,
    sourceTreeSha,
    version,
    tarball,
    sha256,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    manifest: packedFiles,
    inventory: {
      files: packedFiles.length,
      unpackedBytes: packedFiles.length,
      bin,
      requiredAssets: ['LICENSE', 'resources/prompt_catalog.yaml', 'dist/index.js', 'dist/cliEntryDispatch.js', 'dist/cli/build-info.json', 'dist/voice/audio-capture-worker.mjs', 'dist/voice/vad-worker.mjs', 'dist/bridge/claude-agent-sdk-pin.json', 'dist/bridge/claudeCodeIsolatedResolveWorker.mjs', 'dist/authority/ownedFileAssertion.windows.ps1'],
      testOnlyShipped: false,
    },
    advisories: {
      status: 'PASS',
      scope: 'npm',
      lockSha256: digest('babel-cli/package-lock.json'),
      reviewSha256: digest('config/dependency-advisory-review.json'),
    },
    provenance: { recordSha256: digest('babel-cli/source-provenance.json'), dirty: false },
    publisherAuthenticity: { checksumsOnly: true, signed: false },
  }
  if (mutate) mutate(manifest)
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return {tarball, sha256}
}

test('verifyQualifiedCandidate rejects wrong source, version, and mutated bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-consumer-'))
  const source = 'a'.repeat(40)
  try {
    fixtureCandidate(root, {sourceSha: source})
    assert.equal(verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: source, expectedVersion: pkg.version, sourceRoot: repoRoot}).digest.length, 64)
    assert.throws(() => verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: 'b'.repeat(40), expectedVersion: pkg.version, sourceRoot: repoRoot}), /sourceSha/)
    assert.throws(() => verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: source, expectedVersion: '0.1.2', sourceRoot: repoRoot}), /version/)
    writeFileSync(join(root, `babel-harness-${pkg.version}.tgz`), 'mutated')
    assert.throws(() => verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: source, expectedVersion: pkg.version, sourceRoot: repoRoot}), /digest/)
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test('stagePromotionCandidate copies exact bytes without repacking', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-stage-'))
  const out = mkdtempSync(join(tmpdir(), 'qualified-stage-out-'))
  const source = 'c'.repeat(40)
  try {
    const {tarball, sha256} = fixtureCandidate(root, {sourceSha: source})
    const staged = stagePromotionCandidate({candidateDir: root, outputDir: out, expectedSourceSha: source, expectedVersion: pkg.version})
    assert.equal(staged.digest, sha256)
    assert.equal(createHash('sha256').update(readFileSync(join(out, tarball))).digest('hex'), sha256)
  } finally {
    rmSync(root, {recursive: true, force: true})
    rmSync(out, {recursive: true, force: true})
  }
})

test('promotion fails closed on stale advisory, provenance, bin or inventory claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-binding-'))
  const source = 'f'.repeat(40)
  try {
    const cases = [
      ['advisory lock not covered', m => { m.advisories.lockSha256 = '0'.repeat(64) }],
      ['advisory review differs', m => { m.advisories.reviewSha256 = '0'.repeat(64) }],
      ['provenance differs', m => { m.provenance.recordSha256 = '0'.repeat(64) }],
      ['provenance dirty', m => { m.provenance.dirty = true }],
      ['source tree differs', m => { m.sourceTreeSha = 'e'.repeat(40) }],
      ['inventory bytes differ', m => { m.inventory.unpackedBytes += 1 }],
      ['advisory did not pass', m => { m.advisories.status = 'FAIL' }],
      ['bin aliases differ', m => { m.inventory.bin = m.inventory.bin.slice(1) }],
      ['inventory count differs', m => { m.inventory.files += 1 }],
      ['test-only claimed shipped', m => { m.inventory.testOnlyShipped = true }],
      ['authenticity misstated', m => { m.publisherAuthenticity.signed = true }],
      ['bin target hidden', m => { m.manifest = m.manifest.filter(file => !file.path.endsWith('babel.js')) }],
      ['build identity missing', m => { m.manifest = m.manifest.filter(file => file.path !== 'dist/cli/build-info.json') }],
    ]
    for (const [label, mutate] of cases) {
      fixtureCandidate(root, {sourceSha: source, mutate})
      assert.throws(() => verifyManifestBinding({manifest: JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')), sourceRoot: repoRoot}), undefined, label)
    }
  } finally {
    rmSync(root, {recursive: true, force: true})
  }
})

test('promotion requires the frozen source and version instead of skipping checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-required-'))
  const out = mkdtempSync(join(tmpdir(), 'qualified-required-out-'))
  try {
    const { sha256 } = fixtureCandidate(root, {sourceSha: 'a'.repeat(40)})
    assert.throws(() => stagePromotionCandidate({candidateDir: root, outputDir: out}), /requires the frozen source SHA/)
    assert.throws(() => stagePromotionCandidate({candidateDir: root, outputDir: out, expectedSourceSha: 'a'.repeat(40)}), /requires the frozen release version/)
    assert.throws(() => stagePromotionCandidate({candidateDir: root, outputDir: out, expectedSourceSha: 'b'.repeat(40), expectedVersion: pkg.version}), /sourceSha/)
    const staged = stagePromotionCandidate({candidateDir: root, outputDir: out, expectedSourceSha: 'a'.repeat(40), expectedVersion: pkg.version})
    assert.equal(staged.digest, sha256)
  } finally {
    rmSync(root, {recursive: true, force: true})
    rmSync(out, {recursive: true, force: true})
  }
})

test('artifact extraction uses bsdtar on Windows and unzip elsewhere', () => {
  assert.deepEqual(extractCommand({ archive: 'a.zip', outputDir: 'out', platform: 'win32' }), { binary: 'tar.exe', args: ['-xf', 'a.zip', '-C', 'out'] })
  assert.deepEqual(extractCommand({ archive: 'a.zip', outputDir: 'out', platform: 'linux' }), { binary: 'unzip', args: ['-qo', 'a.zip', '-d', 'out'] })
})

test('schema version 1 candidates are rejected instead of promoted unqualified', () => {
  const root = mkdtempSync(join(tmpdir(), 'qualified-schema-'))
  try {
    fixtureCandidate(root, {sourceSha: 'a'.repeat(40), mutate: m => { m.schemaVersion = 1 }})
    assert.throws(() => verifyQualifiedCandidate({candidateDir: root, expectedSourceSha: 'a'.repeat(40), expectedVersion: pkg.version, sourceRoot: repoRoot}), /schema/)
  } finally {
    rmSync(root, {recursive: true, force: true})
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
