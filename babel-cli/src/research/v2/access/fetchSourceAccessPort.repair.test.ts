import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceRecordSchema } from '../contracts/sources.js'
import { admittedHttpGet } from './admittedHttpGet.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'

const source = SourceRecordSchema.parse({
  source_id: 'src-repair',
  kind: 'web',
  title: 't',
  observed_urls: ['http://127.0.0.1:9/private'],
  canonical_key: 'web:127.0.0.1/private',
})

describe('FetchSourceAccessPort M1.3 review repairs', () => {
  it('blocks loopback targets through admitted network boundary', async () => {
    const port = new FetchSourceAccessPort()
    const result = await port.fetchContent({
      operationId: 'fetch-loopback',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'private_address_blocked')
    }
  })

  it('records final URL after redirect rather than requested URL only', async () => {
    const port = new FetchSourceAccessPort({
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/plain',
        buffer: Buffer.from('ok', 'utf8'),
        bytesReceived: 2,
        truncated: false,
        requestedUrl: 'https://example.test/a',
        finalUrl: 'https://cdn.example.test/b',
        redirectChain: ['https://example.test/a', 'https://cdn.example.test/b'],
        transportCoding: null,
      }),
    })
    const result = await port.fetchContent({
      operationId: 'fetch-redirect',
      source: SourceRecordSchema.parse({
        source_id: 'src-redirect',
        kind: 'web',
        title: 't',
        observed_urls: ['https://example.test/a'],
        canonical_key: 'web:example.test/a',
      }),
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.admitted.provenance.requested_url, 'https://example.test/a')
      assert.equal(result.admitted.provenance.final_url, 'https://cdn.example.test/b')
      assert.notEqual(result.admitted.provenance.final_url, result.admitted.provenance.requested_url)
    }
  })

  it('enforces byte cap during admittedGet (no full-body buffer beyond limit)', async () => {
    let requestedMax = 0
    const port = new FetchSourceAccessPort({
      maxAdmittedBytes: 4,
      admittedGet: async (params) => {
        requestedMax = params.maxBytes
        return {
          ok: true,
          status: 200,
          contentType: 'text/plain',
          buffer: Buffer.from('abcd', 'utf8'),
          bytesReceived: 100_000,
          truncated: true,
          requestedUrl: 'https://example.test/big',
          finalUrl: 'https://example.test/big',
          redirectChain: ['https://example.test/big'],
          transportCoding: null,
        }
      },
    })
    const result = await port.fetchContent({
      operationId: 'fetch-cap',
      source: SourceRecordSchema.parse({
        source_id: 'src-cap',
        kind: 'web',
        title: 't',
        observed_urls: ['https://example.test/big'],
        canonical_key: 'web:example.test/big',
      }),
      signal: new AbortController().signal,
    })
    assert.equal(requestedMax, 4)
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.admitted.payload.byte_length, 4)
      assert.equal(result.admitted.truncation?.bytes_received, 100_000)
      assert.equal(result.admitted.truncation?.bytes_limit, 4)
    }
  })
})

describe('admittedHttpGet streaming contract', () => {
  it('rejects private addresses without BABEL_WEB_ALLOW_PRIVATE', async () => {
    await assert.rejects(
      () =>
        admittedHttpGet({
          url: 'http://127.0.0.1:9/x',
          maxBytes: 1024,
          signal: new AbortController().signal,
          env: { BABEL_WEB_ALLOW_PRIVATE: undefined },
        }),
      /Private network|localhost/i,
    )
  })
})
