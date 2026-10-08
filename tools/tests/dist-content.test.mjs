import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('ignored dist byte drift is detected independently of git status', async () => {
  const { checkDistContents } = await import('../../babel-cli/scripts/check_dist_clean.mjs')
  const root = mkdtempSync(join(tmpdir(), 'babel-dist-'))
  try {
    writeFileSync(join(root, 'index.js'), 'tampered')
    assert.throws(() => checkDistContents(root, () => writeFileSync(join(root, 'index.js'), 'rebuilt source')), /content/)
    assert.doesNotThrow(() => checkDistContents(root, () => {}))
    assert.throws(() => checkDistContents(root, () => writeFileSync(join(root, 'extra.js'), 'unexpected')), /content/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})
