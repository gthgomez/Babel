import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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

test('prepack-pruned test-only directories do not look like source drift', async () => {
  const { checkDistContents } = await import('../../babel-cli/scripts/check_dist_clean.mjs')
  const root = mkdtempSync(join(tmpdir(), 'babel-dist-pruned-'))
  try {
    writeFileSync(join(root, 'index.js'), 'built')
    for (const dir of ['testUtils', 'testing', 'test-helpers', 'testinfra']) mkdirSync(join(root, dir))
    writeFileSync(join(root, 'testUtils/fixture.js'), 'pruned from the package only')
    assert.doesNotThrow(() => checkDistContents(root, () => {}))
    assert.throws(() => checkDistContents(root, () => {
      mkdirSync(join(root, 'runtime-payload'))
      writeFileSync(join(root, 'runtime-payload/extra.js'), 'new payload')
    }), /content/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})
