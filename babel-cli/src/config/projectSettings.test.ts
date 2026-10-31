import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeProjectSettings } from './projectSettings.js'

test('legacy project preference updates preserve unknown fields and reject invalid writes atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-project-settings-'))
  try {
    mkdirSync(join(root, '.babel'))
    const path = join(root, '.babel', 'settings.json')
    writeFileSync(path, JSON.stringify({ future: { enabled: true }, model: 'legacy-explicit' }))
    assert.equal(writeProjectSettings(root, { mode: 'plan' }).ok, true)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).future.enabled, true)
    const before = readFileSync(path, 'utf8')
    assert.equal(writeProjectSettings(root, { mode: 'invalid' } as never).ok, false)
    assert.equal(readFileSync(path, 'utf8'), before)
    writeFileSync(path, '{broken')
    assert.equal(writeProjectSettings(root, { mode: 'plan' }).ok, false)
    assert.equal(readFileSync(path, 'utf8'), '{broken')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
