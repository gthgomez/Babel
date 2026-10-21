import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadModelPolicyConfig } from '../../../modelPolicy.js'
import type { LiveResearchModelPortConfig } from './researchV2LiveModelPort.js'

/** Default OpenRouter control route from repo model-policy (not a silent family default). */
export const DEFAULT_RESEARCH_V2_OPENROUTER_ROUTE_KEY = 'deepseek-v4-flash-openrouter'

export interface ResolvedResearchV2OpenRouterRoute {
  route_key: string
  provider: 'openrouter'
  model_id: string
  policy_path: string
  selection_basis: 'model_policy_json'
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

/** Env overrides policy; policy route is explicit OpenRouter when env provider/model omitted. */
export function resolveLiveResearchModelConfigForCli(
  env: NodeJS.ProcessEnv = process.env,
): { config: LiveResearchModelPortConfig; route_report: ResolvedResearchV2OpenRouterRoute | null } {
  const provider = env.BABEL_RESEARCH_V2_PROVIDER?.trim()
  const modelId = env.BABEL_RESEARCH_V2_MODEL_ID?.trim()
  if (provider && modelId) {
    const backendKey = env.BABEL_RESEARCH_V2_BACKEND_KEY ?? 'research-v2-cli'
    return {
      config: {
        backendKey,
        engine: {
          provider: provider as LiveResearchModelPortConfig['engine']['provider'],
          modelId,
          ...(env.BABEL_RESEARCH_V2_API_KEY_ENV
            ? { apiKeyEnvVar: env.BABEL_RESEARCH_V2_API_KEY_ENV }
            : {}),
        },
      },
      route_report: null,
    }
  }
  const route = resolveResearchV2OpenRouterRouteFromPolicy()
  return { config: liveResearchModelConfigFromOpenRouterRoute(route.route_key), route_report: route }
}
