/** Shared CLI/TUI application operations for non-secret connection preferences. */
import { resolve } from 'node:path'
import { getAvailableModels } from '../modelPolicy.js'
import { getProviderSpec, isProviderId, listProviderSpecs } from '../runners/providerRegistry.js'
import { readUserSettings, resolveEffectiveSettings, updateUserSettings, type Connection, type UserPreferences } from '../config/userSettings.js'
import { connectionModelSelector } from '../config/connectionModelPolicy.js'

export interface SelectionSession { [key: string]: unknown; connection?: string; model?: string | undefined }
export type SaveScope = 'user' | 'project'

/** Store only an explicit user choice; project scope remains in the private user profile. */
export function savePreferences(preferences: UserPreferences, scope: SaveScope, projectRoot = process.cwd()): void {
  if (scope === 'user') updateUserSettings({ defaults: preferences })
  else {
    const settings = readUserSettings()
    const key = resolve(projectRoot)
    updateUserSettings({ projects: { ...settings.projects, [key]: { ...settings.projects?.[key], ...preferences, ...(preferences.plans ? { plans: { ...settings.projects?.[key]?.plans, ...preferences.plans } } : {}) } } })
  }
}

/** Create an account configuration without selecting it or making a network call. */
export function connectProvider(provider: string, options: {
  name?: string; model?: string; baseUrl?: string; apiKeyEnvVar?: string; contextWindow?: number; maxOutputTokens?: number; authentication?: 'api-key' | 'none'
} = {}): Connection {
  if (!isProviderId(provider)) throw new Error('Unknown provider. Use babel-agent provider list.')
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
    nextCommand: !connection || !effective.model.value ? 'babel-agent setup' : !configured ? 'babel-agent setup' : 'babel-agent work "Explain this project"',
  }
}

/** Select a connection/model for the current session; persistence is explicit. */
export function selectConnection(id: string, session: SelectionSession, options: { save?: SaveScope; projectRoot?: string } = {}): SelectionSession {
  const connection = readUserSettings().connections[id]
  if (!connection) throw new Error('Unknown connection. Use provider list or provider connect.')
  const selection = { connection: id, model: connection.model }
  if (options.save) savePreferences(selection, options.save, options.projectRoot)
  return selection
}

/** Model IDs are scoped to a connection, never used to guess its provider. */
export function selectModel(model: string, session: SelectionSession, options: { save?: SaveScope; projectRoot?: string } = {}): SelectionSession {
  const effective = resolveEffectiveSettings({ session, ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}) })
  if (!effective.connection.value) throw new Error('Select a connection with provider use before selecting a model.')
  if (!model.trim() || model.length > 500 || /[\u0000-\u001f]/.test(model)) throw new Error('An exact model ID is required.')
  const selection = { connection: effective.connection.value.id, model: model.trim() }
  if (options.save) savePreferences(selection, options.save, options.projectRoot)
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
    models: getAvailableModels().filter(({ entry }) => entry.provider === provider).map(({ entry }) => ({ id: entry.model_id, contextWindow: entry.context_window ?? null, maxOutputTokens: entry.max_output_tokens ?? null })),
    manualEntry: 'model use <exact-model-id>', discovery: 'local catalog; live model discovery has not been requested' }
}
