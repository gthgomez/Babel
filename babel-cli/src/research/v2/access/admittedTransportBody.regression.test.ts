/**
 * B-owned gzip decoder regressions (contract). Exercises reconciliation candidate
 * `admittedTransportBody.ts` until Agent A publishes the shared transport decoder;
 * then point `gzipDecoderRegressionTarget` at A's export (see reconciliation doc).
 */
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { decodeAdmittedUtf8Bytes } from '../adapters/documents/plainTextFromAdmittedBytes.js'
import { buildAdmittedContent } from '../adapters/documents/testAdmittedFixtures.js'
import {
  contentEncodingIncludesGzip,
  expandAdmittedTransportBody,
} from './admittedTransportBody.js'

const signal = () => new AbortController().signal

describe('gzip decoder regressions (B contract; A reconciles implementation)', () => {
  it('contentEncodingIncludesGzip matches header tokens only', () => {
    assert.equal(contentEncodingIncludesGzip('gzip'), true)
    assert.equal(contentEncodingIncludesGzip('GZIP, identity'), true)
    assert.equal(contentEncodingIncludesGzip(null), false)
    assert.equal(contentEncodingIncludesGzip('br'), false)
  })

  it('valid gzip HTML decompresses to fatal-UTF-8-valid admitted bytes', () => {
    const html = '<html><body><h1>Stable</h1><p>ok</p></body></html>'
    const wire = gzipSync(Buffer.from(html, 'utf8'))
    const expanded = expandAdmittedTransportBody({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecompressedBytes: 200_000,
      signal: signal(),
    })
    assert.equal(expanded.status, 'ok')
    if (expanded.status !== 'ok') return
    assert.equal(expanded.contentEncodingApplied, 'gzip')
    assert.equal(expanded.body.toString('utf8'), html)
    const admitted = buildAdmittedContent(
      'op-gzip-ok',
      'src-web',
      'rev-gzip-ok',
      expanded.body,
      'text/html',
    )
    decodeAdmittedUtf8Bytes(admitted)
  })

  it('malformed gzip fails decompression', () => {
    const corrupt = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff])
    const result = expandAdmittedTransportBody({
      wireBytes: corrupt,
      contentEncodingHeader: 'gzip',
      maxDecompressedBytes: 200_000,
      signal: signal(),
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'extraction_failed')
      assert.equal(result.message, 'gzip body could not be decompressed')
    }
  })

  it('decoded-size limit enforced after gzip expansion', () => {
    const html = `<html><body><h1>x</h1>${'y'.repeat(500)}</body></html>`
    const wire = gzipSync(Buffer.from(html, 'utf8'))
    const result = expandAdmittedTransportBody({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecompressedBytes: 32,
      signal: signal(),
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'extraction_failed')
      assert.equal(result.message, 'decompressed body exceeds admitted size limit')
    }
  })

  it('honours cancellation before decompress', () => {
    const controller = new AbortController()
    controller.abort()
    const wire = gzipSync(Buffer.from('<html></html>', 'utf8'))
    const result = expandAdmittedTransportBody({
      wireBytes: wire,
      contentEncodingHeader: 'gzip',
      maxDecompressedBytes: 200_000,
      signal: controller.signal,
    })
    assert.equal(result.status, 'cancelled')
  })

  it('passes through wire bytes when Content-Encoding omits gzip', () => {
    const plain = Buffer.from('plain', 'utf8')
    const result = expandAdmittedTransportBody({
      wireBytes: plain,
      contentEncodingHeader: null,
      maxDecompressedBytes: 10_000,
      signal: signal(),
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.body.toString('utf8'), 'plain')
      assert.equal(result.contentEncodingApplied, null)
    }
  })
})
