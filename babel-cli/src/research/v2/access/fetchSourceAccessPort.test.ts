import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SourceRecordSchema } from '../contracts/sources.js'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'

describe('FetchSourceAccessPort', () => {
  it('fetches admitted bytes for observed URL via injected admittedGet', async () => {
    const body = 'export const X = 1\n'
    const port = new FetchSourceAccessPort({
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/plain',
        buffer: Buffer.from(body, 'utf8'),
        bytesReceived: body.length,
        truncated: false,
        requestedUrl: raw,
        finalUrl: raw,
        redirectChain: [raw],
      }),
    })
    const sha = 'd9e42b14b00b6dba25f0415ae16b084363386a01'
    const blob = `https://github.com/gthgomez/Babel/blob/${sha}/babel-cli/src/research/contracts.ts`
    const raw = `https://raw.githubusercontent.com/gthgomez/Babel/${sha}/babel-cli/src/research/contracts.ts`
    const source = SourceRecordSchema.parse({
      source_id: 'src-1',
      kind: 'repository_file',
      title: 't',
      observed_urls: [blob],
      canonical_identifiers: {
        github_repo_id: 'github:gthgomez/Babel',
        github_commit_sha: sha,
      },
      canonical_key: 'github:gthgomez/Babel:babel-cli/src/research/contracts.ts',
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
      assert.equal(result.admitted.provenance.final_url, blob)
      assert.deepEqual(result.admitted.provenance.redirect_chain, [blob])
    }
  })

  it('search fails closed with not_supported', async () => {
    const port = new FetchSourceAccessPort({
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/plain',
        buffer: Buffer.alloc(0),
        bytesReceived: 0,
        truncated: false,
        requestedUrl: 'https://example.test',
        finalUrl: 'https://example.test',
        redirectChain: ['https://example.test'],
      }),
    })
    const result = await port.search({
      operationId: 's-1',
      query: 'q',
      sourceClasses: ['repository_file'],
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
  })
})
