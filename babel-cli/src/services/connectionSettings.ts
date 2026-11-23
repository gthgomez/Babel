/** Shared CLI/TUI application operations for non-secret connection preferences. */
import { resolve } from 'node:path'
import { getAvailableModels, resolveModelByKey } from '../modelPolicy.js'
import { buildProviderRouteReport } from '../runners/providerRouteReport.js'
import { isProviderId, listProviderSpecs } from '../runners/providerRegistry.js'
import { readUserSettings, resolveEffectiveSettings, updateUserSettings, type Connection, type UserPreferences } from '../config/userSettings.js'
import { connectionModelSelector } from '../config/connectionModelPolicy.js'

export interface SelectionSession { [key: string]: unknown; connection?: string; model?: string | undefined; modelsByConnection?: Record<string, string> }
export type SaveScope = 'user' | 'project'

/** Store only an explicit user choice; project scope remains in the private user profile. */
export function savePreferences(preferences: UserPreferences, scope: SaveScope, projectRoot = process.cwd()): void {
  const withRememberedModels = (current?: UserPreferences): UserPreferences => ({
    ...preferences,
    ...(preferences.modelsByConnection ? { modelsByConnection: { ...current?.modelsByConnection, ...preferences.modelsByConnection } } : {}),
  })
  if (scope === 'user') {
    updateUserSettings(settings => ({ defaults: withRememberedModels(settings.defaults) }))
  } else {
    const key = resolve(projectRoot)
    updateUserSettings(settings => {
      const current = settings.projects?.[key]
      return { projects: { [key]: { ...current, ...withRememberedModels(current),
        ...(preferences.plans ? { plans: { ...current?.plans, ...preferences.plans } } : {}) } } }
    })
  }
}

/** Create an account configuration without selecting it or making a network call. */
export function connectProvider(provider: string, options: {
  name?: string; model?: string; baseUrl?: string; apiKeyEnvVar?: string; contextWindow?: number; maxOutputTokens?: number; authentication?: 'api-key' | 'none'
} = {}): Connection {
  if (!isProviderId(provider)) throw new Error('Unknown provider. Use babel-harness provider list.')
  const id = options.name ?? provider
  return updateUserSettings(settings => {
    const previous = Object.hasOwn(settings.connections, id) ? settings.connections[id] : undefined
    if (previous && previous.provider !== provider) throw new Error('Connection name already belongs to another provider; choose another --name.')
    return { connections: { [id]: { ...previous, ...options, id, provider } } }
  }).connections[id]!
}

/** Report only declared non-secret fields; never dump arbitrary preference content. */
export function connectionStatus(session: SelectionSession = {}, projectRoot = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const settings = readUserSettings({ env })
  const effective = resolveEffectiveSettings({ settings, env, session, projectRoot, reportUnavailableConnection: true })
  const connection = effective.connection.value
  // Reveal a legacy vendor alias instead of letting a saved key imply the wrong transport.
  const requestedModel = effective.model.value
  let alias: { from: string; to: string; notice: string | null } | null = null
  if (requestedModel && (requestedModel.startsWith('connection/') || !isProviderId(connection?.provider ?? ''))) alias = null
  else if (requestedModel && !requestedModel.includes('/') && !connection) {
    try {
      const resolved = resolveModelByKey({ key: requestedModel })
      if (resolved.aliasResolvedFrom) alias = { from: resolved.aliasResolvedFrom, to: resolved.aliasResolvedTo ?? `${resolved.provider}/${resolved.providerModelId}`, notice: resolved.aliasNotice ?? null }
    } catch { /* unresolvable display stays explicit below; no invented route */ }
  }
  const report = buildProviderRouteReport({
    requestedModel,
    provider: connection?.provider ?? null,
    model: requestedModel,
    ...(connection?.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    ...(connection?.apiKeyEnvVar ? { apiKeyEnvVar: connection.apiKeyEnvVar } : {}),
    ...(connection?.authentication ? { authentication: connection.authentication } : {}),
    ...(alias?.from ? { aliasFrom: alias.from, aliasTo: alias.to, ...(alias.notice ? { aliasNotice: alias.notice } : {}) } : {}),
    budgetUsd: effective.budgetUsd.value,
    budgetSource: effective.budgetUsd.source,
    env,
  })
  const credentialReady = report.credential.present
  const configured = Boolean(connection && effective.model.value && credentialReady && report.offline.usable)
  const reason = effective.unavailableConnection ? 'connection_unavailable' : !connection || !effective.model.value
    ? 'setup_required'
    : !report.offline.usable
      ? 'offline_blocked'
      : !credentialReady
        ? 'credential_missing'
        : 'ready_unverified'
  const state = reason === 'setup_required' ? 'setup_required' as const : configured ? 'configured_unverified' as const : 'action_required' as const
  return {
    state,
    reason,
    connection: connection?.id ?? null, provider: connection?.provider ?? null, model: effective.model.value,
    endpoint: connection?.baseUrl ?? 'provider default',
    selectionSource: effective.connection.source, modelSource: effective.model.source,
    credential: { required: report.credential.required, variable: report.credential.variable, present: report.credential.present },
    requestedModel: report.requested_model, resolvedProvider: report.resolved_provider, resolvedModel: report.resolved_model,
    alias: report.alias,
    operations: report.operations, authorityConformance: report.capabilities.authority_conformance,
    capabilities: report.capabilities, offline: report.offline, budget: report.budget,
    connectivity: 'unverified', observedModel: null,
    autoApply: effective.autoApply, workflow: effective.workflow, review: effective.review, budgetUsd: effective.budgetUsd,
    nextCommand: reason === 'connection_unavailable'
      ? 'Correct --connection or BABEL_CONNECTION, or choose a configured account with /provider use.'
      : !connection || !effective.model.value
      ? 'babel-harness setup'
      : !report.offline.usable
        ? 'Run online or select a local Ollama/loopback connection.'
        : !credentialReady
          ? 'babel-harness setup'
          : 'babel-harness work "Explain this project"',
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
