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
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('build metadata is captured at process start and a changed manifest requires a restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-running-build-'))
  try {
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true })
    const metadata = join(root, 'package.json'); const entry = join(root, 'index.js')
    const manifest = join(root, 'dist', 'cli', 'build-info.json')
    const build = { schemaVersion: 1, packageVersion: '1.0.0', sourceCommit: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40), workingTreeClean: true, buildInputsDigest: null,
      buildInputsReason: 'complete build inputs were not recorded', nodeVersion: '24.13.1', typescriptVersion: '5.8.3' }
    writeFileSync(metadata, JSON.stringify({ version: '1.0.0' })); writeFileSync(entry, 'code')
    writeFileSync(manifest, JSON.stringify(build))
    const running = captureRunningProduct(root, entry) as ReturnType<typeof captureRunningProduct> & { buildInfo?: typeof build | null }
    assert.deepEqual(running.buildInfo, build)
    writeFileSync(manifest, JSON.stringify({ ...build, sourceCommit: 'c'.repeat(40) }))
    const after = inspectRunningProduct(running)
    assert.equal(running.buildInfo?.sourceCommit, build.sourceCommit)
    assert.equal(after.restartNeeded, true)
    writeFileSync(manifest, '{')
    assert.equal(inspectRunningProduct(running).restartNeeded, true)
    writeFileSync(manifest, JSON.stringify({ ...build, packageVersion: '9.9.9' }))
    assert.equal((captureRunningProduct(root, entry) as typeof running).buildInfo, null)
    const recordedBuildInputs = { scope: 'cli-manifest-lock-config-and-tsc-files:v1',
      sha256: 'd'.repeat(64), packageLockSha256: 'e'.repeat(64) }
    writeFileSync(manifest, JSON.stringify({ ...build, recordedBuildInputs }))
    assert.deepEqual(captureRunningProduct(root, entry).buildInfo?.recordedBuildInputs, recordedBuildInputs)
    writeFileSync(manifest, JSON.stringify({ ...build, recordedBuildInputs: { ...recordedBuildInputs, scope: 'all-inputs' } }))
    assert.equal(captureRunningProduct(root, entry).buildInfo, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
