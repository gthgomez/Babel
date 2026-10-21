import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { verifyMissionAdmittedDocumentBody } from './missionDocumentAcquisitionPolicy.js'

const policyBase = {
  document_ref: 'https://example.invalid/doc.pdf',
  content_pin_kind: 'mutable_locator_content_digest' as const,
  wire_byte_budget: 10_000,
  decompressed_byte_budget: 10_000,
  require_complete_body: true as const,
}

describe('verifyMissionAdmittedDocumentBody admission diagnostics', () => {
  it('surfaces CRLF line-ending hints on digest mismatch without weakening checks', () => {
    const lfBody = Buffer.from('line one\nline two\n', 'utf8')
    const crlfBody = Buffer.from('line one\r\nline two\r\n', 'utf8')
    const expectedDigest = createHash('sha256').update(lfBody).digest('hex')
    const verdict = verifyMissionAdmittedDocumentBody(
      {
        ...policyBase,
        expected_content_sha256: expectedDigest,
        expected_byte_length: lfBody.length,
      },
      crlfBody,
      false,
    )
    assert.equal(verdict.ok, false)
    if (!verdict.ok) {
      assert.match(verdict.message, /digest does not match/)
      assert.match(verdict.message, /CRLF|LF-normalized/)
      assert.ok(verdict.message.includes(String(crlfBody.length)))
      assert.ok(verdict.message.includes(String(lfBody.length)))
    }
  })

  it('surfaces CRLF hints on byte length mismatch', () => {
    const lfBody = Buffer.from('a\nb\n', 'utf8')
    const crlfBody = Buffer.from('a\r\nb\r\n', 'utf8')
    const digest = createHash('sha256').update(crlfBody).digest('hex')
    const verdict = verifyMissionAdmittedDocumentBody(
      {
        ...policyBase,
        expected_content_sha256: digest,
        expected_byte_length: lfBody.length,
      },
      crlfBody,
      false,
    )
    assert.equal(verdict.ok, false)
    if (!verdict.ok) {
      assert.match(verdict.message, /byte length does not match/)
      assert.match(verdict.message, /LF-normalized|CRLF/)
    }
  })
})
