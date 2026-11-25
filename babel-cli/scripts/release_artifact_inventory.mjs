// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REQUIRED_ASSETS = [
  'LICENSE',
  'resources/prompt_catalog.yaml',
  'dist/index.js',
  'dist/cliEntryDispatch.js',
  'dist/cli/build-info.json',
  'dist/voice/audio-capture-worker.mjs',
  'dist/voice/vad-worker.mjs',
  'dist/bridge/claude-agent-sdk-pin.json',
  'dist/bridge/claudeCodeIsolatedResolveWorker.mjs',
  'dist/authority/ownedFileAssertion.windows.ps1',
]

/** Load the committed classification of every shipped payload path. */
export function loadPayloadInventory(repoRoot, path = 'config/package-payload-inventory.json') {
  const inventory = JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'))
  assert.equal(inventory.schemaVersion, 1, 'unsupported payload inventory schema')
  assert.equal(typeof inventory.entries, 'object', 'payload inventory entries must be an object map')
  assert.ok(!Array.isArray(inventory.entries), 'payload inventory entries must be an object map')
  const entries = Object.entries(inventory.entries ?? {})
  assert.ok(entries.length > 0, 'payload inventory is empty')
  for (const [entry, value] of entries) {
    assert.ok(Object.hasOwn(inventory.classes, value.class), `${entry}: unknown class ${value.class}`)
    assert.equal(typeof value.capability, 'string', `${entry}: capability required`)
    assert.ok(value.capability.length > 0, `${entry}: capability required`)
  }
  const testOnlyPatterns = (inventory.testOnlyPatterns ?? []).map(source => {
    assert.equal(typeof source, 'string', 'testOnlyPatterns entries must be strings')
    return new RegExp(source)
  })
  return { ...inventory, entries: inventory.entries, testOnlyPatterns }
}

function matchesPrefix(path, entry) {
  return path === entry || path.startsWith(`${entry}/`)
}

/** Match a package.json files pattern against a shipped path, supporting the reviewed subset. */
export function filesPatternMatches(pattern, path) {
  if (pattern.endsWith('/')) return path.startsWith(pattern)
  const escaped = pattern
    .replace(/^\.\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*')
  return new RegExp(`^${escaped}$`).test(path) || new RegExp(`^${escaped}/`).test(path)
}

/**
 * Prove the packed payload matches what the package advertises: every bin
 * target, every declared files pattern and every required runtime asset is
 * present, every shipped path is classified, and test-only support is gone.
 * @param {{inventory: object, packageJson: object, files: Array<{path: string, size?: number, mode?: number}>, readFile?: (path: string) => Buffer}} input
 */
export function verifyPackedPayload({ inventory, packageJson, files, readFile }) {
  const problems = []
  const shipped = new Map(files.map(file => [file.path, file]))
  const entries = Object.entries(inventory.entries)
  const classOf = path => {
    let match = null
    for (const [entry, value] of entries) {
      if (!matchesPrefix(path, entry)) continue
      if (!match || entry.length > match[0].length) match = [entry, value]
    }
    return match
  }

  const patterns = [...(inventory.testOnlyPatterns ?? [])].map(pattern => typeof pattern === 'string' ? new RegExp(pattern) : pattern)
  const unclassified = []
  const testOnlyFiles = []
  const classes = {}
  for (const file of files) {
    const match = classOf(file.path)
    if (!match) {
      unclassified.push(file.path)
      continue
    }
    const [entry, value] = match
    if (value.class === 'test-only') {
      testOnlyFiles.push(file.path)
      problems.push(`${file.path}: test-only payload shipped (${entry})`)
    } else if (!entries.some(([candidate]) => candidate === file.path) && patterns.some(pattern => pattern.test(file.path))) {
      // A test-support module added under a broad core prefix must be classified
      // explicitly; longest-prefix matching must not silently absorb it.
      problems.push(`${file.path}: test-only-looking payload is classified ${value.class}`)
    }
    const bucket = classes[value.class] ?? { files: 0, bytes: 0 }
    bucket.files += 1
    bucket.bytes += file.size ?? 0
    classes[value.class] = bucket
  }
  if (unclassified.length) problems.push(`unclassified payload: ${unclassified.slice(0, 8).join(', ')}${unclassified.length > 8 ? ` (+${unclassified.length - 8})` : ''}`)
  for (const [alias, target] of Object.entries(packageJson.bin ?? {})) {
    const file = shipped.get(target)
    if (!file) {
      problems.push(`bin ${alias}: target ${target} is not in the package`)
      continue
    }
    if (readFile) {
      const head = readFile(target).subarray(0, 64).toString('utf8')
      if (!head.startsWith('#!/usr/bin/env node')) problems.push(`bin ${alias}: target ${target} lacks a node shebang`)
    }
  }

  for (const pattern of packageJson.files ?? []) {
    if (!files.some(file => filesPatternMatches(pattern, file.path))) problems.push(`files pattern ${pattern} matches nothing`)
  }

  for (const required of REQUIRED_ASSETS) {
    if (!shipped.has(required)) problems.push(`required runtime asset missing: ${required}`)
  }
  if (![...shipped.keys()].some(path => matchesPrefix(path, 'dist/services/playbooks') && path.endsWith('.json'))) {
    problems.push('required runtime asset missing: dist/services/playbooks/*.json')
  }

  return {
    status: problems.length ? 'FAIL' : 'PASS',
    files: files.length,
    bytes: files.reduce((total, file) => total + (file.size ?? 0), 0),
    classes,
    unclassified,
    testOnlyFiles,
    testOnlyShipped: testOnlyFiles.length > 0,
    problems,
  }
}

/** Class-summary used in the immutable release manifest. */
export function payloadManifest({ inventory, packageJson, files, readFile }) {
  const result = verifyPackedPayload({ inventory, packageJson, files, readFile })
  assert.equal(result.status, 'PASS', `packaged payload is not qualified: ${result.problems.join('; ')}`)
  return {
    schemaVersion: 1,
    files: result.files,
    unpackedBytes: result.bytes,
    classes: Object.fromEntries(Object.entries(result.classes).sort(([a], [b]) => a.localeCompare(b))),
    bin: Object.entries(packageJson.bin ?? {}).map(([alias, target]) => ({ alias, target })),
    requiredAssets: REQUIRED_ASSETS,
    testOnlyShipped: result.testOnlyShipped,
  }
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** npm bin-links can normalize the first CRLF of an executable shebang. */
export function npmNormalizedShebangDigest(bytes) {
  const newline = bytes.indexOf(0x0a)
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21 || newline < 4 || newline >= 2048 || bytes[newline - 1] !== 0x0d) return null
  return hash(Buffer.concat([bytes.subarray(0, newline - 1), bytes.subarray(newline)]))
}

/** Read regular files from a private extraction of exactly the advertised payload. */
export function withExtractedArchive(archive, files, inspect) {
  const portablePaths = new Map()
  const paths = new Set()
  for (const { path } of files) {
    assert.equal(typeof path, 'string', 'Missing archive payload path')
    const segments = path.split('/')
    assert.ok(!/[:\\\x00-\x1f]/.test(path) && segments.every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'Unsafe archive payload path')
    let prefix = ''
    for (const part of segments) {
      prefix += '/' + part
      const canonical = prefix.normalize('NFC').toLowerCase()
      const previous = portablePaths.get(canonical)
      assert.ok(previous === undefined || previous === prefix, 'Archive payload has a portable path collision')
      portablePaths.set(canonical, prefix)
    }
    paths.add('package/' + path)
  }
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
  return withExtractedArchive(archive, files, read => {
    for (const file of files) {
      const bytes = read(file.path)
      assert.ok(bytes.length === file.size && hash(bytes) === file.sha256, 'Archive bytes differ from the receipt: ' + file.path)
      const normalized = bins.has(file.path) ? npmNormalizedShebangDigest(bytes) : null
      assert.equal(file.npmShebangSha256, normalized ?? undefined, 'Archive shebang receipt differs: ' + file.path)
    }
    const packageJson = JSON.parse(read('package.json'))
    assert.deepEqual(packageJson.bin, binTargets, 'Archive bin declarations differ from the receipt')
    return { packageJson, buildInfoBytes: read('dist/cli/build-info.json') }
  })
}

export function assertRecordedBuildInputs(value, expected) {
  const digest = /^[a-f0-9]{64}$/
  if (value?.scope !== 'cli-manifest-lock-config-and-tsc-files:v1' ||
      !digest.test(value.sha256) || !digest.test(value.packageLockSha256) ||
      value.sha256 !== expected?.sha256 || value.packageLockSha256 !== expected?.packageLockSha256 ||
      value.scope !== expected?.scope) {
    throw new Error('Recorded CLI build inputs do not match the expected receipt')
  }
}

/** A release may bind this self-report only after comparing it to the clean candidate. */
export function assertReleaseBuildInfo(info, expected) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const objectId = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
  check(Boolean(info && typeof info === 'object' && !Array.isArray(info)), 'Build identity is missing')
  check(info.schemaVersion === 1, 'Unsupported build identity schema')
  check(typeof expected.packageVersion === 'string' && info.packageVersion === expected.packageVersion, 'Build identity version does not match the package')
  check(objectId(expected.sourceCommit) && info.sourceCommit === expected.sourceCommit, 'Build identity commit does not match the candidate')
  check(objectId(expected.sourceTree) && info.sourceTree === expected.sourceTree, 'Build identity tree does not match the candidate')
  check(info.workingTreeClean === true, 'Release build identity must report a clean source tree')
  check(typeof info.nodeVersion === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(info.nodeVersion), 'Build Node version is unavailable')
  check(typeof info.typescriptVersion === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(info.typescriptVersion), 'Build compiler version is unavailable')
  check(info.buildInputsDigest === null && info.buildInputsReason === 'complete build inputs were not recorded',
    'Build identity must not claim complete input coverage')
  assertRecordedBuildInputs(info.recordedBuildInputs, expected.recordedBuildInputs)
}

/** Bind archived or installed build metadata to the producer receipt. */
export function verifyBuildInfoReceipt(bytes, receipt) {
  assert.equal(hash(bytes), receipt.buildInfoSha256, 'Build info digest mismatch')
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
