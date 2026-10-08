// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** Bind transferred candidate bytes to the separately expected digest, source and version before installation. */
export function verifyConsumerArchive({ archive, manifest, expectedDigest, expectedSource, expectedVersion }) {
  assert.match(expectedDigest, /^[a-f0-9]{64}$/, 'Expected archive digest required')
  assert.match(expectedSource, /^[a-f0-9]{40}$/, 'Expected source SHA required')
  assert.equal(manifest.tarball, basename(archive), 'Archive name must match the producer manifest')
  assert.equal(manifest.version, expectedVersion, 'Archive version mismatch')
  assert.equal(manifest.sourceSha, expectedSource, 'Archive source mismatch')
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
  assert.equal(sha256, expectedDigest, 'Archive digest mismatch')
  assert.equal(manifest.sha256, expectedDigest, 'Manifest archive digest mismatch')
  return { ...manifest, sha256 }
}

export function verifyConsumerContents(manifest) {
  const files = manifest.map(file => file.path)
  for (const path of files) {
    assert.match(path, /^(?:package\.json|README\.md|LICENSE|bin\/babel\.js|dist\/.*\.js|dist\/voice\/(?:audio-capture|vad)-worker\.mjs|dist\/services\/playbooks\/.*\.json|resources\/.*)$/)
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env[^/]*|node_modules|runs|cache|logs|testinfra|__snapshots__)(?:\/|$)|\.test\.js$|\.(?:map|ts|sqlite|log|tgz)$/)
    assert.ok(!path.split('/').includes('..') && !path.includes('\\'), 'Unsafe package path')
  }
  for (const required of ['resources/prompt_catalog.yaml', 'LICENSE', 'dist/voice/audio-capture-worker.mjs', 'dist/voice/vad-worker.mjs']) assert.ok(files.includes(required), required)
}
