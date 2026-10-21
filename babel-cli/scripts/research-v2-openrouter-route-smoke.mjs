#!/usr/bin/env node
/**
 * Canonical preflight before live research v2 smoke: resolve effective model route
 * from model-policy (or complete OpenRouter env override) and reject any other provider.
 * No network, no OpenCode, no credentials required.
 */
import { verifyEffectiveResearchV2OpenRouterRouteForLive } from '../src/research/v2/model/researchV2ModelRoute.ts'

const route = verifyEffectiveResearchV2OpenRouterRouteForLive(process.env)
const payload = {
  schema: 'research-v2-openrouter-route-smoke/v1',
  provider: route.provider,
  model_id: route.model_id,
  route_key: route.route_key,
  selection_basis: route.selection_basis,
  policy_path: route.policy_path,
}
console.log(JSON.stringify(payload, null, 2))
console.log('research-v2-openrouter-route-smoke: ok')
