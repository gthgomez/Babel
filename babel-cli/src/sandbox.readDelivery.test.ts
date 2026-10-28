import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SafeExecutor } from './sandbox.js'

test('sandbox distinguishes byte completeness from the actual delivered line window', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-delivery-'))
  try {
    writeFileSync(join(root, 'large.ts'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    const executor = new SafeExecutor(root)
    const first = executor.fileRead('large.ts')
    assert.equal(first.output_completeness?.complete, true, 'existing byte-completeness meaning is preserved')
    assert.deepEqual(first.read_window, { startLine: 1, endLine: 200, totalLines: 300, completeFile: false, byteTruncated: false })
    assert.deepEqual(executor.fileRead('large.ts', { offset: 201, limit: 5 }).read_window,
      { startLine: 201, endLine: 205, totalLines: 300, completeFile: false, byteTruncated: false })
    assert.equal(executor.fileRead('large.ts', { offset: 999 }).read_window, undefined, 'a range notice is not a delivered read')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('empty files have a delivered complete zero-line window', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-empty-delivery-'))
  try {
    writeFileSync(join(root, 'empty.ts'), '')
    const result = new SafeExecutor(root).fileRead('empty.ts')
    assert.deepEqual(result.read_window, { startLine: 1, endLine: 0, totalLines: 0, completeFile: true, byteTruncated: false })
    assert.equal(result.output_completeness?.returned_bytes, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Unicode byte caps retain complete characters and never claim a full file', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-unicode-delivery-'))
  try {
    writeFileSync(join(root, 'unicode.ts'), '€'.repeat(34_134))
    const result = new SafeExecutor(root).fileRead('unicode.ts', { raw: true })
    assert.doesNotMatch(result.stdout, /�/)
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 100 * 1024)
    assert.equal(result.output_completeness?.returned_bytes, Buffer.byteLength(result.stdout, 'utf8'))
    assert.deepEqual(result.read_window, { startLine: 1, endLine: 1, totalLines: 1, completeFile: false, byteTruncated: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
