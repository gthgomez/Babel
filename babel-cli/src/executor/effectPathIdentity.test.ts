import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureEffectParentIdentity, resolveOwnedEffectPath } from './effectPathIdentity.js'

test('admitted parent identity supports creation beneath not-yet-existing directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-effect-parent-'))
  try {
    const path = join(root, 'new', 'nested', 'file.txt')
    const parent = captureEffectParentIdentity(path)
    mkdirSync(join(root, 'new', 'nested'), { recursive: true })
    assert.equal(resolveOwnedEffectPath(path, parent), path)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
