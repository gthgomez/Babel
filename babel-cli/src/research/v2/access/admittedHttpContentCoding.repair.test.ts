import assert from 'node:assert/strict'
import { createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { decodeAdmittedHttpBody } from './admittedHttpContentCoding.js'

async function gzipBuffer(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const gzip = createGzip()
    gzip.on('data', (c) => chunks.push(c))
    gzip.on('error', reject)
    gzip.on('end', () => resolve(Buffer.concat(chunks)))
    gzip.end(payload)
  })
}

describe('admittedHttpContentCoding bounded inflate repairs', () => {
  it('stops decompressing after cap instead of processing the full oversized stream', async () => {
    const cap = 200_000
    const payload = Buffer.alloc(10_000_000, 0x61)
    const encoded = await gzipBuffer(payload)
    assert.ok(encoded.byteLength < 500_000, 'expected highly compressible payload')

    const result = await decodeAdmittedHttpBody({
      encodedBody: encoded,
      contentEncodingHeader: 'gzip',
      maxDecodedBytes: cap,
      signal: new AbortController().signal,
    })
    assert.equal(result.decodedTruncated, true)
    assert.ok(result.buffer.byteLength <= cap)
    assert.ok(result.transportCoding?.decoded_byte_length_is_lower_bound)
    assert.ok((result.transportCoding?.decoded_byte_length ?? 0) < 1_000_000)
    assert.ok((result.transportCoding?.decoded_byte_length ?? 0) >= cap)
  })
})
