import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { decodeAdmittedHttpBody, AdmittedContentCodingError } from './admittedHttpContentCoding.js'

describe('decodeAdmittedHttpBody', () => {
  it('decodes gzip Content-Encoding into admitted UTF-8 HTML bytes', async () => {
    const html = '<!doctype html><html><body>python downloads</body></html>'
    const encoded = gzipSync(Buffer.from(html, 'utf8'))
    assert.equal(encoded[0], 0x1f)
    assert.equal(encoded[1], 0x8b)

    const result = await decodeAdmittedHttpBody({
      encodedBody: encoded,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: 1_000_000,
      signal: new AbortController().signal,
    })
    assert.equal(result.buffer.toString('utf8'), html)
    assert.ok(result.transportCoding)
    assert.deepEqual(result.transportCoding?.content_encodings, ['gzip'])
    assert.equal(result.transportCoding?.encoded_byte_length, encoded.byteLength)
    assert.equal(result.transportCoding?.decoded_byte_length, Buffer.byteLength(html, 'utf8'))
  })

  it('truthfully truncates decoded gzip at 200000-byte host cap for 218649-byte HTML-scale bodies', async () => {
    const PYTHON_HTML_DECODED_BYTES = 218_649
    const HOST_CAP = 200_000
    const full = Buffer.alloc(PYTHON_HTML_DECODED_BYTES, 0x61)
    const encoded = gzipSync(full)

    const result = await decodeAdmittedHttpBody({
      encodedBody: encoded,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: HOST_CAP,
      signal: new AbortController().signal,
    })
    assert.equal(result.decodedTruncated, true)
    assert.equal(result.transportCoding?.decoded_byte_length, PYTHON_HTML_DECODED_BYTES)
    assert.equal(result.transportCoding?.decoded_truncated, true)
    assert.equal(result.transportCoding?.admitted_decoded_byte_length, result.buffer.byteLength)
    assert.ok(result.buffer.byteLength <= HOST_CAP)
    new TextDecoder('utf-8', { fatal: true }).decode(result.buffer)
  })

  it('rejects unsupported br encoding', async () => {
    await assert.rejects(
      () =>
        decodeAdmittedHttpBody({
          encodedBody: Buffer.from('x'),
          contentEncodingHeader: 'br',
          maxDecodedBytes: 100,
          signal: new AbortController().signal,
        }),
      (err: unknown) => {
        assert.ok(err instanceof AdmittedContentCodingError)
        assert.equal(err.code, 'unsupported_encoding')
        return true
      },
    )
  })
})
