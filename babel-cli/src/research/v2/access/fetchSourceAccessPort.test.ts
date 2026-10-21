import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceRecordSchema } from '../contracts/sources.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'

describe('FetchSourceAccessPort', () => {
  it('fetches admitted bytes for observed URL', async () => {
    const body = 'export const X = 1\n'
    const port = new FetchSourceAccessPort({
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'text/plain' },
        arrayBuffer: async () => Uint8Array.from(Buffer.from(body, 'utf8')).buffer,
      }),
    })
    const source = SourceRecordSchema.parse({
      source_id: 'src-1',
      kind: 'repository_file',
      title: 't',
      observed_urls: ['https://example.test/raw/file.ts'],
      canonical_identifiers: { github_repo_id: 'github:org/repo' },
      canonical_key: 'k',
    })
    const result = await port.fetchContent({
      operationId: 'fetch-1',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(
        Buffer.from(result.admitted.payload.bytes_base64, 'base64').toString('utf8'),
        body,
      )
      assert.equal(result.admitted.operation_id, 'fetch-1')
    }
  })

  it('search fails closed with not_supported', async () => {
    const port = new FetchSourceAccessPort({ fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }) })
    const result = await port.search({
      operationId: 's-1',
      query: 'q',
      sourceClasses: ['repository_file'],
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
  })
})
