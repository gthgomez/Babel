import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_TECHNICAL_PASSAGE_BYTES,
  passagesFromValidatedPlainBytes,
  utf8SafePrefix,
} from './plainTextByteExcerpt.js'
import { SourceRevisionSchema } from '../../contracts/sources.js'

describe('technical plain byte excerpt', () => {
  it('does not split UTF-8 code units (emoji suffix)', () => {
    const emoji = '😀'
    const bytes = Buffer.concat([Buffer.from('a'.repeat(3999), 'utf8'), Buffer.from(emoji, 'utf8')])
    const { prefix, truncated } = utf8SafePrefix(bytes, MAX_TECHNICAL_PASSAGE_BYTES)
    assert.equal(truncated, true)
    assert.ok(prefix.toString('utf8').endsWith('a'))
    assert.ok(!prefix.toString('utf8').includes(emoji))
    assert.equal(Buffer.from(prefix.toString('utf8'), 'utf8').compare(prefix), 0)
  })

  it('locator end_offset matches excerpt bytes in original admission', () => {
    const sourceBytes = Buffer.from('a'.repeat(5000), 'utf8')
    const revision = SourceRevisionSchema.parse({
      revision_id: 'rev-excerpt-1',
      source_id: 'src-1',
      content_hash: 'a'.repeat(64),
      retrieved_at: '2026-10-20T12:00:00.000Z',
      extraction_version: 'test',
      media_type: 'text/plain',
      completeness: 'complete',
    })
    const passages = passagesFromValidatedPlainBytes(revision, sourceBytes)
    const passage = passages[0]
    assert.ok(passage)
    assert.equal(passage.locator.kind, 'byte_offset')
    if (passage.locator.kind === 'byte_offset') {
      assert.equal(passage.locator.start_offset, 0)
      assert.equal(passage.locator.end_offset, MAX_TECHNICAL_PASSAGE_BYTES)
      assert.equal(passage.text_ref.mode, 'inline')
      if (passage.text_ref.mode === 'inline') {
        const excerptBytes = sourceBytes.subarray(
          passage.locator.start_offset,
          passage.locator.end_offset,
        )
        assert.equal(excerptBytes.toString('utf8'), passage.text_ref.text)
        assert.equal(
          passage.locator.end_offset - passage.locator.start_offset,
          Buffer.byteLength(passage.text_ref.text, 'utf8'),
        )
      }
    }
    assert.deepEqual(passage.extraction_notes, ['excerpt_truncated_by_byte_limit'])
  })

  it('full admission under cap uses exclusive end_offset equal to byte length', () => {
    const sourceBytes = Buffer.from('short technical corpus\n', 'utf8')
    const revision = SourceRevisionSchema.parse({
      revision_id: 'rev-short',
      source_id: 'src-1',
      content_hash: 'b'.repeat(64),
      retrieved_at: '2026-10-20T12:00:00.000Z',
      extraction_version: 'test',
      media_type: 'text/plain',
      completeness: 'complete',
    })
    const [passage] = passagesFromValidatedPlainBytes(revision, sourceBytes)
    assert.ok(passage)
    assert.equal(passage.locator.kind, 'byte_offset')
    if (passage.locator.kind === 'byte_offset') {
      assert.equal(passage.locator.end_offset, sourceBytes.length)
      assert.equal(
        sourceBytes.subarray(passage.locator.start_offset, passage.locator.end_offset).toString('utf8'),
        passage.text_ref.mode === 'inline' ? passage.text_ref.text : '',
      )
    }
  })
})
