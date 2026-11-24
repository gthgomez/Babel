// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { assertReleaseBuildInfo } from './write_build_info.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = /^[a-f0-9]{64}$/

/** npm bin-links can normalize the first CRLF of an executable shebang. */
export function npmNormalizedShebangDigest(bytes) {
  const newline = bytes.indexOf(0x0a)
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21 || newline < 3 || newline >= 2048 || bytes[newline - 1] !== 0x0d) return null
  return hash(Buffer.concat([bytes.subarray(0, newline - 1), bytes.subarray(newline)]))
}

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
    // The executor tool manifest is a runtime JSON asset: toolManifest.ts reads
    // it beside the compiled module. Exact path only — do not open dist/**/*.json.
    assert.match(path, /^(?:package\.json|README\.md|LICENSE|bin\/babel\.js|bin\/check-node-engine\.mjs|dist\/.*\.js|dist\/cli\/build-info\.json|dist\/authority\/ownedFileAssertion\.windows\.ps1|dist\/bridge\/opencode-acp-source-pin\.json|dist\/bridge\/claude-agent-sdk-pin\.json|dist\/bridge\/claudeCodeIsolatedResolveWorker\.mjs|dist\/voice\/(?:audio-capture|vad)-worker\.mjs|dist\/services\/playbooks\/.*\.json|dist\/tools\/tool-manifest\.json|resources\/.*)$/)
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env[^/]*|node_modules|runs|cache|logs|testinfra|__snapshots__)(?:\/|$)|\.test\.js$|\.(?:map|ts|sqlite|log|tgz)$/)
    assert.ok(!path.split('/').some(part => !part || part === '.' || part === '..') && !/[:\\]/.test(path), 'Unsafe package path')
  }
  for (const required of [
    'resources/prompt_catalog.yaml',
    'LICENSE',
    'dist/voice/audio-capture-worker.mjs',
    'dist/voice/vad-worker.mjs',
    'dist/bridge/claude-agent-sdk-pin.json',
    'dist/bridge/claudeCodeIsolatedResolveWorker.mjs',
    'dist/cli/build-info.json',
  ]) assert.ok(files.includes(required), required)
}

/** Compare installed build-info bytes to the producer receipt for the verified archive. */
export function verifyInstalledBuildIdentity(bytes, receipt) {
  assert.equal(hash(bytes), receipt.buildInfoSha256, 'Installed build info digest mismatch')
  const info = JSON.parse(bytes.toString('utf8'))
  assertReleaseBuildInfo(info, {
    packageVersion: receipt.version,
    sourceCommit: receipt.sourceSha,
    sourceTree: receipt.sourceTreeSha,
    recordedBuildInputs: receipt.recordedBuildInputs,
  })
  assert.equal(`v${info.nodeVersion}`, receipt.node, 'Producer Node version mismatch')
  assert.equal(info.typescriptVersion, receipt.compilerVersion, 'Producer compiler version mismatch')
  assert.equal(info.recordedBuildInputs.packageLockSha256, receipt.dependencies?.lockSha256, 'Producer dependency lock mismatch')
  return info
}

/** Verify installed package files against archive bytes, admitting only the declared npm bin transform. */
export function verifyInstalledPayloadFiles({ root, files, binTargets }) {
  verifyConsumerContents(files)
  const packageDirectory = lstatSync(root)
  assert.ok(packageDirectory.isDirectory() && !packageDirectory.isSymbolicLink(), 'Invalid installed package root')
  const bins = new Set(Object.values(binTargets))
  const paths = new Set()
  const checkedDirectories = new Set()
  const normalizedBins = []
  for (const file of files) {
    assert.ok(!paths.has(file.path), 'Duplicate archive payload path')
    paths.add(file.path)
    assert.match(file.sha256 ?? '', digest, 'Archive file digest required: ' + file.path)
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0, 'Archive file size required: ' + file.path)
    if (file.npmShebangSha256 !== undefined) {
      assert.ok(bins.has(file.path), 'Only declared bin targets can normalize a shebang')
      assert.match(file.npmShebangSha256, digest, 'Invalid normalized bin digest')
    }
    let parent = root
    for (const component of file.path.split('/').slice(0, -1)) {
      parent = join(parent, component)
      if (checkedDirectories.has(parent)) continue
      const metadata = lstatSync(parent)
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), 'Invalid installed package directory')
      checkedDirectories.add(parent)
    }
    const path = join(root, file.path)
    const metadata = lstatSync(path)
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Invalid installed package file: ' + file.path)
    assert.ok(metadata.size === file.size || (file.npmShebangSha256 && metadata.size === file.size - 1),
      'Installed size differs from qualified archive: ' + file.path)
    const actual = hash(readFileSync(path))
    if (actual === file.sha256) continue
    assert.equal(actual, file.npmShebangSha256, 'Installed bytes differ from qualified archive: ' + file.path)
    normalizedBins.push(file.path)
  }
  function checkUnexpected(dir, relativePath = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // npm may place production dependencies under this package. Their bytes
      // are outside the archive, and are not included in this receipt.
      if (!relativePath && entry.name === 'node_modules' && entry.isDirectory()) continue
      const name = relativePath + entry.name
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        assert.ok(checkedDirectories.has(entryPath), 'Unexpected installed package directory: ' + name)
        checkUnexpected(entryPath, name + '/')
      } else {
        assert.ok(paths.has(name), 'Unexpected installed package file: ' + name)
      }
    }
  }
  checkUnexpected(root)
  return { checkedFiles: paths.size, normalizedBins }
}
