import assert from 'node:assert/strict'
import test from 'node:test'

import { composeCatalogSnapshot, normalizeCatalog } from './catalog-normalize.js'
import { OPENROUTER_MODELS_URL } from './openrouterMetadata.js'
import {
  OPENROUTER_CATALOG_SOURCE,
  assertTrustedCatalogSource,
  refreshCatalog,
  resetCatalogRefreshInFlight,
} from './catalog-refresh.js'
import { createCatalogSnapshot, findModelProfile } from './catalog.js'
import type { CatalogSnapshot } from './types.js'

const BASE_TIME = '2026-10-06T00:00:00.000Z'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function previousSnapshot(): CatalogSnapshot {
  // No supported_parameters => tool support is deliberately unknown.
  const batch = normalizeCatalog({
    sourceId: 'openrouter-catalog',
    status: 'ok',
    completeness: 'complete',
    fetchedAt: BASE_TIME,
    models: [{ id: 'z-ai/glm-5.3-flash', context_length: 1_310_720 }],
  })
  return composeCatalogSnapshot(undefined, batch)
}

function newerSnapshot(): CatalogSnapshot {
  return createCatalogSnapshot({
    observedAt: '2026-10-06T00:00:01.000Z',
    sourceResults: [
      {
        sourceId: 'openrouter-catalog',
        status: 'ok',
        completeness: 'complete',
        fetchedAt: '2026-10-06T00:00:01.000Z',
      },
    ],
    labModels: [],
    providerModels: [
      {
        schemaVersion: 1,
        provider: 'openrouter',
        canonicalModelId: 'z-ai/glm-5.3-flash',
        providerModelId: 'z-ai/glm-5.3-flash',
        protocolProfiles: [],
        providerLimits: { contextTokens: 999_999 },
        lifecycle: { status: 'active' },
        sourceEvidence: [{ source: 'provider_api', retrievedAt: '2026-10-06T00:00:01.000Z' }],
        observedEvidence: [],
      },
    ],
  })
}

test('remote_metadata_cannot_change_trust', async () => {
  // An untrusted URL (http, non-allowlisted host, embedded credentials) is
  // rejected before any fetch happens.
  let untrustedFetches = 0
  const untrustedFetch: typeof fetch = async () => {
    untrustedFetches += 1
    return jsonResponse({})
  }
  await assert.rejects(
    refreshCatalog({
      source: { sourceId: 'openrouter-catalog', url: 'http://169.254.169.254/latest/meta-data' },
      fetchImpl: untrustedFetch,
    }),
    /https|trusted catalog host/i,
  )
  await assert.rejects(
    refreshCatalog({
      source: { sourceId: 'openrouter-catalog', url: 'https://evil.example/api/v1/models' },
      fetchImpl: untrustedFetch,
    }),
    /trusted catalog host/i,
  )
  await assert.rejects(
    refreshCatalog({
      source: { sourceId: 'openrouter-catalog', url: 'https://user:pass@openrouter.ai/api/v1/models' },
      fetchImpl: untrustedFetch,
    }),
    /credentials/i,
  )
  assert.equal(untrustedFetches, 0)

  const malicious = {
    data: [
      {
        id: 'z-ai/glm-5.3-flash',
        canonical_slug: 'z-ai/glm-5.3-flash',
        context_length: 1310720,
        top_provider: { context_length: 1048576, max_completion_tokens: 131072 },
        supported_parameters: ['tools'],
        endpoint: 'http://evil.example/v1',
        api_key: 'attacker-secret',
        base_url: 'https://evil.example',
        import: 'malicious-module',
      },
    ],
    endpoint: 'http://evil.example',
    api_key: 'attacker-secret',
  }
  const requestedUrls: string[] = []
  const result = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    fetchImpl: async (input) => {
      requestedUrls.push(String(input))
      return jsonResponse(malicious)
    },
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(requestedUrls, [OPENROUTER_MODELS_URL])
  const profile = result.snapshot.providerModels[0]
  assert.ok(profile)
  const serialized = JSON.stringify(result.snapshot)
  assert.doesNotMatch(serialized, /evil\.example/)
  assert.doesNotMatch(serialized, /api_key|attacker-secret|malicious-module/)
  // Endpoint remains the trusted protocol constant, never the remote value.
  assert.equal(
    profile.protocolProfiles[0]?.endpoint,
    'https://openrouter.ai/api/v1/chat/completions',
  )
  assert.equal(result.batch?.sourceResults[0]?.sourceId, 'openrouter-catalog')
})

test('failed_refresh_preserves_unknown', async () => {
  const previous = previousSnapshot()
  const before = previous.providerModels[0]
  assert.ok(before)
  assert.equal(before.protocolProfiles[0]?.tools.basicTools.state, 'unknown')

  const result = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    fetchImpl: async () => {
      throw new Error('simulated network outage')
    },
  })

  assert.equal(result.status, 'unavailable')
  assert.equal(result.preservedPrevious, true)
  assert.equal(result.superseded, false)
  const after = result.snapshot.providerModels[0]
  assert.ok(after, 'failed refresh must not remove the known model')
  assert.equal(after.protocolProfiles[0]?.tools.basicTools.state, 'unknown')
  assert.equal(after.protocolProfiles[0]?.tools.basicTools.support, 'unknown')
})

test('late_refresh_cannot_overwrite_newer', async () => {
  resetCatalogRefreshInFlight()
  const previous = previousSnapshot()
  const newer = newerSnapshot()
  let release: ((response: Response) => void) | undefined
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })

  const pending = refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    now: () => new Date(BASE_TIME),
    current: () => newer,
    fetchImpl: () => gate,
  })
  release?.(
    jsonResponse({
      data: [{ id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash', context_length: 1310720 }],
    }),
  )
  const result = await pending

  assert.equal(result.superseded, true)
  assert.equal(result.preservedPrevious, true)
  assert.equal(result.snapshot.revision, newer.revision)
  assert.equal(result.snapshot.providerModels[0]?.providerLimits.contextTokens, 999_999)
})

test('offline_start_uses_snapshot_without_network', async () => {
  resetCatalogRefreshInFlight()
  const previous = previousSnapshot()
  let fetchCalls = 0
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1
    throw new Error('offline start must not reach the network')
  }

  const forcedOffline = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    offline: true,
    fetchImpl,
  })
  assert.equal(fetchCalls, 0)
  assert.equal(forcedOffline.fromCache, true)
  assert.equal(forcedOffline.snapshot, previous)

  // Omitting a fetch implementation is the safe default: offline, no network.
  const noFetch = await refreshCatalog({ source: OPENROUTER_CATALOG_SOURCE, previous })
  assert.equal(noFetch.fromCache, true)
  assert.equal(noFetch.snapshot, previous)
  assert.equal(fetchCalls, 0)
})

test('concurrent_refresh_is_shared', async () => {
  resetCatalogRefreshInFlight()
  let fetchCalls = 0
  let release: ((response: Response) => void) | undefined
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1
    return gate
  }

  const first = refreshCatalog({ source: OPENROUTER_CATALOG_SOURCE, fetchImpl })
  const second = refreshCatalog({ source: OPENROUTER_CATALOG_SOURCE, fetchImpl })
  release?.(
    jsonResponse({
      data: [{ id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash', context_length: 1310720 }],
    }),
  )
  const [a, b] = await Promise.all([first, second])

  assert.equal(fetchCalls, 1, 'concurrent callers share one in-flight refresh')
  assert.equal(a.snapshot.revision, b.snapshot.revision)
})

test('refresh_validates_units_and_bounds_before_use', async () => {
  resetCatalogRefreshInFlight()
  const previous = previousSnapshot()
  const result = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    maxItems: 2,
    fetchImpl: async () =>
      jsonResponse({
        data: [
          {
            id: 'z-ai/glm-5.3-flash',
            canonical_slug: 'z-ai/glm-5.3-flash',
            context_length: -5,
            top_provider: { max_completion_tokens: 0 },
            pricing: { prompt: 'not-a-number', completion: '0.000001' },
            supported_parameters: ['tools'],
          },
        ],
      }),
  })

  assert.equal(result.status, 'ok')
  const profile = result.snapshot.providerModels[0]
  assert.ok(profile)
  // Invalid units are dropped with warnings rather than trusted.
  assert.equal(profile.providerLimits.maxOutputTokens, undefined)
  assert.equal(profile.pricing?.inputPerToken, undefined)
  assert.equal(profile.pricing?.outputPerToken, 0.000001)
  assert.ok(result.warnings.some((warning) => warning.includes('context_length')))
  assert.ok(result.warnings.some((warning) => warning.includes('pricing.prompt')))

  const tooMany = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    maxItems: 1,
    fetchImpl: async () =>
      jsonResponse({
        data: [{ id: 'a/b' }, { id: 'c/d' }],
      }),
  })
  assert.equal(tooMany.status, 'failed')
  assert.equal(tooMany.preservedPrevious, true)
})

test('assertTrustedCatalogSource_accepts_configured_source', () => {
  assert.equal(
    assertTrustedCatalogSource(OPENROUTER_CATALOG_SOURCE).toString(),
    'https://openrouter.ai/api/v1/models',
  )
})

test('truncated_success_payload_is_partial_and_does_not_retire', async () => {
  resetCatalogRefreshInFlight()
  // A previous authoritative snapshot knows two models.
  const previous = composeCatalogSnapshot(
    undefined,
    normalizeCatalog({
      sourceId: 'openrouter-catalog',
      status: 'ok',
      completeness: 'complete',
      fetchedAt: BASE_TIME,
      models: [
        { id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash' },
        { id: 'deepseek/deepseek-v4-pro', canonical_slug: 'deepseek/deepseek-v4-pro' },
      ],
    }),
  )
  assert.ok(
    findModelProfile(previous, { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }),
  )

  // HTTP 200 whose data array is a truncated subset, with no pagination/total
  // signal: completeness cannot be asserted, so the read must be partial.
  const result = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    fetchImpl: async () =>
      jsonResponse({
        data: [{ id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash' }],
      }),
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.completeness, 'partial', 'a 200 without a completeness signal is partial')
  assert.equal(result.batch?.completeness, 'partial')
  assert.ok(
    findModelProfile(result.snapshot, { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }),
    'a truncated 200 must not retire an unobserved model',
  )
})

test('completeness_signal_allows_authoritative_removal', async () => {
  resetCatalogRefreshInFlight()
  const previous = composeCatalogSnapshot(
    undefined,
    normalizeCatalog({
      sourceId: 'openrouter-catalog',
      status: 'ok',
      completeness: 'complete',
      fetchedAt: BASE_TIME,
      models: [
        { id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash' },
        { id: 'deepseek/deepseek-v4-pro', canonical_slug: 'deepseek/deepseek-v4-pro' },
      ],
    }),
  )

  // An explicit total count equal to the returned rows is an authoritative
  // completeness signal, so absence may mean removal.
  const result = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          total: 1,
          data: [{ id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.completeness, 'complete')
  assert.ok(findModelProfile(result.snapshot, { provider: 'openrouter', modelId: 'z-ai/glm-5.3-flash' }))
  assert.equal(
    findModelProfile(result.snapshot, { provider: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' }),
    undefined,
    'an authoritative complete read may retire an unobserved model',
  )
})

test('oversized_body_is_bounded_and_not_fully_accepted', async () => {
  resetCatalogRefreshInFlight()
  const previous = previousSnapshot()
  let aborted = false
  const padding = 'x'.repeat(5_000)
  const result = await refreshCatalog({
    source: OPENROUTER_CATALOG_SOURCE,
    previous,
    maxBytes: 1_024,
    fetchImpl: async (_input, init) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return new Response(
        JSON.stringify({ data: [{ id: 'z-ai/glm-5.3-flash', note: padding }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.preservedPrevious, true)
  assert.ok(result.warnings.some((warning) => warning.includes('byte bound')))
  assert.equal(aborted, true, 'the abort signal must fire for an oversized body')
})

test('redirect_to_disallowed_host_is_not_followed', async () => {
  resetCatalogRefreshInFlight()
  const requested: string[] = []
  let followed = false
  const fetchImpl: typeof fetch = async (input, init) => {
    requested.push(String(input))
    if (init?.redirect === 'manual') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/api/v1/models' },
      })
    }
    // Only reached when a redirect would have been auto-followed.
    followed = true
    return jsonResponse({ data: [{ id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash' }] })
  }

  const result = await refreshCatalog({ source: OPENROUTER_CATALOG_SOURCE, fetchImpl })

  assert.equal(followed, false, 'a cross-origin redirect must not be followed')
  assert.deepEqual(requested, [OPENROUTER_MODELS_URL])
  assert.notEqual(result.status, 'ok')
})
