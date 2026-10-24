/**
 * Catalog route-resolution tests on minimized sanitized fixtures.
 * No network: every catalog snapshot is built from an inline body.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  OPENROUTER_MODELS_URL,
  parseOpenRouterCatalog,
  resolveModelRoute,
  resolveRequestedRoutes,
} from './providerCatalog.js'
import { parseCommandCodeCatalog } from './commandCodeMetadata.js'
import { RouteResolutionError } from './types.js'

const OPENROUTER_FIXTURE = {
  data: [
    { id: 'deepseek/deepseek-v4.1-flash-1017', canonical_slug: 'deepseek/deepseek-v4.1-flash-20261017', created: 1792225624, context_length: 1048576, top_provider: { max_completion_tokens: 943717 } },
    { id: 'deepseek/deepseek-v4.1-flash', canonical_slug: 'deepseek/deepseek-v4.1-flash-20260910', created: 1789021285, context_length: 1048576, top_provider: { max_completion_tokens: 943717 } },
    { id: 'deepseek/deepseek-v4.1-flash:batch', canonical_slug: 'deepseek/deepseek-v4.1-flash-20260910', created: 1799999999, context_length: 1048576 },
    { id: '~deepseek/deepseek-flash-latest', canonical_slug: '~deepseek/deepseek-flash-latest', created: 1798888888, context_length: 1048576 },
    { id: 'deepseek/deepseek-v4-flash-0731', canonical_slug: 'deepseek/deepseek-v4-flash-20260731', created: 1785478908, context_length: 1310720 },
    { id: 'deepseek/deepseek-v4-pro-0813', canonical_slug: 'deepseek/deepseek-v4-pro-20260813', created: 1786549364, context_length: 1000000 },
    { id: 'z-ai/glm-5.3-flash', canonical_slug: 'z-ai/glm-5.3-flash-20260826', created: 1787752741, context_length: 1048576 },
    { id: 'xiaomi/mimo-v2.6-flash', canonical_slug: 'xiaomi/mimo-v2.6-flash-20260921', created: 1787654321, context_length: 1050000 },
    { id: 'openai/gpt-6-luna', canonical_slug: 'openai/gpt-6-luna-20260922', created: 1787567890, context_length: 1050000 },
    { id: 'anthropic/claude-haiku-5.5', canonical_slug: 'anthropic/claude-haiku-5.5-20261007', created: 1787456789, context_length: 1000000 },
    { id: 'unrelated/vendor-model', canonical_slug: 'unrelated/vendor-model-20261020', created: 1799999999, context_length: 4096 },
  ],
}

const COMMANDCODE_FIXTURE = {
  data: [
    { id: 'deepseek/deepseek-v4.1-flash', created: 1792799753, owned_by: 'command-code', name: 'DeepSeek V4.1 Flash (latest)', context_length: 1000000, supported_endpoints: ['/chat/completions', '/responses'] },
    { id: 'z-ai/glm-5.3-flash', created: 1792799753, context_length: 1048576, supported_endpoints: ['/chat/completions'] },
    { id: 'xiaomi/mimo-v2.6-flash', created: 1792799753, context_length: 1048576, supported_endpoints: ['/chat/completions', '/responses'] },
    { id: 'gpt-6-luna', created: 1792799753, context_length: 1050000, supported_endpoints: ['/chat/completions', '/responses'] },
    { id: 'claude-haiku-5-5', created: 1792799753, context_length: 1000000, supported_endpoints: ['/messages'] },
    { id: 'deepseek/deepseek-v4-flash', created: 1792799753, context_length: 1000000, supported_endpoints: ['/chat/completions'] },
  ],
}

function catalogsFor(overrides: {
  openrouter?: object | null
  commandcode?: object | null
} = {}) {
  return {
    openrouter: overrides.openrouter === null
      ? undefined
      : parseOpenRouterCatalog(JSON.stringify(overrides.openrouter ?? OPENROUTER_FIXTURE), { url: OPENROUTER_MODELS_URL, fetchedAt: '2026-10-23T23:55:29.000Z' }),
    commandcode: overrides.commandcode === null
      ? undefined
      : parseCommandCodeCatalog(JSON.stringify(overrides.commandcode ?? COMMANDCODE_FIXTURE), { fetchedAt: '2026-10-23T23:55:53.000Z' }),
  }
}

test('all_ten_routes_match_official_catalogs', () => {
  const routes = resolveRequestedRoutes(catalogsFor(), '2026-10-23T00:00:00Z')
  assert.equal(routes.length, 10)
  const byKey = new Map(routes.map((route) => [route.selectorKey, route]))
  assert.equal(byKey.get('deepseek-v4.1-flash-latest-openrouter')?.modelId, 'deepseek/deepseek-v4.1-flash-1017')
  assert.equal(byKey.get('deepseek-v4.1-flash-latest-openrouter')?.canonicalRevision, 'deepseek/deepseek-v4.1-flash-20261017')
  assert.equal(byKey.get('deepseek-v4.1-flash-latest-commandcode')?.modelId, 'deepseek/deepseek-v4.1-flash')
  assert.equal(byKey.get('glm-5.3-flash-openrouter')?.modelId, 'z-ai/glm-5.3-flash')
  assert.equal(byKey.get('glm-5.3-flash-commandcode')?.modelId, 'z-ai/glm-5.3-flash')
  assert.equal(byKey.get('mimo-v2.6-flash-openrouter')?.modelId, 'xiaomi/mimo-v2.6-flash')
  assert.equal(byKey.get('mimo-v2.6-flash-commandcode')?.modelId, 'xiaomi/mimo-v2.6-flash')
  assert.equal(byKey.get('gpt-6-luna-openrouter')?.modelId, 'openai/gpt-6-luna')
  assert.equal(byKey.get('gpt-6-luna-commandcode')?.modelId, 'gpt-6-luna')
  assert.equal(byKey.get('claude-haiku-5.5-openrouter')?.modelId, 'anthropic/claude-haiku-5.5')
  assert.equal(byKey.get('claude-haiku-5.5-commandcode')?.modelId, 'claude-haiku-5-5')
  assert.equal(byKey.get('claude-haiku-5.5-commandcode')?.protocol, 'anthropic_messages')
  for (const route of routes) {
    if (!route.selectorKey.includes('haiku')) assert.equal(route.protocol, 'chat_completions')
    assert.equal(route.capabilities.source, 'official_catalog')
    assert.match(route.routeHash, /^[0-9a-f]{64}$/)
  }
  // Freshness and identity travel with the route.
  assert.equal(byKey.get('glm-5.3-flash-openrouter')?.catalog.sha256.length, 64)
  assert.equal(byKey.get('glm-5.3-flash-openrouter')?.catalog.fetchedAt, '2026-10-23T23:55:29.000Z')
})

test('latest_v41_excludes_other_families', () => {
  const route = resolveModelRoute('deepseek-v4.1-flash-latest-openrouter', catalogsFor(), '2026-10-23T00:00:00Z')
  // The bare alias has an older revision; :batch and router entries are newer
  // fixtures but are excluded; V4 (non-4.1) and Pro entries never match.
  assert.equal(route.modelId, 'deepseek/deepseek-v4.1-flash-1017')
  assert.notEqual(route.modelId, 'deepseek/deepseek-v4-flash-0731')
  assert.notEqual(route.modelId, 'deepseek/deepseek-v4-pro-0813')
  assert.notEqual(route.modelId, '~deepseek/deepseek-flash-latest')
  assert.notEqual(route.modelId, 'unrelated/vendor-model')
})

test('commandcode_created_is_not_release_order', () => {
  // Every fixture entry shares created=1792799753; the resolver must not use
  // it to rank the catalog. The V4.1 latest alias is selected exactly, and
  // its concrete revision stays unknown.
  const route = resolveModelRoute('deepseek-v4.1-flash-latest-commandcode', catalogsFor(), '2026-10-23T00:00:00Z')
  assert.equal(route.modelId, 'deepseek/deepseek-v4.1-flash')
  assert.equal(route.revisionKind, 'provider_alias')
  assert.equal(route.canonicalRevision, null)
  // A same-`created` non-4.1 entry cannot be promoted as "latest V4.1".
  const fixture = COMMANDCODE_FIXTURE
  assert.equal(fixture.data.every((entry) => entry.created === 1792799753), true)
})

test('missing_model_has_no_substitution', () => {
  // A family missing from one provider's catalog fails that selector only;
  // no other family, provider, or cheaper entry is substituted.
  const catalogs = catalogsFor({ commandcode: { data: COMMANDCODE_FIXTURE.data.filter((e) => e.id !== 'gpt-6-luna') } })
  assert.throws(
    () => resolveModelRoute('gpt-6-luna-commandcode', catalogs, '2026-10-23T00:00:00Z'),
    (error: unknown) => error instanceof RouteResolutionError &&
      error.reason === 'model_missing_from_catalog',
  )
  // The same family on the other provider still resolves.
  assert.equal(resolveModelRoute('gpt-6-luna-openrouter', catalogs, 'x').modelId, 'openai/gpt-6-luna')
  // An unknown selector key also fails explicitly.
  assert.throws(
    () => resolveModelRoute('nonexistent-family-openrouter', catalogsFor(), 'x'),
    (error: unknown) => error instanceof RouteResolutionError &&
      error.reason === 'unknown_selector_key',
  )
  // A missing catalog fails with catalog_not_loaded, not a guess.
  assert.throws(
    () => resolveModelRoute('glm-5.3-flash-commandcode', catalogsFor({ commandcode: null }), 'x'),
    (error: unknown) => error instanceof RouteResolutionError &&
      error.reason === 'catalog_not_loaded',
  )
  // An ambiguous latest revision fails rather than picking one of many.
  const ambiguous = { data: [
    { id: 'deepseek/deepseek-v4.1-flash-1017', created: 1792225624, context_length: 1048576 },
    { id: 'deepseek/deepseek-v4.1-flash-1020', created: 1792225624, context_length: 1048576 },
  ] }
  assert.throws(
    () => resolveModelRoute('deepseek-v4.1-flash-latest-openrouter', catalogsFor({ openrouter: ambiguous }), 'x'),
    (error: unknown) => error instanceof RouteResolutionError &&
      error.reason === 'ambiguous_latest_revision',
  )
})

test('catalog_cannot_override_credential_origin', () => {
  // Catalog entries carry no credential material, and the resolved route's
  // credential reference is fixed by provider identity even if a catalog
  // body contains credential-shaped fields.
  const hostileOpenRouter = { ...OPENROUTER_FIXTURE, data: OPENROUTER_FIXTURE.data.map((entry) => (
    entry.id === 'z-ai/glm-5.3-flash' ? { ...entry, credentialEnvVar: 'CMD_API_KEY' } : entry
  )) }
  const hostileCommandCode = { data: COMMANDCODE_FIXTURE.data.map((entry) => (
    entry.id === 'z-ai/glm-5.3-flash' ? { ...entry, credentialEnvVar: 'OPENROUTER_API_KEY' } : entry
  )) }
  const catalogs = catalogsFor({ openrouter: hostileOpenRouter, commandcode: hostileCommandCode })
  const openrouterRoute = resolveModelRoute('glm-5.3-flash-openrouter', catalogs, 'x')
  const commandcodeRoute = resolveModelRoute('glm-5.3-flash-commandcode', catalogs, 'x')
  assert.equal(openrouterRoute.credentialEnvVar, 'OPENROUTER_API_KEY')
  assert.equal(commandcodeRoute.credentialEnvVar, 'CMD_API_KEY')
  // Gateway bases are also fixed by provider identity.
  assert.equal(openrouterRoute.apiBase, 'https://openrouter.ai/api/v1')
  assert.equal(commandcodeRoute.apiBase, 'https://api.commandcode.ai/provider/v1')
})
