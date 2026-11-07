import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportEvidenceBundle, formatEvidenceExportHuman } from './evidenceProduct.js'

test('unsafe export is contained while retaining evidence and creating no output', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-export-contained-'))
  const originalRead = fs.readFileSync
  try {
    const run = join(root, 'run'); const output = join(root, 'export'); mkdirSync(run)
    const source = join(run, 'harness.json'); writeFileSync(source, 'SYNTHETIC_RETAINED_EVIDENCE')
    let reads = 0
    fs.readFileSync = ((path: fs.PathOrFileDescriptor, options?: any) => {
      if (String(path) === source) reads++
      return originalRead(path, options)
    }) as typeof fs.readFileSync
    syncBuiltinESMExports()
    const result = exportEvidenceBundle({ runDir: run, outputDir: output })
    fs.readFileSync = originalRead; syncBuiltinESMExports()
    assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /temporarily unavailable/)
    assert.doesNotMatch(formatEvidenceExportHuman(result), /directory export is complete/i)
    assert.equal(reads, 0)
    assert.deepEqual(result.files_copied, []); assert.equal(result.zip_path, null)
    assert.equal(existsSync(output), false); assert.equal(readFileSync(source, 'utf8'), 'SYNTHETIC_RETAINED_EVIDENCE')
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
})
