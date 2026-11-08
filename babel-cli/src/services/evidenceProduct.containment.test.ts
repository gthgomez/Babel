import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportEvidenceBundle, formatEvidenceExportHuman } from './evidenceProduct.js'

test('export refuses a linked source artifact and retains evidence without creating output', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-export-contained-'))
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); mkdirSync(run)
    const outside = join(root, 'outside.json'); writeFileSync(outside, 'SYNTHETIC_OUTSIDE_EVIDENCE')
    symlinkSync(outside, join(run, 'harness.json'))
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /linked source artifact/i)
    assert.doesNotMatch(formatEvidenceExportHuman(result), /directory export is complete/i)
    assert.deepEqual(result.files_copied, []); assert.equal(result.zip_path, null)
    assert.equal(existsSync(output), false)
    assert.equal(readFileSync(outside, 'utf8'), 'SYNTHETIC_OUTSIDE_EVIDENCE')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('export refuses a non-empty destination instead of overwriting existing evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-export-destination-'))
  try {
    const run = join(root, 'run'); const output = join(root, 'export')
    mkdirSync(run); mkdirSync(output)
    writeFileSync(join(run, 'harness.json'), JSON.stringify({ task: 'safe' }))
    writeFileSync(join(output, 'existing.json'), 'SYNTHETIC_EXISTING')
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /empty destination/i)
    assert.equal(readFileSync(join(output, 'existing.json'), 'utf8'), 'SYNTHETIC_EXISTING')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
