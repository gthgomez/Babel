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
