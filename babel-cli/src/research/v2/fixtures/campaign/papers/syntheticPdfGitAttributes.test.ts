import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import mutableManifest from './mutable-locator-synthetic.manifest.json' with { type: 'json' }
import largeManifest from './production-cli-large-synthetic.manifest.json' with { type: 'json' }

const papersDir = dirname(fileURLToPath(import.meta.url))

function assertPinnedBytes(artifactPath: string, expectedLength: number, expectedSha256: string) {
  const bytes = readFileSync(join(papersDir, artifactPath))
  assert.equal(bytes.length, expectedLength)
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.equal(digest, expectedSha256.toLowerCase())
}

describe('repository-owned synthetic PDF byte pins', () => {
  it('mutable-locator-synthetic.pdf matches manifest digest (autocrlf-safe -text)', () => {
    assertPinnedBytes(
      mutableManifest.artifact_path,
      mutableManifest.byte_length,
      mutableManifest.content_sha256,
    )
  })

  it('production-cli-large-synthetic.pdf matches manifest digest', () => {
    assertPinnedBytes(
      largeManifest.artifact_path,
      largeManifest.byte_length,
      largeManifest.content_sha256,
    )
  })
})
