import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sanitizeAcquisitionUrl } from './sourceAcquisitionDiagnostics.js'

describe('sourceAcquisitionDiagnostics', () => {
  it('sanitizeAcquisitionUrl strips credentials from attempted URLs', () => {
    const sanitized = sanitizeAcquisitionUrl('https://user:secret@example.test/path')
    assert.equal(sanitized, 'https://example.test/path')
    assert.doesNotMatch(sanitized, /secret/)
  })
})
