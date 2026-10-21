import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveQuarantinedFixturePath } from './quarantinePath.js'

test('resolveQuarantinedFixturePath allows paths under fixture root', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-quarantine-'))
  const nested = join(root, 'G-DEV-03/sources')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'official-policy.txt'), 'line one\n', { flag: 'w' })
  const resolved = resolveQuarantinedFixturePath(root, 'G-DEV-03/sources/official-policy.txt')
  assert.match(resolved, /official-policy\.txt$/)
})

test('resolveQuarantinedFixturePath rejects parent traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-quarantine-'))
  assert.throws(
    () => resolveQuarantinedFixturePath(root, '../outside.txt'),
    /quarantine: rejected relative path/,
  )
})

test('resolveQuarantinedFixturePath rejects absolute relativePath', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-quarantine-'))
  assert.throws(
    () => resolveQuarantinedFixturePath(root, '/etc/passwd'),
    /quarantine: rejected absolute path/,
  )
})
