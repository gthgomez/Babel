import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY,
  resolveResearchV2OpenRouterRouteFromPolicy,
} from './researchV2ModelRoute.js'

describe('research v2 OpenRouter model route', () => {
  it('resolves explicit openrouter backend from model-policy without secrets', () => {
    const route = resolveResearchV2OpenRouterRouteFromPolicy(DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY)
    assert.equal(route.provider, 'openrouter')
    assert.equal(route.route_key, DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY)
    assert.equal(route.model_id, 'deepseek/deepseek-v4-flash-0731')
    assert.ok(route.policy_path.endsWith('model-policy.json'))
    assert.equal(route.selection_basis, 'model_policy_json')
  })
})
