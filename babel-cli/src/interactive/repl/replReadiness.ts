import type { SessionState } from '../types.js'
import { readUserSettings, userSettingsPath } from '../../config/userSettings.js'

/** Decode only explicit connection selectors, preserving the complete model ID. */
export function parseConnectionModelSelector(model: string | undefined): { connection: string; model: string } | null {
  if (!model?.startsWith('connection/')) return null
  const [, connection, ...parts] = model.split('/')
  const exactModel = parts.join('/')
  return connection && exactModel.trim() ? { connection, model: exactModel } : null
}

/** Admit a provider task only after local setup and a consistent model/account selection. */
export function hasProviderTaskPrerequisites(state: Pick<SessionState, 'model' | 'connectionId' | 'readinessState'>): boolean {
  if (state.readinessState !== 'configured_unverified' || !state.model?.trim()) return false
  if (!state.model.startsWith('connection/')) return true
  const selected = parseConnectionModelSelector(state.model)
  return Boolean(selected && state.connectionId === selected.connection)
}

/** Non-secret identity of an explicit connection; an unresolved route is not guessed. */
export interface SelectedProviderRoute {
  key: string; connection: string; provider: string; model: string
  endpoint: string | null; credentialReference: string | null; authentication: string | null
}

export function selectedProviderRoute(state: Pick<SessionState, 'model' | 'connectionId'>): SelectedProviderRoute | null {
  const selected = parseConnectionModelSelector(state.model)
  if (!selected || state.connectionId !== selected.connection) return null
  try {
    const settings = readUserSettings()
    if (!Object.hasOwn(settings.connections, selected.connection)) return null
    const account = settings.connections[selected.connection]
    if (!account) return null
    const route = { connection: selected.connection, provider: account.provider, model: selected.model,
      endpoint: account.baseUrl ?? null, credentialReference: account.apiKeyEnvVar ?? null,
      authentication: account.authentication ?? null }
    return { ...route, key: JSON.stringify([userSettingsPath(), route]) }
  } catch {
    return null
  }
}

/** Compare the selected configuration to the engine which will actually send. */
export function providerRouteMatchesEngine(route: SelectedProviderRoute, selection: {
  connection: string | null; provider: string | null; requestedModel: string | null
  endpoint: string | null; credentialReference: string | null; authentication: string | null
}): boolean {
  return selection.connection === route.connection && selection.provider === route.provider && selection.requestedModel === route.model &&
    selection.endpoint === route.endpoint && selection.credentialReference === route.credentialReference && selection.authentication === route.authentication
}
