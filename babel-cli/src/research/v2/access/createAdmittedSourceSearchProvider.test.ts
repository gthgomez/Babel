import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import { technicalRepositorySearchIndex } from '../fixtures/technicalSearchIndex.js'
import {
  buildDuckDuckGoHtmlSearchUrl,
  DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID,
  resolveProductionSearchProviderId,
} from './babelConfiguredWebSearch.js'
import { createAdmittedSourceSearchProvider } from './createAdmittedSourceSearchProvider.js'

const SAMPLE_HTML = [
  '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Fgthgomez%2FBabel&amp;rut=abc">Babel repo</a>',
  '<a class="result__a" href="https://evil.example/phish">Blocked domain</a>',
].join('\n')

describe('createAdmittedSourceSearchProvider', () => {
  it('production mode selects exa_lite composite by default', () => {
    const resolved = createAdmittedSourceSearchProvider({
      mode: 'babel_configured_web',
      mission: exampleTechnicalMissionFixture,
      webSearchTransport: async () => ({ ok: true, status: 200, html: SAMPLE_HTML }),
      env: { EXA_API_KEY: 'test-key' },
      exaLiteTransport: {
        post: async () => ({
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            requestId: 'offline',
            results: [
              {
                title: 'Babel',
                url: 'https://github.com/gthgomez/Babel',
                highlights: ['repo'],
              },
            ],
          }),
        }),
      },
    })
    assert.equal(resolved.configuredProviderId, 'exa_lite')
    assert.ok(resolved.limitations.join(' ').includes('degrades_to_duckduckgo'))
  })

  it('resolveProductionSearchProviderId rejects unknown explicit override', () => {
    assert.equal(resolveProductionSearchProviderId({ BABEL_WEB_SEARCH_PROVIDER: 'unknown_vendor' }), null)
  })

  it('duckduckgo_html_fallback override uses injected transport only', async () => {
    let seenUrl = ''
    const resolved = createAdmittedSourceSearchProvider({
      mode: 'babel_configured_web',
      mission: exampleTechnicalMissionFixture,
      env: { BABEL_WEB_SEARCH_PROVIDER: 'duckduckgo_html_fallback' },
      webSearchTransport: async ({ searchUrl }) => {
        seenUrl = searchUrl
        return { ok: true, status: 200, html: SAMPLE_HTML }
      },
    })
    const result = await resolved.provider.search(
      {
        operationId: 'web-search-1',
        query: 'babel research',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.match(seenUrl, /^https:\/\/duckduckgo\.com\/html\/\?q=/)
    assert.equal(seenUrl, buildDuckDuckGoHtmlSearchUrl('babel research'))
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.hits.length, 1)
      assert.equal(result.hits[0]?.source.kind, 'web')
      assert.match(result.hits[0]?.source.observed_urls[0] ?? '', /^https:\/\/github\.com\//)
    }
  })

  it('corpus mode uses declared index without web transport', async () => {
    const resolved = createAdmittedSourceSearchProvider({
      mode: 'declared_index_corpus',
      mission: exampleTechnicalMissionFixture,
      corpusIndex: technicalRepositorySearchIndex(),
    })
    assert.equal(resolved.configuredProviderId, null)
    const result = await resolved.provider.search(
      {
        operationId: 'corpus-search',
        query: 'RESEARCH_CONTRACT',
        sourceClasses: ['repository_file'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.hits.length, 1)
    }
  })
})
