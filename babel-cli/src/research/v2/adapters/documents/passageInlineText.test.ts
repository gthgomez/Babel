import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassageRecordSchema } from '../../contracts/passages.js'
import {
  buildInlinePassageTextRef,
  MAX_INLINE_PASSAGE_UTF16_UNITS,
  passageTextHash,
  truncateToInlinePassageTextLimit,
} from './passageInlineText.js'

test('truncateToInlinePassageTextLimit: 31999 ASCII + emoji stays within UTF-16 schema max', () => {
  const emoji = '😀'
  const prefix = 'a'.repeat(MAX_INLINE_PASSAGE_UTF16_UNITS - 1)
  const full = prefix + emoji
  const { emitted, truncated } = truncateToInlinePassageTextLimit(full)
  assert.equal(truncated, true)
  assert.equal(emitted, prefix)
  assert.equal(emitted.length, MAX_INLINE_PASSAGE_UTF16_UNITS - 1)
  assert.doesNotMatch(emitted, /\uD83D$/)
})

test('buildInlinePassageTextRef: hashes emitted text and satisfies PassageTextRefSchema', () => {
  const long = 'x'.repeat(MAX_INLINE_PASSAGE_UTF16_UNITS + 50)
  const ref = buildInlinePassageTextRef(long)
  assert.equal(ref.text.length, MAX_INLINE_PASSAGE_UTF16_UNITS)
  assert.equal(ref.text_hash, passageTextHash(ref.text))
  assert.notEqual(ref.text_hash, passageTextHash(long))
  assert.ok(ref.truncationNotes.length >= 1)
})

test('buildInlinePassageTextRef: astral tail dropped before UTF-16 overflow', () => {
  const emoji = '😀'
  const prefix = 'a'.repeat(MAX_INLINE_PASSAGE_UTF16_UNITS)
  const ref = buildInlinePassageTextRef(prefix + emoji)
  assert.equal(ref.text.length, MAX_INLINE_PASSAGE_UTF16_UNITS)
  assert.equal(ref.text, prefix)
})
