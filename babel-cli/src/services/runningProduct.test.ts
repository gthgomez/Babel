import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
