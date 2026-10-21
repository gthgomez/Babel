import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPinnedRepositoryFileSearchProvider } from './pinnedRepositoryFileSearchProvider.js'
import { TechnicalRepositoryFileAdapter } from '../profiles/technical/repositoryFileAdapter.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { createGovernedSourceAccessPort } from './governedSourceAccessPort.js'

const corpusPath = 'babel-cli/src/research/v2/contracts/version.ts'
const corpusBody = 'export const RESEARCH_CONTRACT = 1\n'

describe('pinned repository discovery → raw fetch → technical read', () => {
  it('uses raw.githubusercontent.com for fetch while retaining blob provenance', async () => {
    const mission = exampleTechnicalMissionFixture
    const searchProvider = createPinnedRepositoryFileSearchProvider({
      fetchTree: async () => ({
        ok: true,
        status: 200,
        entries: [{ path: corpusPath, type: 'blob' }],
      }),
    })
    const discovered = await searchProvider.search(
      {
        operationId: 'discover-op',
        query: 'version.ts',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      mission,
    )
    assert.equal(discovered.status, 'ok')
    const source = discovered.status === 'ok' ? discovered.hits[0]?.source : undefined
    assert.ok(source)
    assert.match(source!.observed_urls[0] ?? '', /github\.com\/.*\/blob\/[a-f0-9]{40}\//)

    let fetchedUrl = ''
    const access = createGovernedSourceAccessPort({
      mission,
      searchProvider,
      admittedGet: async (params) => {
        fetchedUrl = params.url
        return {
          ok: true,
          status: 200,
          contentType: 'text/plain',
          buffer: Buffer.from(corpusBody, 'utf8'),
          bytesReceived: corpusBody.length,
          truncated: false,
          requestedUrl: params.url,
          finalUrl: params.url,
          redirectChain: [params.url],
        }
      },
    })

    const adapter = new TechnicalRepositoryFileAdapter()
    const read = await adapter.read(
      {
        operationId: 'read-op',
        source: source!,
        signal: new AbortController().signal,
      },
      access,
    )
    assert.equal(read.status, 'ok')
    assert.match(fetchedUrl, /^https:\/\/raw\.githubusercontent\.com\//)
    if (read.status === 'ok') {
      assert.ok(
        read.passages.some(
          (p) => p.text_ref.mode === 'inline' && p.text_ref.text.includes('RESEARCH_CONTRACT'),
        ),
      )
    }
  })
})
