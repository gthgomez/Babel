// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REQUIRED_ASSETS = [
  'LICENSE',
  'resources/prompt_catalog.yaml',
  'dist/index.js',
  'dist/cliEntryDispatch.js',
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
