import { createProviderRunner, type ProviderEngineOptions } from '../../../runners/providerEngine.js'
import type { ProviderId } from '../../../runners/providerRegistry.js'
import { assertResearchV2LiveApiEnabled } from '../liveApiGate.js'
import { ProviderResearchModelBridge } from './providerResearchModelBridge.js'

export type CreateProviderRunner = typeof createProviderRunner

export interface LiveResearchModelPortConfig {
  backendKey: string
  engine: ProviderEngineOptions
  createRunner?: CreateProviderRunner
}

/** Resolve live model port settings from host env (no network; gate still required at invoke). */
export function resolveLiveResearchModelConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveResearchModelPortConfig | null {
  const provider = env.BABEL_RESEARCH_V2_PROVIDER
  const modelId = env.BABEL_RESEARCH_V2_MODEL_ID
  if (!provider || !modelId) return null
  const backendKey = env.BABEL_RESEARCH_V2_BACKEND_KEY ?? 'research-v2-cli'
  return {
    backendKey,
    engine: {
      provider: provider as ProviderId,
      modelId,
      ...(env.BABEL_RESEARCH_V2_API_KEY_ENV
        ? { apiKeyEnvVar: env.BABEL_RESEARCH_V2_API_KEY_ENV }
        : {}),
    },
  }
}

/**
 * Production {@link ResearchModelPort} for gated live CLI/engine paths.
 * Callers must still pass admitted store/control; this only constructs the model adapter.
 */
export function createLiveResearchModelPort(config: LiveResearchModelPortConfig): ProviderResearchModelBridge {
  assertResearchV2LiveApiEnabled()
  const createRunner = config.createRunner ?? createProviderRunner
  const runner = createRunner(config.engine)
  return new ProviderResearchModelBridge({
    runner,
    backendKey: config.backendKey,
    provider: String(config.engine.provider),
    providerModelId: config.engine.modelId,
  })
}
