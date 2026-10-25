import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { fsyncDirectoryEntrySync, renameCheckpointSync } from './atomicCheckpointFile.js'

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

test('fsyncDirectoryEntrySync flushes a directory on this platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-checkpoint-fsync-dir-'))
  const directory = join(root, 'nested')
  mkdirSync(directory, { recursive: true })
  fsyncDirectoryEntrySync(directory)
  rmSync(root, { recursive: true, force: true })
})

// Source diagnosis: observationStore documents EPERM for read-only handles on win32.
// Fresh Windows execution proof: this subtest only (skipped on Linux CI agents).
test('win32 read-only directory handle rejects fsync with EPERM', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-checkpoint-win32-fsync-'))
  const directory = join(root, 'ledger')
  mkdirSync(directory, { recursive: true })
  let errno: string | undefined
  const fd = openSync(directory, 'r')
  try {
    try {
      fsyncSync(fd)
    } catch (error) {
      errno = (error as NodeJS.ErrnoException).code
    }
  } finally {
    closeSync(fd)
  }
  assert.equal(errno, 'EPERM')
  fsyncDirectoryEntrySync(directory)
  rmSync(root, { recursive: true, force: true })
})

test('non-sharing errors and non-Windows platforms fail immediately', () => {
  for (const [platform, code] of [['win32', 'ENOSPC'], ['win32', 'ENOENT'], ['linux', 'EPERM']] as const) {
    const { source, destination } = fixture(); let attempts = 0
    assert.throws(() => renameCheckpointSync(source, destination, { platform, wait: () => assert.fail('unexpected retry'), rename: () => { attempts++; throw Object.assign(new Error(code), { code }) } }))
    assert.equal(attempts, 1); assert.equal(readFileSync(destination, 'utf8'), 'old')
  }
})
