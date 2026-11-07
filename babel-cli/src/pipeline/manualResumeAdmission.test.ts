import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resumeManualBridge } from '../pipeline.js'

test('legacy manual resume rejects before reading or changing retained artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-manual-resume-quarantine-'))
  const manifest = join(root, '01_manifest.json'); writeFileSync(manifest, '{}')
  try {
    await assert.rejects(resumeManualBridge(root, { rawPlanText: 'synthetic legacy text' }), /UNSUPPORTED_OPERATION.*legacy.*resume/i)
    assert.equal(readFileSync(manifest, 'utf8'), '{}')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
