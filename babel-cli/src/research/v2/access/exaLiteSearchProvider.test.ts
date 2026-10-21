import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exampleTechnicalMissionFixture } from '../fixtures/exampleMission.js'
import {
  EXA_LITE_API_HOSTNAME,
  type AdmittedExaLiteHttpsPostDispatch,
} from './admittedExaLiteHttpsPost.js'
import {
  createAdmittedSourceSearchProvider,
} from './createAdmittedSourceSearchProvider.js'
import {
  createBabelConfiguredWebSearchProvider,
  DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID,
  EXA_LITE_SEARCH_PROVIDER_ID,
  resolveProductionSearchProviderId,
} from './babelConfiguredWebSearch.js'
import { createExaLiteSearchProvider } from './exaLiteSearchProvider.js'
import {
  ExaLiteResponseValidationError,
  validateExaLiteSearchResponseBody,
} from './exaLiteSearchResponseValidation.js'

const SAMPLE_HTML = [
  '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fgithub.com%2Fgthgomez%2FBabel&amp;rut=abc">Babel repo</a>',
].join('\n')

function exaSuccessBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    requestId: 'req-test-1',
    resolvedSearchType: 'lite',
    warnings: ['relaxed-domain'],
    notices: ['cached-only'],
    costDollars: { total: 0.001 },
    results: [
      {
        title: 'Babel',
        url: 'https://github.com/gthgomez/Babel',
        highlights: ['monorepo research harness'],
      },
      {
        title: 'Blocked',
        url: 'https://evil.example/phish',
        highlights: ['nope'],
      },
    ],
    ...overrides,
  })
}

function fakeExaPost(
  handler: (params: {
    headers: Record<string, string>
    body: Record<string, unknown>
    url: URL
  }) => { status: number; bodyText: string },
): AdmittedExaLiteHttpsPostDispatch {
  return async (params) => {
    const parsed = JSON.parse(params.body) as Record<string, unknown>
    const out = handler({ headers: params.headers, body: parsed, url: params.url })
    return { status: out.status, headers: {}, bodyText: out.bodyText }
  }
}

describe('exa lite search provider (fake transport)', () => {
  it('resolveProductionSearchProviderId accepts explicit exa_lite', () => {
    assert.equal(
      resolveProductionSearchProviderId({ BABEL_WEB_SEARCH_PROVIDER: 'exa_lite' }),
      EXA_LITE_SEARCH_PROVIDER_ID,
    )
  })

  it('factory selects exa_lite when configured', () => {
    const resolved = createAdmittedSourceSearchProvider({
      mode: 'babel_configured_web',
      mission: exampleTechnicalMissionFixture,
      env: { BABEL_WEB_SEARCH_PROVIDER: 'exa_lite', EXA_API_KEY: 'test-key' },
      exaLiteTransport: {
        post: fakeExaPost(() => ({ status: 200, bodyText: exaSuccessBody() })),
      },
      webSearchTransport: async () => ({ ok: true, status: 200, html: SAMPLE_HTML }),
    })
    assert.equal(resolved.configuredProviderId, EXA_LITE_SEARCH_PROVIDER_ID)
  })

  it('posts lite contract with includeDomains and highlights; normalizes provenance', async () => {
    let seen: { headers: Record<string, string>; body: Record<string, unknown>; host: string } | null =
      null
    const provider = createExaLiteSearchProvider({
      resolveApiKey: () => 'secret-key',
      transport: {
        post: fakeExaPost(({ headers, body, url }) => {
          seen = { headers, body, host: url.hostname }
          return { status: 200, bodyText: exaSuccessBody() }
        }),
      },
    })
    const result = await provider.search(
      {
        operationId: 'op-1',
        query: 'babel research',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.ok(seen)
    assert.equal(seen!.host, EXA_LITE_API_HOSTNAME)
    assert.equal(seen!.headers['x-api-key'], 'secret-key')
    assert.equal(seen!.body.type, 'lite')
    assert.equal(seen!.body.query, 'babel research')
    assert.ok(Array.isArray(seen!.body.includeDomains))
    assert.ok((seen!.body.contents as { highlights?: unknown }).highlights)
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.hits.length, 1)
      assert.match(result.hits[0]?.snippet ?? '', /monorepo/)
      assert.equal(result.receipt?.exa_lite?.request_id, 'req-test-1')
      assert.equal(result.receipt?.exa_lite?.resolved_search_type, 'lite')
      assert.equal(result.receipt?.exa_participation, 'exa_primary_ok')
    }
  })

  it('host-enforces allowed domains even when Exa returns out-of-policy URLs', async () => {
    const provider = createExaLiteSearchProvider({
      resolveApiKey: () => 'k',
      transport: {
        post: fakeExaPost(() => ({
          status: 200,
          bodyText: exaSuccessBody({
            results: [{ title: 'Evil', url: 'https://evil.example/x', highlights: ['x'] }],
          }),
        })),
      },
    })
    const result = await provider.search(
      {
        operationId: 'op-2',
        query: 'x',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.hits.length, 0)
    }
  })

  it('fails closed without EXA_API_KEY (no credential value in message)', async () => {
    const provider = createExaLiteSearchProvider({
      resolveApiKey: () => null,
      transport: { post: fakeExaPost(() => ({ status: 200, bodyText: '{}' })) },
    })
    const result = await provider.search(
      {
        operationId: 'op-3',
        query: 'q',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'search_provider_unavailable')
      assert.doesNotMatch(result.message, /secret|x-api-key/i)
    }
  })

  it('maps auth and rate-limit without echoing credential headers', async () => {
    for (const status of [401, 403, 429, 500]) {
      const provider = createExaLiteSearchProvider({
        resolveApiKey: () => 'k',
        transport: { post: fakeExaPost(() => ({ status, bodyText: '{"error":"nope"}' })) },
      })
      const result = await provider.search(
        {
          operationId: `op-${status}`,
          query: 'q',
          sourceClasses: ['web'],
          signal: new AbortController().signal,
        },
        exampleTechnicalMissionFixture,
      )
      assert.equal(result.status, 'failed')
      if (result.status === 'failed') {
        assert.doesNotMatch(result.message, /x-api-key|EXA_API_KEY|secret/i)
        if (status === 429) assert.equal(result.failureCategory, 'rate_limited')
      }
    }
  })

  it('treats malformed HTTP 200 as failed validation (not silent empty)', async () => {
    const provider = createExaLiteSearchProvider({
      resolveApiKey: () => 'k',
      transport: { post: fakeExaPost(() => ({ status: 200, bodyText: 'not-json' })) },
    })
    const result = await provider.search(
      {
        operationId: 'malformed',
        query: 'q',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.failureCategory, 'extraction_failed')
    }
    assert.throws(() => validateExaLiteSearchResponseBody('{}'), ExaLiteResponseValidationError)
  })

  it('cancels before await and after transport (pre/post cancel)', async () => {
    const provider = createExaLiteSearchProvider({
      resolveApiKey: () => 'k',
      transport: {
        post: async (params) => {
          await new Promise((r) => setTimeout(r, 30))
          if (params.signal.aborted) {
            return { status: 499, headers: {}, bodyText: '{}' }
          }
          return { status: 200, headers: {}, bodyText: exaSuccessBody() }
        },
      },
    })
    const pre = new AbortController()
    pre.abort()
    const preResult = await provider.search(
      {
        operationId: 'pre',
        query: 'q',
        sourceClasses: ['web'],
        signal: pre.signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(preResult.status, 'cancelled')

    const post = new AbortController()
    const postPromise = provider.search(
      {
        operationId: 'post',
        query: 'q',
        sourceClasses: ['web'],
        signal: post.signal,
      },
      exampleTechnicalMissionFixture,
    )
    post.abort()
    const postResult = await postPromise
    assert.equal(postResult.status, 'cancelled')
  })

  it('credential is only sent to api.exa.ai (redirect host rejected)', async () => {
    let requestHost = ''
    const provider = createExaLiteSearchProvider({
      resolveApiKey: () => 'k',
      transport: {
        post: async (params) => {
          requestHost = params.url.hostname
          return {
            status: 302,
            headers: { location: 'https://evil.example/steal' },
            bodyText: '',
          }
        },
      },
    })
    const result = await provider.search(
      {
        operationId: 'redir',
        query: 'q',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(requestHost, EXA_LITE_API_HOSTNAME)
    assert.equal(result.status, 'failed')
  })

  it('preserves billed-empty Exa receipt when DDG fallback fails', async () => {
    const configured = createBabelConfiguredWebSearchProvider({
      providerId: EXA_LITE_SEARCH_PROVIDER_ID,
      env: { EXA_API_KEY: 'k' },
      exaLiteTransport: {
        post: fakeExaPost(() => ({
          status: 200,
          bodyText: JSON.stringify({
            requestId: 'billed-empty',
            costDollars: { total: 0.002 },
            results: [],
          }),
        })),
      },
      webSearchTransport: async () => ({ ok: false, status: 503, html: '' }),
    })
    const result = await configured.search(
      {
        operationId: 'billed-empty',
        query: 'babel research',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.receipt?.exa_lite?.request_id, 'billed-empty')
      assert.equal(result.receipt?.exa_participation, 'exa_degraded_fallback')
      assert.match(result.receipt?.degradation?.reason ?? '', /exa_empty_billed/)
    }
  })

  it('degrades to duckduckgo with explicit receipt when Exa returns zero hits', async () => {
    const configured = createBabelConfiguredWebSearchProvider({
      providerId: EXA_LITE_SEARCH_PROVIDER_ID,
      env: { EXA_API_KEY: 'k' },
      exaLiteTransport: {
        post: fakeExaPost(() => ({ status: 200, bodyText: JSON.stringify({ results: [] }) })),
      },
      webSearchTransport: async () => ({ ok: true, status: 200, html: SAMPLE_HTML }),
    })
    const result = await configured.search(
      {
        operationId: 'deg',
        query: 'babel research',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') {
      assert.equal(result.hits.length, 1)
      assert.equal(result.receipt?.configured_provider_id, EXA_LITE_SEARCH_PROVIDER_ID)
      assert.equal(result.receipt?.effective_provider_id, DUCKDUCKGO_HTML_FALLBACK_PROVIDER_ID)
      assert.match(result.receipt?.degradation?.reason ?? '', /exa_zero_hits/)
    }
  })

  it('never logs api key in transport errors', async () => {
    const provider = createExaLiteSearchProvider({
      resolveApiKey: () => 'super-secret-key-value',
      transport: {
        post: async () => {
          throw new Error('transport exploded with super-secret-key-value')
        },
      },
    })
    const result = await provider.search(
      {
        operationId: 'err',
        query: 'q',
        sourceClasses: ['web'],
        signal: new AbortController().signal,
      },
      exampleTechnicalMissionFixture,
    )
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.doesNotMatch(result.message, /super-secret/)
    }
  })
})
