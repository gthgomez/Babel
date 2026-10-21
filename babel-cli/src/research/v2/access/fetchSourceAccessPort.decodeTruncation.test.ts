import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { describe, it } from 'node:test'
import { SourceRecordSchema } from '../contracts/sources.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'

describe('FetchSourceAccessPort decoded-byte truncation', () => {
  it('admits UTF-8-safe prefix with host_decoded_byte_limit metadata through admittedHttpGet', async () => {
    const decodedTotal = 218_649
    const cap = 200_000
    const full = Buffer.alloc(decodedTotal, 0x61)
    const wire = gzipSync(full)
    const url = 'https://www.python.org/downloads/'

    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: cap,
      dispatchGet: async () => ({
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-encoding': 'gzip',
        },
        body: { buffer: wire, bytesReceived: wire.byteLength, truncated: false },
      }),
    })

    const source = SourceRecordSchema.parse({
      source_id: 'src-python-downloads',
      kind: 'web',
      title: 'Python downloads',
      observed_urls: [url],
      canonical_key: 'web:python.org/downloads',
    })

    const result = await port.fetchContent({
      operationId: 'fetch-python',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.admitted.revision.completeness, 'truncated')
      assert.equal(result.admitted.revision.truncation_reason, 'host_decoded_byte_limit')
      assert.equal(result.admitted.truncation?.bytes_limit, cap)
      assert.equal(result.admitted.provenance.http_content_coding?.decoded_truncated, true)
      assert.equal(
        result.admitted.provenance.http_content_coding?.decoded_byte_length_is_lower_bound,
        true,
      )
      assert.ok((result.admitted.truncation?.bytes_received ?? 0) >= cap)
      assert.ok((result.admitted.provenance.http_content_coding?.decoded_byte_length ?? 0) >= cap)
      const admitted = Buffer.from(result.admitted.payload.bytes_base64, 'base64')
      assert.ok(admitted.byteLength <= cap)
      new TextDecoder('utf-8', { fatal: true }).decode(admitted)
    }
  })
})
