import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY,
  assertCompleteResearchV2ModelEnvOverride,
  resolveEffectiveResearchV2ModelRouteForCli,
  resolveLiveResearchModelConfigForCli,
  resolveResearchV2OpenRouterRouteFromPolicy,
  verifyEffectiveResearchV2OpenRouterRouteForLive,
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

  it('resolveEffectiveResearchV2ModelRouteForCli matches policy route when env override absent', () => {
    const effective = resolveEffectiveResearchV2ModelRouteForCli(
      {},
      DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY,
    )
    assert.equal(effective.selection_basis, 'model_policy_json')
    assert.equal(effective.route_key, DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY)
    const { route_report, config } = resolveLiveResearchModelConfigForCli(
      {},
      DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY,
    )
    assert.deepEqual(route_report, effective)
    assert.equal(config.engine.modelId, effective.model_id)
  })

  it('rejects partial provider/model env override pairs', () => {
    assert.throws(
      () => assertCompleteResearchV2ModelEnvOverride({ BABEL_RESEARCH_V2_PROVIDER: 'openrouter' }),
      /both BABEL_RESEARCH_V2_PROVIDER and BABEL_RESEARCH_V2_MODEL_ID/,
    )
    assert.throws(
      () => assertCompleteResearchV2ModelEnvOverride({ BABEL_RESEARCH_V2_MODEL_ID: 'x/y' }),
      /both BABEL_RESEARCH_V2_PROVIDER and BABEL_RESEARCH_V2_MODEL_ID/,
    )
  })

  it('resolveLiveResearchModelConfigForCli uses complete OpenRouter env override', () => {
    const { config, route_report } = resolveLiveResearchModelConfigForCli({
      BABEL_RESEARCH_V2_PROVIDER: 'openrouter',
      BABEL_RESEARCH_V2_MODEL_ID: 'deepseek/deepseek-v4-flash-0731',
    })
    assert.equal(route_report.selection_basis, 'env_override')
    assert.equal(config.engine.provider, 'openrouter')
    assert.equal(config.engine.modelId, 'deepseek/deepseek-v4-flash-0731')
  })

  it('rejects env override model_id not present in configured openrouter routes', () => {
    assert.throws(
      () =>
        resolveLiveResearchModelConfigForCli({
          BABEL_RESEARCH_V2_PROVIDER: 'openrouter',
          BABEL_RESEARCH_V2_MODEL_ID: 'vendor/not-in-policy',
        }),
      /must match a configured enabled openrouter route/,
    )
  })

  it('rejects non-OpenRouter env override (no silent OpenCode fallback)', () => {
    assert.throws(
      () =>
        verifyEffectiveResearchV2OpenRouterRouteForLive({
          BABEL_RESEARCH_V2_PROVIDER: 'opencode',
          BABEL_RESEARCH_V2_MODEL_ID: 'some/model',
        }),
      /must be openrouter/i,
    )
    assert.throws(
      () =>
        resolveLiveResearchModelConfigForCli({
          BABEL_RESEARCH_V2_PROVIDER: 'opencode-go',
          BABEL_RESEARCH_V2_MODEL_ID: 'some/model',
        }),
      /must be openrouter/i,
    )
  })
})
