import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  trimIncompleteUtf8SequenceSuffix,
  Utf8InteriorCorruptionError,
} from './utf8SafeBytePrefix.js'

describe('trimIncompleteUtf8SequenceSuffix', () => {
  it('rejects interior invalid UTF-8 instead of returning an earlier valid prefix', () => {
    const valid = Buffer.from('valid', 'utf8')
    const rest = Buffer.from('rest', 'utf8')
    const corrupt = Buffer.concat([valid, Buffer.from([0xff]), rest])
    assert.throws(() => trimIncompleteUtf8SequenceSuffix(corrupt), Utf8InteriorCorruptionError)
  })

  it('drops at most 3 bytes for a trailing incomplete UTF-8 sequence at cap', () => {
    const lead = Buffer.from([0xe2, 0x82]) // incomplete 3-byte sequence
    const prefix = Buffer.from('abc', 'utf8')
    const bytes = Buffer.concat([prefix, lead])
    const trimmed = trimIncompleteUtf8SequenceSuffix(bytes)
    assert.equal(trimmed.toString('utf8'), 'abc')
    assert.equal(bytes.length - trimmed.length, 2)
  })
})
