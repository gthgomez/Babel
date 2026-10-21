import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AdmittedSourceSearchProvider } from '../ports/admittedSourceSearchProvider.js'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { technicalRepositoryCorpusSource } from '../fixtures/technicalRepositoryCorpus.js'
import { createDeclaredIndexCorpusSearchProvider } from './declaredIndexCorpusSearchProvider.js'
import { createGovernedSourceAccessPort } from './governedSourceAccessPort.js'

describe('GovernedSourceAccessPort', () => {
  it('routes search through injected AdmittedSourceSearchProvider', async () => {
    const provider: AdmittedSourceSearchProvider = {
      async search(request) {
        return {
          operationId: request.operationId,
          status: 'ok',
          hits: [
            {
              source: technicalRepositoryCorpusSource,
              snippet: 'injected-provider-hit',
              completeness: 'snippet',
            },
          ],
        }
      },
    }
    const port = createGovernedSourceAccessPort({
      mission: exampleTechnicalMissionFixture,
      searchProvider: provider,
      admittedGet: async () => ({
        ok: true,
        status: 200,
        contentType: 'text/plain',
        buffer: Buffer.from('x', 'utf8'),
        bytesReceived: 1,
        truncated: false,
        requestedUrl: technicalRepositoryCorpusSource.observed_urls[0]!,
        finalUrl: technicalRepositoryCorpusSource.observed_urls[0]!,
        redirectChain: [technicalRepositoryCorpusSource.observed_urls[0]!],
        transportCoding: null,
      }),
    })
    const search = await port.search({
      operationId: 'inj-search',
      query: 'any',
      sourceClasses: ['repository_file'],
      signal: new AbortController().signal,
    })
    assert.equal(search.status, 'ok')
    if (search.status === 'ok') {
      assert.equal(search.hits[0]?.snippet, 'injected-provider-hit')
    }
  })

  it('declared-index corpus provider is not open-web discovery', async () => {
    const port = createGovernedSourceAccessPort({
      mission: exampleTechnicalMissionFixture,
      searchProvider: createDeclaredIndexCorpusSearchProvider([]),
    })
    const search = await port.search({
      operationId: 'empty-index',
      query: 'nohits',
      sourceClasses: ['repository_file'],
      signal: new AbortController().signal,
    })
    assert.equal(search.status, 'ok')
    if (search.status === 'ok') {
      assert.equal(search.hits.length, 0)
    }
  })
})
