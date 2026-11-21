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

test('prepack-pruned paths are exempted exactly, not by directory name at any depth', async () => {
  const { checkDistContents } = await import('../../babel-cli/scripts/check_dist_clean.mjs')
  const root = mkdtempSync(join(tmpdir(), 'babel-dist-pruned-'))
  try {
    writeFileSync(join(root, 'index.js'), 'built')
    for (const dir of ['testUtils', 'testing', 'test-helpers', 'testinfra', 'interactive/testing', 'ui']) mkdirSync(join(root, dir), { recursive: true })
    for (const file of ['testUtils/fixture.js', 'testing/mock.js', 'interactive/testing/ptyHarness.js', 'ui/testBackend.js']) {
      writeFileSync(join(root, file), 'pruned from the package only')
    }
    assert.doesNotThrow(() => checkDistContents(root, () => {
      for (const file of ['testUtils/fixture.js', 'testing/mock.js', 'interactive/testing/ptyHarness.js', 'ui/testBackend.js']) rmSync(join(root, file))
    }))
    writeFileSync(join(root, 'index.js'), 'built')
    assert.throws(() => checkDistContents(root, () => {
      mkdirSync(join(root, 'runtime-payload'))
      writeFileSync(join(root, 'runtime-payload/extra.js'), 'new payload')
    }), /content/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})

test('a nested testing directory is not exempt just because of its name', async () => {
  const { checkDistContents } = await import('../../babel-cli/scripts/check_dist_clean.mjs')
  const root = mkdtempSync(join(tmpdir(), 'babel-dist-nested-'))
  try {
    writeFileSync(join(root, 'index.js'), 'built')
    mkdirSync(join(root, 'agent/testing'), { recursive: true })
    writeFileSync(join(root, 'agent/testing/harness.js'), 'runtime payload that happens to share a name')
    assert.throws(() => checkDistContents(root, () => rmSync(join(root, 'agent/testing'), { recursive: true, force: true })), /content/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})
