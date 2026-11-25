// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { assertReleaseBuildInfo } from './write_build_info.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = /^[a-f0-9]{64}$/

/** npm bin-links can normalize the first CRLF of an executable shebang. */
export function npmNormalizedShebangDigest(bytes) {
  const newline = bytes.indexOf(0x0a)
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21 || newline < 4 || newline >= 2048 || bytes[newline - 1] !== 0x0d) return null
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

/** Read regular files from a private extraction of exactly the advertised payload. */
export function withExtractedArchive(archive, files, inspect) {
  verifyConsumerContents(files)
  const paths = new Set(files.map(file => 'package/' + file.path))
  const tar = args => execFileSync('tar', args, { encoding: 'utf8', timeout: 120000, windowsHide: true })
  const listing = tar(['-tzf', archive]).trimEnd().split(/\r?\n/)
  assert.ok(paths.size === files.length && new Set(listing).size === paths.size &&
    listing.length === paths.size && listing.every(path => paths.has(path)), 'Archive payload paths differ from the receipt')
  const scratch = mkdtempSync(join(tmpdir(), 'babel-archive-payload-'))
  try {
    tar(['-xzf', archive, '-C', scratch])
    return inspect(path => {
      assert.ok(paths.has('package/' + path), 'Archive file is absent from the receipt')
      let target = join(scratch, 'package')
      const parts = path.split('/')
      for (const part of parts.slice(0, -1)) {
        assert.ok(lstatSync(target).isDirectory(), 'Archive parent is not a directory: ' + path)
        target = join(target, part)
      }
      assert.ok(lstatSync(target).isDirectory(), 'Archive parent is not a directory: ' + path)
      target = join(target, parts.at(-1))
      const metadata = lstatSync(target)
      assert.ok(metadata.isFile() && metadata.nlink === 1, 'Archive payload must be a regular file: ' + path)
      return readFileSync(target)
    })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

/** Validate the receipt against the downloaded archive before using its rows after npm install. */
export function verifyArchivePayload({ archive, files, binTargets }) {
  const bins = new Set(Object.values(binTargets))
  withExtractedArchive(archive, files, read => {
    for (const file of files) {
      const bytes = read(file.path)
      assert.ok(bytes.length === file.size && hash(bytes) === file.sha256, 'Archive bytes differ from the receipt: ' + file.path)
      const normalized = bins.has(file.path) ? npmNormalizedShebangDigest(bytes) : null
      assert.equal(file.npmShebangSha256, normalized ?? undefined, 'Archive shebang receipt differs: ' + file.path)
    }
  })
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
    const metadata = lstatSync(path, { throwIfNoEntry: false })
    assert.ok(metadata?.isFile(), 'Invalid installed package file: ' + file.path)
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
