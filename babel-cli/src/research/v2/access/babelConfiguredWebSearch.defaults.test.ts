import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  DEFAULT_RESEARCH_WEB_SEARCH_PROVIDER_ID,
  DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID,
  EXA_LITE_SEARCH_PROVIDER_ID,
  resolveProductionSearchProviderId,
} from './babelConfiguredWebSearch.js'
import { createAdmittedSourceSearchProvider } from './createAdmittedSourceSearchProvider.js'

const SAMPLE_HTML = [
  '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Fgthgomez%2FBabel&amp;rut=abc">Babel repo</a>',
].join('\n')

describe('babel configured web search defaults (offline)', () => {
  it('resolveProductionSearchProviderId defaults to exa_lite when unset', () => {
    assert.equal(resolveProductionSearchProviderId({}), EXA_LITE_SEARCH_PROVIDER_ID)
    assert.equal(DEFAULT_RESEARCH_WEB_SEARCH_PROVIDER_ID, EXA_LITE_SEARCH_PROVIDER_ID)
  })

  it('resolveProductionSearchProviderId honors explicit duckduckgo_html_fallback override', () => {
    assert.equal(
      resolveProductionSearchProviderId({ BABEL_WEB_SEARCH_PROVIDER: 'duckduckgo_html_fallback' }),
      DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID,
    )
  })

  it('missing EXA_API_KEY degrades to DDG with truthful receipt (no Exa HTTP)', async () => {
    let duckCalls = 0
    const resolved = createAdmittedSourceSearchProvider({
      mode: 'babel_configured_web',
      mission: exampleTechnicalMissionFixture,
      env: {},
      webSearchTransport: async () => {
        duckCalls += 1
        return { ok: true, status: 200, html: SAMPLE_HTML }
      },
    })
    assert.equal(resolved.configuredProviderId, EXA_LITE_SEARCH_PROVIDER_ID)
    const result = await resolved.provider.search(
      {
        operationId: 'missing-key-fallback',
        query: 'babel',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(duckCalls, 1)
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.receipt?.configured_provider_id, EXA_LITE_SEARCH_PROVIDER_ID)
      assert.equal(result.receipt?.effective_provider_id, DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID)
      assert.equal(result.receipt?.exa_participation, 'exa_degraded_fallback')
      assert.ok(result.receipt?.degradation?.reason.includes('exa_failed'))
    }
  })
})
