import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const files = ['package.json', 'README.md', 'LICENSE', 'bin/babel.js', 'resources/prompt_catalog.yaml',
    'dist/voice/audio-capture-worker.mjs', 'dist/voice/vad-worker.mjs'].map(path => ({path}))
  verifyConsumerContents(files)
  for (const path of ['resources/.env.local', 'dist/example.test.js', 'dist/source.ts', 'resources/../outside', 'resources/logs/private.log']) {
    assert.throws(() => verifyConsumerContents([...files, {path}]), undefined, path)
  }
  for (const required of ['resources/prompt_catalog.yaml', 'LICENSE', 'dist/voice/audio-capture-worker.mjs', 'dist/voice/vad-worker.mjs']) {
    assert.throws(() => verifyConsumerContents(files.filter(file => file.path !== required)), undefined, required)
  }
})
