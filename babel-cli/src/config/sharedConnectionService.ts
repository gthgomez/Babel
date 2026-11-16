/** Canonical shared account metadata; secret values stay in the OS store. */
import { isApprovedProductProvider } from '../runners/providerRegistry.js'
import { createSharedCredentialStore, platformSharedCredentialStore } from './sharedCredentialStore.js'
import { readUserSettings, updateUserSettings } from './userSettings.js'

type Store = ReturnType<typeof createSharedCredentialStore>
type ApprovedProvider = 'openrouter' | 'command-code'
function providerAllowed(provider: string): asserts provider is ApprovedProvider {
  if (!isApprovedProductProvider(provider)) throw new Error('Choose an approved Babel provider.')
}

export function createSharedConnectionService(options: { path: string; store?: () => Store }) {
  const store = options.store ?? (() => platformSharedCredentialStore())
  const lookup = (id: string, provider: string) => {
    providerAllowed(provider)
    const connection = readUserSettings({ path: options.path }).connections[id]
    if (!connection || connection.provider !== provider || !connection.credentialRef) throw new Error('The shared connection is missing or has a different provider. Repair it before retrying.')
    return connection
  }
  return {
    reference(id: string, provider: string): string { return lookup(id, provider).credentialRef! },
    read(id: string, provider: string): string { return store().read(lookup(id, provider).credentialRef!) },
    register(input: { id: string; provider: string; model?: string; key: string }): string {
      providerAllowed(input.provider)
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/.test(input.id) || (input.model !== undefined && (!input.model.trim() || input.model.length > 500 || /[\u0000-\u001f]/.test(input.model)))) throw new Error('Invalid shared connection name or model; nothing was saved.')
      const existing = readUserSettings({ path: options.path }).connections[input.id]
      if (existing) {
        if (existing.provider !== input.provider || !existing.credentialRef || store().read(existing.credentialRef) !== input.key) throw new Error('A different connection already uses this name. Existing settings were preserved.')
        return existing.credentialRef
      }
      const reference = store().save(input.key)
      // The reference may be orphaned if this second durable write fails. Never
      // delete it automatically: the store outcome must remain recoverable.
      updateUserSettings(current => {
        if (current.connections[input.id]) throw new Error('The connection was created concurrently; existing settings were preserved.')
        return { connections: { [input.id]: { id: input.id, provider: input.provider as ApprovedProvider, credentialRef: reference, ...(input.model ? { model: input.model } : {}) } },
          ...(!current.defaults?.connection ? { defaults: { connection: input.id, ...(input.model ? { model: input.model } : {}) } } : {}) }
      }, { path: options.path })
      return reference
    },
    replace(id: string, provider: string, key: string): string {
      const prior = lookup(id, provider), reference = store().save(key)
      updateUserSettings(current => {
        const selected = current.connections[id]
        if (!selected || selected.provider !== provider || selected.credentialRef !== prior.credentialRef) throw new Error('The shared connection changed while saving. Review it before retrying.')
        return { connections: { [id]: { ...selected, credentialRef: reference } } }
      }, { path: options.path })
      return reference
    },
    remove(id: string, provider: string, onRemoved?: () => void): boolean {
      providerAllowed(provider)
      let removed = false
      updateUserSettings(current => {
        const connection = current.connections[id]
        if (!connection || connection.provider !== provider || !connection.credentialRef) throw new Error('The shared connection is missing or has a different provider.')
        removed = store().remove(connection.credentialRef)
        onRemoved?.()
        return {}
      }, { path: options.path })
      // Leave the reference in place: a missing key must not fall back to an
      // unrelated environment variable or a retained Desktop ciphertext.
      return removed
    },
  }
}
