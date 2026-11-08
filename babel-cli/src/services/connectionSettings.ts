/** Shared CLI/TUI application operations for non-secret connection preferences. */
import { resolve } from 'node:path'
import { getAvailableModels } from '../modelPolicy.js'
import { getProviderSpec, isProviderId, listProviderSpecs } from '../runners/providerRegistry.js'
import { readUserSettings, resolveEffectiveSettings, updateUserSettings, type Connection, type UserPreferences } from '../config/userSettings.js'
import { connectionModelSelector } from '../config/connectionModelPolicy.js'

export interface SelectionSession { [key: string]: unknown; connection?: string; model?: string | undefined; modelsByConnection?: Record<string, string> }
export type SaveScope = 'user' | 'project'

/** Store only an explicit user choice; project scope remains in the private user profile. */
export function savePreferences(preferences: UserPreferences, scope: SaveScope, projectRoot = process.cwd()): void {
  if (scope === 'user') {
    const settings = readUserSettings()
    updateUserSettings({ defaults: { ...preferences, ...(preferences.modelsByConnection ? { modelsByConnection: { ...settings.defaults?.modelsByConnection, ...preferences.modelsByConnection } } : {}) } })
  }
  else {
    const settings = readUserSettings()
    const key = resolve(projectRoot)
    updateUserSettings({ projects: { ...settings.projects, [key]: { ...settings.projects?.[key], ...preferences, ...(preferences.modelsByConnection ? { modelsByConnection: { ...settings.projects?.[key]?.modelsByConnection, ...preferences.modelsByConnection } } : {}), ...(preferences.plans ? { plans: { ...settings.projects?.[key]?.plans, ...preferences.plans } } : {}) } } })
  }
}

/** Create an account configuration without selecting it or making a network call. */
export function connectProvider(provider: string, options: {
  name?: string; model?: string; baseUrl?: string; apiKeyEnvVar?: string; contextWindow?: number; maxOutputTokens?: number; authentication?: 'api-key' | 'none'
} = {}): Connection {
  if (!isProviderId(provider)) throw new Error('Unknown provider. Use babel-harness provider list.')
  const id = options.name ?? provider
  const previous = readUserSettings().connections[id]
  if (previous && previous.provider !== provider) throw new Error('Connection name already belongs to another provider; choose another --name.')
  const connection: Connection = { ...previous, ...options, id, provider }
  updateUserSettings({ connections: { [id]: connection } })
  return connection
}

/** Report only declared non-secret fields; never dump arbitrary preference content. */
export function connectionStatus(session: SelectionSession = {}, projectRoot = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const settings = readUserSettings({ env })
  const effective = resolveEffectiveSettings({ settings, env, session, projectRoot })
  const connection = effective.connection.value
  const spec = connection ? getProviderSpec(connection.provider) : null
  const keyName = connection?.apiKeyEnvVar ?? spec?.credentialEnvVar ?? null
  const configured = Boolean(connection && effective.model.value && (connection.authentication === 'none' || !spec?.requiresCredential || (keyName && env[keyName]?.trim())))
  return {
    state: !connection || !effective.model.value ? 'setup_required' : configured ? 'configured_unverified' : 'action_required',
    connection: connection?.id ?? null, provider: connection?.provider ?? null, model: effective.model.value,
    endpoint: connection?.baseUrl ?? 'provider default',
    selectionSource: effective.connection.source, modelSource: effective.model.source,
    credential: { required: connection?.authentication !== 'none' && Boolean(spec?.requiresCredential), variable: connection?.authentication === 'none' ? null : keyName, present: connection?.authentication === 'none' || (keyName ? Boolean(env[keyName]?.trim()) : !spec?.requiresCredential) },
    operations: spec?.operations ?? [], authorityConformance: spec?.authorityConformance ?? 'unknown',
    connectivity: 'unverified', observedModel: null,
    autoApply: effective.autoApply, workflow: effective.workflow, review: effective.review, budgetUsd: effective.budgetUsd,
    nextCommand: !connection || !effective.model.value ? 'babel-harness setup' : !configured ? 'babel-harness setup' : 'babel-harness work "Explain this project"',
  }
}

/** Select a connection/model for the current session; persistence is explicit. */
export function selectConnection(id: string, session: SelectionSession, options: { save?: SaveScope; projectRoot?: string } = {}): SelectionSession {
  const connection = readUserSettings().connections[id]
  if (!connection) throw new Error('Unknown connection. Use provider list or provider connect.')
  const model = resolveEffectiveSettings({ session: { connection: id, ...(session.modelsByConnection ? { modelsByConnection: session.modelsByConnection } : {}) }, ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}) }).model.value
  const selection = { connection: id, model: model ?? undefined, ...(session.modelsByConnection ? { modelsByConnection: session.modelsByConnection } : {}) }
  if (options.save) savePreferences({ connection: id, model: model ?? undefined, ...(model ? { modelsByConnection: { [id]: model } } : {}) }, options.save, options.projectRoot)
  return selection
}

/** Resolve a named connection or a provider with exactly one configured account. */
export function resolveConnectionReference(reference: string): string {
  const connections = readUserSettings().connections
  if (connections[reference]) return reference
  const provider = reference.toLowerCase() === 'commandcode' ? 'command-code' : reference.toLowerCase()
  const matches = Object.values(connections).filter(connection => connection.provider === provider)
  if (matches.length !== 1) throw new Error(matches.length ? `Multiple ${provider} connections; choose a connection by name.` : `No configured connection for ${reference}; use /provider list or /setup.`)
  return matches[0]!.id
}

/** Resolve only unambiguous local catalog names; full IDs remain explicit. */
export function resolveScopedModelReference(reference: string, session: SelectionSession, projectRoot = process.cwd()): string {
  const value = reference.trim()
  if (!value) throw new Error('Choose a model from /model list or enter an exact model ID.')
  const ids = [...new Set(listConnectionModels(session, projectRoot).models.map(model => model.id))]
  if (ids.includes(value) || value.includes('/')) return value
  const provider = resolveEffectiveSettings({ session, projectRoot }).connection.value?.provider
  // Preserve Babel's existing deepseek-pro -> deepseek-v4-pro alias, scoped to
  // the OpenRouter catalog and reported as the exact selected API ID.
  const shortName = provider === 'openrouter' && value.toLowerCase() === 'deepseek-pro' ? 'deepseek-v4-pro' : value.toLowerCase()
  const matches = ids.filter(id => id.split('/').pop()?.toLowerCase() === shortName)
  if (matches.length !== 1) throw new Error(matches.length ? `Model ${value} is ambiguous; use its exact ID.` : `Model ${value} is not in this connection's catalog; use an exact model ID.`)
  return matches[0]!
}

/** Model IDs are scoped to a connection, never used to guess its provider. */
export function selectModel(model: string, session: SelectionSession, options: { save?: SaveScope; projectRoot?: string } = {}): SelectionSession {
  const effective = resolveEffectiveSettings({ session, ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}) })
  if (!effective.connection.value) throw new Error('Select a connection with provider use before selecting a model.')
  if (!model.trim() || model.length > 500 || /[\u0000-\u001f]/.test(model)) throw new Error('An exact model ID is required.')
  const selection = { connection: effective.connection.value.id, model: model.trim(), modelsByConnection: { ...session.modelsByConnection, [effective.connection.value.id]: model.trim() } }
  if (options.save) savePreferences({ connection: selection.connection, model: selection.model, modelsByConnection: { [selection.connection]: selection.model } }, options.save, options.projectRoot)
  return selection
}

/** Resolve the effective exact selector used by the existing model-policy entry point. */
export function selectedConnectionModel(session: SelectionSession = {}, projectRoot = process.cwd()): string | null {
  const effective = resolveEffectiveSettings({ session, projectRoot })
  return effective.connection.value && effective.model.value ? connectionModelSelector(effective.connection.value.id, effective.model.value) : null
}

/** List configured accounts and known models without live discovery. Manual exact entry stays available. */
export function listConnections() {
  return { providers: listProviderSpecs().map(spec => ({ id: spec.id, credentialVariable: spec.credentialEnvVar, operations: spec.operations, authorityConformance: spec.authorityConformance })),
    connections: Object.values(readUserSettings().connections).map(connection => ({ id: connection.id, provider: connection.provider, model: connection.model ?? null, endpoint: connection.baseUrl ?? 'provider default' })) }
}

export function listConnectionModels(session: SelectionSession = {}, projectRoot = process.cwd()) {
  const effective = resolveEffectiveSettings({ session, projectRoot })
  const provider = effective.connection.value?.provider
  return { connection: effective.connection.value?.id ?? null,
    models: getAvailableModels().filter(({ entry }) => entry.provider === provider).map(({ entry }) => ({ id: entry.model_id, contextWindow: entry.context_window ?? null, maxOutputTokens: entry.max_output_tokens ?? null,
      sourceUrl: entry.source_url ?? null, verifiedAt: entry.verified_at ?? null,
      nativeToolUse: entry.native_tool_use_unverified ? null : entry.native_tool_use ?? null, capabilities: entry.capabilities ?? [], capabilitySource: entry.native_tool_use === undefined || entry.native_tool_use_unverified ? 'unknown' : 'policy', qualification: 'unverified' })),
    manualEntry: 'model use <exact-model-id>', discovery: 'local catalog; live model discovery has not been requested' }
}
