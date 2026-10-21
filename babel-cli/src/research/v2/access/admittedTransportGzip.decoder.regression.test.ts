/**
 * Gzip wire decoder regressions — run only when Agent A publishes shared transport API.
 */
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { decodeAdmittedUtf8Bytes } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from '../adapters/documents/testAdmittedFixtures.js'
import {
  contentEncodingIncludesGzip,
  DEFAULT_MAX_DECODED_ADMISSION_BYTES,
  type ExpandGzipWireAdmission,
} from './admittedTransportContract.js'
import { loadAgentAGzipWireAdmission } from './admittedTransportRegressionTarget.js'

const expand: ExpandGzipWireAdmission | null = await loadAgentAGzipWireAdmission()
const describeDecoder = expand ? describe : describe.skip

const signal = () => new AbortController().signal

describeDecoder('Agent A gzip wire admission (decoder regressions)', () => {
  it('contentEncodingIncludesGzip matches header tokens only', () => {
    assert.equal(contentEncodingIncludesGzip('gzip'), true)
    assert.equal(contentEncodingIncludesGzip('GZIP, identity'), true)
    assert.equal(contentEncodingIncludesGzip(null), false)
    assert.equal(contentEncodingIncludesGzip('br'), false)
  })

  it('valid gzip HTML decompresses to fatal-UTF-8-valid admitted bytes', () => {
    const html = '<html><body><h1>Stable</h1><p>ok</p></body></html>'
    const wire = gzipSync(Buffer.from(html, 'utf8'))
    const expanded = expand!({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: DEFAULT_MAX_DECODED_ADMISSION_BYTES,
      signal: signal(),
    })
    assert.equal(expanded.status, 'ok')
    if (expanded.status !== 'ok') return
    assert.equal(expanded.contentEncodingApplied, 'gzip')
    assert.equal(expanded.body.toString('utf8'), html)
    assert.equal(expanded.truncated, false)
    decodeAdmittedUtf8Bytes(
      buildAdmittedContent('op-gzip-ok', 'src-web', 'rev-gzip-ok', expanded.body, 'text/html'),
    )
  })

  it('malformed gzip fails decompression', () => {
    const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff])
    const result = expand!({
      wireBytes: corrupt,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: DEFAULT_MAX_DECODED_ADMISSION_BYTES,
      signal: signal(),
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'extraction_failed')
      assert.match(result.message, /decompress|gzip/i)
    }
  })

  it('encoded-size bound rejects tiny maxDecodedBytes', () => {
    const html = `<html><body><h1>x</h1>${'y'.repeat(500)}</body></html>`
    const wire = gzipSync(Buffer.from(html, 'utf8'))
    const result = expand!({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: 32,
      signal: signal(),
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'extraction_failed')
    }
  })

  it('honours cancellation before decompress', () => {
    const controller = new AbortController()
    controller.abort()
    const wire = gzipSync(Buffer.from('<html></html>', 'utf8'))
    const result = expand!({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: DEFAULT_MAX_DECODED_ADMISSION_BYTES,
      signal: controller.signal,
    })
    assert.equal(result.status, 'cancelled')
  })

  it('passes through wire bytes when Content-Encoding omits gzip', () => {
    const plain = Buffer.from('plain', 'utf8')
    const result = expand!({
      wireBytes: plain,
      contentEncodingHeader: null,
      maxDecodedBytes: 10_000,
      signal: signal(),
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.body.toString('utf8'), 'plain')
      assert.equal(result.contentEncodingApplied, null)
      assert.equal(result.truncated, false)
    }
  })
})
