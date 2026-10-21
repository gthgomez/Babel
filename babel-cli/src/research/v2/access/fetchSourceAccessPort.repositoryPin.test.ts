import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FetchSourceAccessPort } from './fetchSourceAccessPort.js'
import { technicalRepositoryCorpusSource } from '../fixtures/technicalRepositoryCorpus.js'

describe('FetchSourceAccessPort repository_file pin transport', () => {
  it('rejects redirect hop to another repository instead of rewriting provenance', async () => {
    const source = technicalRepositoryCorpusSource
    const rawUrl = `https://raw.githubusercontent.com/gthgomez/Babel/${source.canonical_identifiers!.github_commit_sha}/babel-cli/src/research/contracts.ts`
    const otherRepoFinal = `https://raw.githubusercontent.com/OTHER/OTHER/${source.canonical_identifiers!.github_commit_sha}/babel-cli/src/research/contracts.ts`
    const port = new FetchSourceAccessPort({
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/plain',
        buffer: Buffer.from('export const RESEARCH_CONTRACT = 1\n', 'utf8'),
        bytesReceived: 32,
        truncated: false,
        requestedUrl: rawUrl,
        finalUrl: otherRepoFinal,
        redirectChain: [rawUrl, otherRepoFinal],
      transportCoding: null,
      }),
    })
    const result = await port.fetchContent({
      operationId: 'fetch-cross-repo',
      source,
      signal: new AbortController().signal,
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'policy_denied')
      assert.match(result.message, /fetch hop owner does not match/)
    }
  })
})
