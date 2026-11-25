// License: Apache-2.0 — see LICENSE
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { filesPatternMatches, loadPayloadInventory, payloadManifest, verifyPackedPayload } from './release_artifact_inventory.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')

function fixtureInventory() {
  return {
    schemaVersion: 1,
    classes: { core: 'core', asset: 'asset', 'test-only': 'test-only' },
    testOnlyPatterns: [
      '(^|/)(?:test|vtTest)[A-Z][^/]*\\.(?:js|mjs|cjs)$',
      '(^|/)(?:testUtils|test-helpers|testinfra|testing)(?:/|\\.(?:js|mjs|cjs)$)',
    ],
    entries: {
      'dist/core': { class: 'core', capability: 'runtime' },
      'dist/index.js': { class: 'core', capability: 'entry' },
      'dist/cliEntryDispatch.js': { class: 'core', capability: 'entry' },
      'dist/cli': { class: 'core', capability: 'CLI and build identity' },
      'dist/optional': { class: 'core', capability: 'runtime' },
      'dist/voice': { class: 'core', capability: 'voice' },
      'dist/bridge': { class: 'core', capability: 'bridge' },
      'dist/authority': { class: 'core', capability: 'authority' },
      'dist/services': { class: 'core', capability: 'services' },
      'dist/ui': { class: 'core', capability: 'terminal UI' },
      'dist/ui/testBackend.js': { class: 'test-only', capability: 'test backend' },
      'dist/interactive/testing': { class: 'test-only', capability: 'test harness' },
      'dist/testing': { class: 'test-only', capability: 'tests' },
      resources: { class: 'asset', capability: 'resources' },
      LICENSE: { class: 'asset', capability: 'license' },
      'README.md': { class: 'asset', capability: 'readme' },
      'package.json': { class: 'core', capability: 'manifest' },
      'bin/babel.js': { class: 'core', capability: 'bin' },
    },
  }
}

function packageJson(bin = { babel: 'bin/babel.js' }) {
  return { name: 'fixture', version: '1.0.0', bin, files: ['dist/**/*.js', 'resources/', 'bin/babel.js', 'LICENSE'] }
}

function files() {
  return [
    { path: 'package.json', size: 1 }, { path: 'README.md', size: 1 }, { path: 'LICENSE', size: 1 },
    { path: 'bin/babel.js', size: 1 }, { path: 'dist/core/index.js', size: 10 },
    { path: 'dist/index.js', size: 1 }, { path: 'dist/cliEntryDispatch.js', size: 1 },
    { path: 'dist/cli/build-info.json', size: 1 },
    { path: 'dist/optional/a.js', size: 5 }, { path: 'dist/ui/core.js', size: 4 },
    { path: 'resources/prompt_catalog.yaml', size: 3 },
    { path: 'dist/voice/audio-capture-worker.mjs', size: 1 }, { path: 'dist/voice/vad-worker.mjs', size: 1 },
    { path: 'dist/bridge/claude-agent-sdk-pin.json', size: 1 },
    { path: 'dist/bridge/claudeCodeIsolatedResolveWorker.mjs', size: 1 },
    { path: 'dist/authority/ownedFileAssertion.windows.ps1', size: 1 },
    { path: 'dist/services/playbooks/a.json', size: 1 },
  ]
}

const readNodeBin = path => path === 'bin/babel.js' ? Buffer.from('#!/usr/bin/env node\n') : Buffer.alloc(0)

test('the committed inventory classifies the real package payload', () => {
  const inventory = loadPayloadInventory(repoRoot)
  const result = verifyPackedPayload({
    inventory,
    packageJson: JSON.parse(JSON.stringify({ bin: { babel: 'bin/babel.js', 'babel-agent': 'bin/babel.js', 'babel-harness': 'bin/babel.js' }, files: ['resources/', 'dist/**/*.js', 'bin/babel.js'] })),
    files: ['LICENSE', 'README.md', 'package.json', 'bin/babel.js', 'dist/index.js', 'dist/cliEntryDispatch.js', 'dist/cli/build-info.json', 'dist/agent/x.js', 'dist/services/playbooks/a.json', 'dist/voice/vad-worker.mjs', 'dist/voice/audio-capture-worker.mjs', 'dist/bridge/claude-agent-sdk-pin.json', 'dist/bridge/claudeCodeIsolatedResolveWorker.mjs', 'dist/authority/ownedFileAssertion.windows.ps1', 'resources/prompt_catalog.yaml', 'resources/config/model-policy.json'].map(path => ({ path, size: 1 })),
    readFile: readNodeBin,
  })
  assert.equal(result.status, 'PASS', JSON.stringify(result.problems))
  assert.ok(result.classes.optional.files >= 1, 'voice workers are classified as an optional capability')
})

test('payload manifest records bin aliases, required assets and class sizes', () => {
  const manifest = payloadManifest({
    inventory: fixtureInventory(),
    packageJson: { ...packageJson(), files: [] },
    files: files(),
    readFile: readNodeBin,
  })
  assert.deepEqual(manifest.bin, [{ alias: 'babel', target: 'bin/babel.js' }])
  assert.equal(manifest.files, 17)
  assert.equal(manifest.testOnlyShipped, false)
  assert.ok(manifest.requiredAssets.includes('resources/prompt_catalog.yaml'))
})

test('test-only payload shipping and unclassified paths fail closed', () => {
  const shipped = [...files(), { path: 'dist/testing/mock.js', size: 1 }, { path: 'dist/ui/testBackend.js', size: 1 },
    { path: 'dist/interactive/testing/ptyHarness.js', size: 1 }, { path: 'dist/new-payload/x.js', size: 1 }]
  const result = verifyPackedPayload({ inventory: fixtureInventory(), packageJson: packageJson(), files: shipped, readFile: readNodeBin })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.testOnlyShipped, true)
  assert.match(result.problems.join('\n'), /test-only payload shipped \(dist\/testing\)/)
  assert.match(result.problems.join('\n'), /test-only payload shipped \(dist\/ui\/testBackend\.js\)/)
  assert.match(result.problems.join('\n'), /test-only payload shipped \(dist\/interactive\/testing\)/)
  assert.match(result.problems.join('\n'), /unclassified payload: .*dist\/new-payload/)
})

test('missing bin target, missing shebang, empty files glob and missing assets fail closed', () => {
  const pkg = { ...packageJson({ babel: 'bin/missing.js' }), files: ['dist/**/*.js', 'nothing/**/*.js'] }
  const result = verifyPackedPayload({ inventory: fixtureInventory(), packageJson: pkg, files: files(), readFile: () => Buffer.from('not a node script') })
  const problems = result.problems.join('\n')
  assert.match(problems, /bin babel: target bin\/missing.js is not in the package/)
  assert.match(problems, /files pattern nothing\/\*\*\/\*.js matches nothing/)
  const missing = verifyPackedPayload({ inventory: fixtureInventory(), packageJson: packageJson(), files: files().filter(file => file.path !== 'dist/index.js'), readFile: readNodeBin })
  assert.match(missing.problems.join('\n'), /required runtime asset missing: dist\/index.js/)
  const noIdentity = verifyPackedPayload({ inventory: fixtureInventory(), packageJson: packageJson(), files: files().filter(file => file.path !== 'dist/cli/build-info.json'), readFile: readNodeBin })
  assert.match(noIdentity.problems.join('\n'), /required runtime asset missing: dist\/cli\/build-info\.json/)
  const shebang = verifyPackedPayload({ inventory: fixtureInventory(), packageJson: packageJson(), files: files(), readFile: () => Buffer.from('not a node script') })
  assert.match(shebang.problems.join('\n'), /lacks a node shebang/)
})

test('a test-only-looking module under a broad core prefix cannot auto-pass classification', () => {
  const shipped = [...files(), { path: 'dist/ui/testBackendNew.js', size: 1 }]
  const result = verifyPackedPayload({ inventory: fixtureInventory(), packageJson: packageJson(), files: shipped, readFile: readNodeBin })
  assert.equal(result.status, 'FAIL')
  assert.match(result.problems.join('\n'), /dist\/ui\/testBackendNew\.js: test-only-looking payload is classified core/)
})

test('files patterns keep npm glob semantics for directories and double stars', () => {
  assert.equal(filesPatternMatches('resources/', 'resources/config/a.json'), true)
  assert.equal(filesPatternMatches('dist/**/*.js', 'dist/a.js'), true)
  assert.equal(filesPatternMatches('dist/**/*.js', 'dist/agent/a.js'), true)
  assert.equal(filesPatternMatches('dist/**/*.js', 'dist/a.ts'), false)
  assert.equal(filesPatternMatches('bin/babel.js', 'bin/babel.js'), true)
  assert.equal(filesPatternMatches('dist/services/playbooks/*.json', 'dist/services/playbooks/n/x.json'), false)
})

test('an inventory entry without a documented capability is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-inventory-'))
  try {
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config/package-payload-inventory.json'), JSON.stringify({ schemaVersion: 1, classes: { core: 'c' }, entries: { 'dist/x': { class: 'core' } } }))
    assert.throws(() => loadPayloadInventory(root), /capability required/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
