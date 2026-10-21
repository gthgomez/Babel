import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildInlinePassageTextRef,
  MAX_INLINE_PASSAGE_CODE_POINTS,
  passageTextHash,
  truncateToCodePointLimit,
} from './passageInlineText.js'

test('truncateToCodePointLimit: does not split emoji surrogate pair', () => {
  const emoji = '😀'
  const prefix = 'a'.repeat(MAX_INLINE_PASSAGE_CODE_POINTS)
  const full = prefix + emoji
  const { emitted, truncated } = truncateToCodePointLimit(full, MAX_INLINE_PASSAGE_CODE_POINTS)
  assert.equal(truncated, true)
  assert.equal([...emitted].length, MAX_INLINE_PASSAGE_CODE_POINTS)
  assert.equal(emitted, prefix)
  assert.doesNotMatch(emitted, /\uD83D$/)
})

test('buildInlinePassageTextRef: hashes emitted text only', () => {
  const long = 'x'.repeat(MAX_INLINE_PASSAGE_CODE_POINTS + 50)
  const ref = buildInlinePassageTextRef(long)
  assert.equal(ref.text.length, [...ref.text].length)
  assert.equal(ref.text_hash, passageTextHash(ref.text))
  assert.notEqual(ref.text_hash, passageTextHash(long))
  assert.ok(ref.truncationNotes.length >= 1)
})
