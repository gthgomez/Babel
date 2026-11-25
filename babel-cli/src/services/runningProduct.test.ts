import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureRunningProduct, inspectRunningProduct } from './runningProduct.js'

test('running identity remains fixed when an installation changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-running-product-'))
  try {
    const metadata = join(root, 'package.json'); const entry = join(root, 'index.js')
    writeFileSync(metadata, JSON.stringify({ version: '1.0.0' })); writeFileSync(entry, 'old code')
    const running = captureRunningProduct(root, entry)
    writeFileSync(metadata, JSON.stringify({ version: '2.0.0' })); writeFileSync(entry, 'new code')
    const status = inspectRunningProduct(running)
    assert.equal(status.runningVersion, '1.0.0')
    assert.equal(status.revision, null)
    assert.equal(status.restartNeeded, true)
    assert.equal(status.packageRoot, root)
    assert.equal(status.entrypoint, entry)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('missing build metadata stays unknown rather than implying an update', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-running-unknown-'))
  try {
    const status = inspectRunningProduct(captureRunningProduct(root, join(root, 'missing.js')))
    assert.equal(status.runningVersion, null); assert.equal(status.revision, null); assert.equal(status.restartNeeded, null)
    assert.equal(status.buildInfo, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const buildInfo = {
  schemaVersion: 1,
  packageVersion: '1.0.0',
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  workingTreeClean: true,
  buildInputsDigest: null,
  buildInputsReason: 'complete build inputs were not recorded',
  recordedBuildInputs: {
    scope: 'cli-manifest-lock-config-and-tsc-files:v1',
    sha256: 'c'.repeat(64),
    packageLockSha256: 'd'.repeat(64),
  },
  nodeVersion: '22.19.0',
  typescriptVersion: '6.0.3',
}

test('a same-version build manifest replacement recommends restarting and preserves the process-start record', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-running-build-'))
  try {
    const entry = join(root, 'index.js')
    const buildDir = join(root, 'dist', 'cli')
    const manifest = join(buildDir, 'build-info.json')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    writeFileSync(entry, 'launcher')

    const legacy = inspectRunningProduct(captureRunningProduct(root, entry))
    assert.equal(legacy.buildInfo, null)
    assert.equal(legacy.restartNeeded, false)

    mkdirSync(buildDir, { recursive: true })
    writeFileSync(manifest, JSON.stringify(buildInfo))
    const running = captureRunningProduct(root, entry)
    assert.deepEqual(running.buildInfo, buildInfo)
    assert.equal(running.revision, null)
    assert.equal(inspectRunningProduct(running).restartNeeded, false)

    writeFileSync(manifest, JSON.stringify({ ...buildInfo, sourceCommit: 'e'.repeat(40) }))
    const status = inspectRunningProduct(running)
    assert.equal(status.restartNeeded, true)
    assert.deepEqual(status.buildInfo, buildInfo)
    assert.equal(status.revision, null)

    rmSync(manifest)
    assert.equal(inspectRunningProduct(running).restartNeeded, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('invalid build metadata stays unreported and an inspected file cannot replace startup identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-running-invalid-build-'))
  try {
    const entry = join(root, 'index.js')
    const buildDir = join(root, 'dist', 'cli')
    const manifest = join(buildDir, 'build-info.json')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
    writeFileSync(entry, 'launcher')
    mkdirSync(buildDir, { recursive: true })
    const invalidRecords = [
      '{',
      JSON.stringify({ ...buildInfo, packageVersion: '9.0.0' }),
      JSON.stringify({ ...buildInfo, buildInputsDigest: 'f'.repeat(64) }),
      JSON.stringify({ ...buildInfo, recordedBuildInputs: { ...buildInfo.recordedBuildInputs, scope: 'all-inputs' } }),
      JSON.stringify({ ...buildInfo, recordedBuildInputs: { ...buildInfo.recordedBuildInputs, packageLockSha256: 'invalid' } }),
      ' '.repeat(16 * 1024 + 1),
    ]
    for (const invalid of invalidRecords) {
      writeFileSync(manifest, invalid)
      const running = captureRunningProduct(root, entry)
      assert.equal(running.buildInfo, null)
      assert.equal(running.revision, null)
      writeFileSync(manifest, JSON.stringify(buildInfo))
      assert.equal(inspectRunningProduct(running).buildInfo, null)
    }
    const developmentBuild = {
      ...buildInfo, sourceCommit: null, sourceTree: null, workingTreeClean: null,
      recordedBuildInputs: null, typescriptVersion: null,
    }
    writeFileSync(manifest, JSON.stringify(developmentBuild))
    assert.deepEqual(captureRunningProduct(root, entry).buildInfo, developmentBuild)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
