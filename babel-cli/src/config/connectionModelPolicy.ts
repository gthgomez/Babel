/** Bind every inference stage to an explicitly selected user connection. */
import type { ResolvedModelPolicy, ModelPolicyModelEntry } from '../modelPolicy.js'
import { MODEL_POLICY_STAGES } from '../modelPolicy.js'
import { getProviderSpec, providerSupportsOperation } from '../runners/providerRegistry.js'
import { readUserSettings, resolveEffectiveSettings, type UserSettings } from './userSettings.js'

/** Stable internal selector; the model portion preserves vendor slashes verbatim. */
export function connectionModelSelector(connection: string, model: string): string {
  return `connection/${connection}/${model}`
}

/** Resolve connection selectors without model-name provider inference or gateway substitution. */
export function resolveConnectionModelPolicy(
  selector?: string,
  options: { settings?: UserSettings; projectRoot?: string; models?: Record<string, ModelPolicyModelEntry> } = {},
): ResolvedModelPolicy | null {
  const settings = options.settings ?? readUserSettings()
  let effective: ReturnType<typeof resolveEffectiveSettings>
  if (selector?.startsWith('connection/')) {
    const [, id, ...parts] = selector.split('/')
    if (!id || !parts.join('/')) throw new Error('A connection selector requires a connection and exact model.')
    effective = resolveEffectiveSettings({ settings, invocation: { connection: id, model: parts.join('/') } })
  } else if (selector) return null
  else effective = resolveEffectiveSettings({ settings, ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}) })
  const connection = effective.connection.value
  const model = effective.model.value
  if (!connection || !model) return null
  const spec = getProviderSpec(connection.provider)
  if (spec.authorityConformance !== 'certified' || !providerSupportsOperation(connection.provider, 'native_tool_stream')) {
    throw new Error(`UNSUPPORTED_OPERATION: ${connection.provider} coding tools are not qualified. Your connection is saved; use provider status for its capabilities.`)
  }
  const metadata = Object.values(options.models ?? {}).find(entry => entry.provider === connection.provider && entry.model_id === model)
  const key = connectionModelSelector(connection.id, model)
  const contextWindow = connection.contextWindow ?? metadata?.context_window
  const maxOutputTokens = connection.maxOutputTokens ?? metadata?.max_output_tokens
  const entry = {
    backendKey: key, provider: connection.provider, providerModelId: model, tier: 'standard' as const,
    expensive: false, enabled: true, experimental: false,
    ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }
  return {
    connectionId: connection.id,
    ...(connection.authentication ? { authentication: connection.authentication } : {}),
    ...(connection.apiKeyEnvVar ? { apiKeyEnvVar: connection.apiKeyEnvVar } : {}),
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    policyPath: 'user preferences', family: connection.provider, selectedTier: 'standard',
    resolvedBackendKey: key, provider: connection.provider, providerModelId: model,
    expensive: false, enabled: true, experimental: false, blockedWithoutExplicitOptIn: false,
    selectionReason: `Explicit connection ${connection.id}; no automatic provider fallback.`,
    approximateInputTokens: 0, approximateOutputTokens: 0, warnings: [], waterfall: [entry],
    stagePolicies: MODEL_POLICY_STAGES.map(stage => ({ stage, primaryBackendKey: key,
      primaryProvider: connection.provider, primaryProviderModelId: model, orderedBackends: [entry] })),
    ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}),
    nativeToolUse: true,
  }
}
