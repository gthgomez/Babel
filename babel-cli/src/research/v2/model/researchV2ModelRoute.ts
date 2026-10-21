import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadModelPolicyConfig } from '../../../modelPolicy.js'
import type { LiveResearchModelPortConfig } from './researchV2LiveModelPort.js'

/** Default OpenRouter control route from repo model-policy (not a silent family default). */
export const DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY = 'deepseek-v4-flash-openrouter'

/** Campaign live-smoke preflight: operator lane is OpenRouter-only for this testing window. */
export const RESEARCH_V2_CAMPAIGN_PREFLIGHT_PROVIDER = 'openrouter'

export function assertResearchV2CampaignPreflightProviderIsOpenRouter(provider: string): void {
  const normalized = provider.trim().toLowerCase()
  if (normalized !== RESEARCH_V2_CAMPAIGN_PREFLIGHT_PROVIDER) {
    throw new Error(
      `research v2 campaign preflight requires ${RESEARCH_V2_CAMPAIGN_PREFLIGHT_PROVIDER} (got ${provider}); use npm run test:research-v2-openrouter-route-smoke before live smoke`,
    )
  }
}

export interface ResolvedResearchV2OpenRouterRoute {
  route_key: string
  provider: 'openrouter'
  model_id: string
  policy_path: string
  selection_basis: 'model_policy_json'
}

export type EffectiveResearchV2ModelRoute =
  | (ResolvedResearchV2OpenRouterRoute & {
      backend_key: string
      selection_basis: 'model_policy_json'
    })
  | {
      route_key: null
      provider: string
      model_id: string
      backend_key: string
      policy_path: null
      selection_basis: 'env_override'
    }

export function assertCompleteResearchV2ModelEnvOverride(env: NodeJS.ProcessEnv = process.env): void {
  const provider = env.BABEL_RESEARCH_V2_PROVIDER?.trim()
  const modelId = env.BABEL_RESEARCH_V2_MODEL_ID?.trim()
  if ((provider && !modelId) || (!provider && modelId)) {
    throw new Error(
      'research v2 model override requires both BABEL_RESEARCH_V2_PROVIDER and BABEL_RESEARCH_V2_MODEL_ID',
    )
  }
}

/** Runtime validation: complete env override must match an enabled model-policy provider + model_id pair. */
export function assertResearchV2EnvOverrideMatchesConfiguredModelRoute(
  env: NodeJS.ProcessEnv = process.env,
  babelRoot?: string,
): void {
  const provider = env.BABEL_RESEARCH_V2_PROVIDER?.trim()
  const modelId = env.BABEL_RESEARCH_V2_MODEL_ID?.trim()
  if (!provider || !modelId) return
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
  const { config } = loadModelPolicyConfig(babelRoot ?? repoRoot)
  const models = config.models as Record<
    string,
    { provider?: string; model_id?: string; enabled?: boolean }
  >
  const matched = Object.values(models).some(
    (entry) =>
      entry?.enabled !== false &&
      entry.provider === provider &&
      entry.model_id === modelId,
  )
  if (!matched) {
    throw new Error(
      `research v2 model override must match a configured enabled model-policy route (provider=${provider}, model_id=${modelId})`,
    )
  }
}

/** Resolve an explicit OpenRouter backend from configured model-policy routes (no network, no secrets). */
export function resolveResearchV2OpenRouterRouteFromPolicy(
  routeKey?: string,
  babelRoot?: string,
): ResolvedResearchV2OpenRouterRoute {
  const key =
    routeKey?.trim() ||
    process.env.BABEL_RESEARCH_V2_MODEL_ROUTE_KEY?.trim() ||
    DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
  const { path: policyPath, config } = loadModelPolicyConfig(babelRoot ?? repoRoot)
  const models = config.models as Record<
    string,
    { provider?: string; model_id?: string; enabled?: boolean }
  >
  const entry = models[key]
  if (!entry) {
    throw new Error(`research v2 model route key not found in model-policy: ${key}`)
  }
  if (entry.provider !== 'openrouter') {
    throw new Error(`research v2 model route ${key} is not openrouter (got ${entry.provider ?? 'missing'})`)
  }
  if (!entry.model_id) {
    throw new Error(`research v2 model route ${key} has no model_id`)
  }
  if (entry.enabled === false) {
    throw new Error(`research v2 model route ${key} is disabled in model-policy`)
  }
  return {
    route_key: key,
    provider: 'openrouter',
    model_id: entry.model_id,
    policy_path: policyPath,
    selection_basis: 'model_policy_json',
  }
}

export function liveResearchModelConfigFromOpenRouterRoute(
  routeKey?: string,
): LiveResearchModelPortConfig {
  const route = resolveResearchV2OpenRouterRouteFromPolicy(routeKey)
  return {
    backendKey: 'research-v2-cli',
    engine: {
      provider: 'openrouter',
      modelId: route.model_id,
    },
  }
}

/**
 * Campaign preflight only (`test:research-v2-openrouter-route-smoke`): OpenRouter lane for current testing.
 * Not used by general `babel research v2 run` / live-plan resolution.
 */
export function verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight(
  env: NodeJS.ProcessEnv = process.env,
  routeKey?: string,
): EffectiveResearchV2ModelRoute {
  const effective = resolveEffectiveResearchV2ModelRouteForCli(env, routeKey)
  assertResearchV2CampaignPreflightProviderIsOpenRouter(effective.provider)
  return effective
}

/** @deprecated Use verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight */
export const verifyEffectiveResearchV2OpenRouterRouteForLive =
  verifyEffectiveResearchV2OpenRouterRouteForCampaignPreflight

/** Same effective route resolution used by `babel research v2 run` and `model-route`. */
export function resolveEffectiveResearchV2ModelRouteForCli(
  env: NodeJS.ProcessEnv = process.env,
  routeKey?: string,
): EffectiveResearchV2ModelRoute {
  assertCompleteResearchV2ModelEnvOverride(env)
  const provider = env.BABEL_RESEARCH_V2_PROVIDER?.trim()
  const modelId = env.BABEL_RESEARCH_V2_MODEL_ID?.trim()
  if (provider && modelId) {
    assertResearchV2EnvOverrideMatchesConfiguredModelRoute(env)
    const backendKey = env.BABEL_RESEARCH_V2_BACKEND_KEY ?? 'research-v2-cli'
    return {
      route_key: null,
      provider,
      model_id: modelId,
      backend_key: backendKey,
      policy_path: null,
      selection_basis: 'env_override',
    }
  }
  const route = resolveResearchV2OpenRouterRouteFromPolicy(routeKey)
  return {
    ...route,
    backend_key: env.BABEL_RESEARCH_V2_BACKEND_KEY ?? 'research-v2-cli',
    selection_basis: 'model_policy_json',
  }
}

/** Env overrides policy; policy route is explicit OpenRouter when env provider/model omitted. */
export function resolveLiveResearchModelConfigForCli(
  env: NodeJS.ProcessEnv = process.env,
  routeKey?: string,
): { config: LiveResearchModelPortConfig; route_report: EffectiveResearchV2ModelRoute } {
  const effective = resolveEffectiveResearchV2ModelRouteForCli(env, routeKey)
  if (effective.selection_basis === 'env_override') {
    return {
      config: {
        backendKey: effective.backend_key,
        engine: {
          provider: effective.provider as LiveResearchModelPortConfig['engine']['provider'],
          modelId: effective.model_id,
          ...(env.BABEL_RESEARCH_V2_API_KEY_ENV
            ? { apiKeyEnvVar: env.BABEL_RESEARCH_V2_API_KEY_ENV }
            : {}),
        },
      },
      route_report: effective,
    }
  }
  return {
    config: {
      backendKey: effective.backend_key,
      engine: {
        provider: 'openrouter',
        modelId: effective.model_id,
      },
    },
    route_report: effective,
  }
}
