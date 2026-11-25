import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

test('same-version replaced archives are rejected before consumer installation', async () => {
  const { verifyConsumerArchive } = await import('../../babel-cli/scripts/consumer_archive.mjs')
  const root = mkdtempSync(join(tmpdir(), 'babel-archive-'))
  const archive = join(root, 'babel-1.2.3.tgz')
  const source = 'a'.repeat(40)
  try {
    writeFileSync(archive, 'immutable fixture bytes')
    const digest = createHash('sha256').update('immutable fixture bytes').digest('hex')
    const manifest = {tarball: 'babel-1.2.3.tgz', sha256: digest, sourceSha: source, version: '1.2.3'}
    assert.equal(verifyConsumerArchive({archive, manifest, expectedDigest: digest, expectedSource: source, expectedVersion: '1.2.3'}).sha256, digest)
    writeFileSync(archive, 'replacement of same version')
    assert.throws(() => verifyConsumerArchive({archive, manifest, expectedDigest: digest, expectedSource: source, expectedVersion: '1.2.3'}), /digest/)
    manifest.sha256 = createHash('sha256').update('replacement of same version').digest('hex')
    assert.throws(() => verifyConsumerArchive({archive, manifest, expectedDigest: digest, expectedSource: source, expectedVersion: '1.2.3'}), /digest/)
    assert.throws(() => verifyConsumerArchive({archive, manifest, expectedDigest: manifest.sha256, expectedSource: 'b'.repeat(40), expectedVersion: '1.2.3'}), /source/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})

test('consumer inventory preserves required assets and rejects development or private files', async () => {
  const { verifyConsumerContents } = await import('../../babel-cli/scripts/consumer_archive.mjs')
  const files = ['package.json', 'README.md', 'LICENSE', 'bin/babel.js', 'bin/check-node-engine.mjs', 'resources/prompt_catalog.yaml',
    'dist/voice/audio-capture-worker.mjs', 'dist/voice/vad-worker.mjs',
    'dist/bridge/claude-agent-sdk-pin.json', 'dist/bridge/claudeCodeIsolatedResolveWorker.mjs',
    'dist/cli/build-info.json',
    // Runtime JSON asset read by dist/tools/toolManifest.js.
    'dist/tools/tool-manifest.json'].map(path => ({path}))
  verifyConsumerContents(files)
  for (const path of ['resources/.env.local', 'dist/example.test.js', 'dist/source.ts', 'resources/../outside', 'resources/logs/private.log',
    // The allowlist admits the one required manifest, not arbitrary dist JSON.
    'dist/tools/other-config.json', 'dist/cli/other-config.json', 'dist/services/playbooks/../../private.json']) {
    assert.throws(() => verifyConsumerContents([...files, {path}]), undefined, path)
  }
  for (const required of ['resources/prompt_catalog.yaml', 'LICENSE', 'dist/voice/audio-capture-worker.mjs', 'dist/voice/vad-worker.mjs', 'dist/cli/build-info.json']) {
    assert.throws(() => verifyConsumerContents(files.filter(file => file.path !== required)), undefined, required)
  }
})

test('installed build identity must bind actual bytes, source, compiler and lockfile to the verified archive receipt', async () => {
  const { verifyInstalledBuildIdentity } = await import('../../babel-cli/scripts/consumer_archive.mjs')
  const recordedBuildInputs = {
    scope: 'cli-manifest-lock-config-and-tsc-files:v1',
    sha256: 'c'.repeat(64),
    packageLockSha256: 'd'.repeat(64),
  }
  const info = {
    schemaVersion: 1, packageVersion: '1.2.3', sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40), workingTreeClean: true, nodeVersion: '24.13.1',
    typescriptVersion: '5.8.3', buildInputsDigest: null,
    buildInputsReason: 'complete build inputs were not recorded', recordedBuildInputs,
  }
  const bytes = Buffer.from(JSON.stringify(info))
  const receipt = {
    version: info.packageVersion, sourceSha: info.sourceCommit, sourceTreeSha: info.sourceTree, node: 'v24.13.1',
    compilerVersion: '5.8.3', buildInfoSha256: createHash('sha256').update(bytes).digest('hex'), recordedBuildInputs,
    dependencies: { lockSha256: recordedBuildInputs.packageLockSha256 },
  }
  assert.deepEqual(verifyInstalledBuildIdentity(bytes, receipt), info)
  assert.throws(() => verifyInstalledBuildIdentity(Buffer.concat([bytes, Buffer.from('\n')]), receipt), /digest mismatch/)
  assert.throws(() => verifyInstalledBuildIdentity(bytes, { ...receipt, sourceTreeSha: 'f'.repeat(40) }), /tree does not match/)
  assert.throws(() => verifyInstalledBuildIdentity(bytes, { ...receipt, compilerVersion: '4.1.0' }), /compiler version mismatch/)
  assert.throws(() => verifyInstalledBuildIdentity(bytes, { ...receipt, dependencies: { lockSha256: 'e'.repeat(64) } }), /dependency lock mismatch/)
})

test('installed payload permits only the exact npm executable shebang transform', async () => {
  const { npmNormalizedShebangDigest, verifyArchivePayload, verifyInstalledPayloadFiles } = await import('../../babel-cli/scripts/consumer_archive.mjs')
  const scratch = mkdtempSync(join(tmpdir(), 'babel-installed-payload-'))
  const root = join(scratch, 'package')
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const bin = 'bin/babel.js'
  const archivedBin = Buffer.from('#!/usr/bin/env node\r\nconsole.log("fixture")\r\n')
  const normalized = Buffer.from('#!/usr/bin/env node\nconsole.log("fixture")\r\n')
  const files = [bin, 'resources/prompt_catalog.yaml', 'LICENSE', 'dist/voice/audio-capture-worker.mjs',
    'dist/voice/vad-worker.mjs', 'dist/bridge/claude-agent-sdk-pin.json',
    'dist/bridge/claudeCodeIsolatedResolveWorker.mjs', 'dist/cli/build-info.json'].map(path => {
    const bytes = path === bin ? archivedBin : Buffer.from('fixture\n')
    const npmShebangSha256 = npmNormalizedShebangDigest(bytes)
    return { path, bytes, size: bytes.length, sha256: hash(bytes), ...(npmShebangSha256 ? { npmShebangSha256 } : {}) }
  })
  const verify = () => verifyInstalledPayloadFiles({ root, files, binTargets: { babel: bin } })
  try {
    for (const file of files) {
      const path = join(root, file.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.bytes)
    }
    const archive = join(scratch, 'payload.tgz')
    execFileSync('tar', ['-czf', archive, ...files.map(file => 'package/' + file.path)], { cwd: scratch })
    const binTargets = { babel: bin }
    assert.doesNotThrow(() => verifyArchivePayload({ archive, files, binTargets }))
    assert.throws(() => verifyArchivePayload({ archive, files: files.slice(1), binTargets }), /Archive payload paths/)
    const changedReceipt = files.map(file => file.path === bin ? { ...file, sha256: hash('different bytes') } : file)
    assert.throws(() => verifyArchivePayload({ archive, files: changedReceipt, binTargets }), /Archive bytes/)
    const alternateBin = files.map(file => file.path === bin ? { ...file, npmShebangSha256: hash('different bytes') } : file)
    assert.throws(() => verifyArchivePayload({ archive, files: alternateBin, binTargets }), /Archive shebang/)
    assert.deepEqual(verify(), { checkedFiles: files.length, normalizedBins: [] })
    writeFileSync(join(root, bin), normalized)
    assert.deepEqual(verify(), { checkedFiles: files.length, normalizedBins: [bin] })
    assert.equal(npmNormalizedShebangDigest(archivedBin), hash(normalized))
    assert.equal(npmNormalizedShebangDigest(Buffer.from('#!\r\n')), null)
    writeFileSync(join(root, bin), normalized.toString().replace('fixture', 'changed'))
    assert.throws(verify, /Installed bytes differ/)
    writeFileSync(join(root, bin), normalized)
    writeFileSync(join(root, 'extra.js'), 'unexpected')
    assert.throws(verify, /Unexpected installed package file/)
    rmSync(join(root, 'extra.js'))
    files[1].npmShebangSha256 = hash('fixture\n')
    assert.throws(verify, /Only declared bin targets/)
    delete files[1].npmShebangSha256
    rmSync(join(root, files[1].path))
    assert.throws(verify, /Invalid installed package file: resources\/prompt_catalog\.yaml/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
