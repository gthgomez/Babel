// License: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * Read the packaged manifest without trusting the local working tree.
 * @param {{archive: string, tarCommand?: string}} input
 */
export function inspectCliCandidate({ archive, tarCommand = 'tar' }) {
  assert.ok(existsSync(archive), `Qualified CLI candidate is missing: ${basename(archive)}`)
  const read = spawnSync(tarCommand, ['-xOf', archive, 'package/package.json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(read.status, 0, read.stderr || 'Qualified CLI candidate has no package.json')
  return JSON.parse(read.stdout)
}

/**
 * Bind the qualified npm candidate to the Desktop build instead of repacking
 * the CLI, so the GitHub tarball and the npm tarball are the same bytes.
 * @param {{archive: string, expectedName: string, expectedVersion: string, tarCommand?: string}} input
 * @returns {{archive: string, filename: string, version: string, sha256: string}}
 */
export function verifyCliCandidate({ archive, expectedName, expectedVersion, tarCommand = 'tar' }) {
  const manifest = inspectCliCandidate({ archive, tarCommand })
  assert.equal(manifest.name, expectedName, 'Qualified CLI candidate package name does not match the source package')
  assert.equal(manifest.version, expectedVersion, 'Qualified CLI candidate version does not match the source package')
  const bytes = readFileSync(archive)
  return { archive, filename: basename(archive), version: manifest.version, sha256: createHash('sha256').update(bytes).digest('hex') }
}
