import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renameCheckpointSync } from './atomicCheckpointFile.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'babel-checkpoint-rename-'))
  const source = join(root, 'checkpoint.tmp'); const destination = join(root, 'checkpoint.json')
  writeFileSync(source, 'new'); writeFileSync(destination, 'old')
  return { source, destination }
}

test('retries Windows sharing failures without deleting either checkpoint generation', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const { source, destination } = fixture(); let attempts = 0; const waits: number[] = []
    renameCheckpointSync(source, destination, { platform: 'win32', wait: ms => { waits.push(ms) }, rename: (from, to) => {
      attempts++
      assert.equal(readFileSync(destination, 'utf8'), 'old')
      assert.equal(readFileSync(source, 'utf8'), 'new')
      if (attempts < 3) throw Object.assign(new Error('sharing violation'), { code })
      renameSync(from, to)
    } })
    assert.equal(attempts, 3); assert.deepEqual(waits, [20, 40])
    assert.equal(readFileSync(destination, 'utf8'), 'new'); assert.equal(existsSync(source), false)
  }
})

test('exhausted sharing retries preserve old primary and staged replacement', () => {
  const { source, destination } = fixture(); let attempts = 0; const waits: number[] = []
  const failure = Object.assign(new Error('locked'), { code: 'EPERM' })
  assert.throws(() => renameCheckpointSync(source, destination, { platform: 'win32', wait: ms => { waits.push(ms) }, rename: () => { attempts++; throw failure } }), error => error === failure)
  assert.equal(attempts, 6); assert.deepEqual(waits, [20, 40, 80, 160, 320])
  assert.equal(readFileSync(destination, 'utf8'), 'old'); assert.equal(readFileSync(source, 'utf8'), 'new')
})

test('non-sharing errors and non-Windows platforms fail immediately', () => {
  for (const [platform, code] of [['win32', 'ENOSPC'], ['win32', 'ENOENT'], ['linux', 'EPERM']] as const) {
    const { source, destination } = fixture(); let attempts = 0
    assert.throws(() => renameCheckpointSync(source, destination, { platform, wait: () => assert.fail('unexpected retry'), rename: () => { attempts++; throw Object.assign(new Error(code), { code }) } }))
    assert.equal(attempts, 1); assert.equal(readFileSync(destination, 'utf8'), 'old')
  }
})
