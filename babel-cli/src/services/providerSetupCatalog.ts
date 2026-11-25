/** Metadata-only discovery for explicitly checked setup connections. */
import { isOfflineRequested } from '../config/offlineMode.js'
import { COMMAND_CODE_BASE_URL, OPENROUTER_BASE_URL } from '../runners/providerEndpoint.js'
import type { ProviderId } from '../runners/providerRegistry.js'

type MetadataResult =
  | { status: 'authenticated' | 'public_catalog'; models: string[] }
  | { status: 'unavailable' | 'rejected' | 'offline' }

/** Pinned endpoints only. Custom hosts are not credential-check destinations. */
export function setupMetadataEndpoint(provider: ProviderId): string | undefined {
  if (provider === 'openrouter') return OPENROUTER_BASE_URL
  if (provider === 'command-code') return COMMAND_CODE_BASE_URL
  return undefined
}

/** Accept an exact ID, not terminal controls, whitespace or a pasted command. */
export function isSetupModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9_~][a-z0-9_./:~+-]{0,499}$/i.test(id)
}

async function readCatalog(response: Response): Promise<unknown> {
  const limit = 4 * 1024 * 1024
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty catalog response.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
      bytes += value.byteLength
      if (bytes > limit) {
        await reader.cancel()
        throw new Error('Catalog is too large.')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/** Call only after Check connection. No model, messages, or project data are sent. */
export async function checkSetupConnection(
  provider: ProviderId, key: string | undefined, env: NodeJS.ProcessEnv, signal?: AbortSignal,
): Promise<MetadataResult> {
  if (isOfflineRequested(env)) return { status: 'offline' }
  const endpoint = setupMetadataEndpoint(provider)
  const authenticatedCatalog = provider === 'openrouter'
  if (!endpoint || (authenticatedCatalog && !key)) return { status: 'unavailable' }
  const timeout = AbortSignal.timeout(8000)
  try {
    const response = await fetch(`${endpoint}${authenticatedCatalog ? '/models/user' : '/models'}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(authenticatedCatalog ? { Authorization: `Bearer ${key}` } : {}) },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok) {
      await response.body?.cancel()
      return { status: authenticatedCatalog && [401, 403].includes(response.status) ? 'rejected' : 'unavailable' }
    }
    const parsed = await readCatalog(response) as { data?: unknown } | null
    if (!Array.isArray(parsed?.data) || parsed.data.length > 5000) return { status: 'unavailable' }
    const models = new Set<string>()
    for (const item of parsed.data) {
      if (!item || typeof item !== 'object') continue
      const entry = item as { id?: unknown; supported_endpoints?: unknown; supported_parameters?: unknown; deprecated?: unknown }
      if (!isSetupModelId(entry.id) || (key && entry.id.includes(key)) || entry.deprecated === true) continue
      if (authenticatedCatalog) {
        if (entry.id.startsWith('openrouter/') || !Array.isArray(entry.supported_parameters) || !entry.supported_parameters.includes('tools')) continue
      } else if (!Array.isArray(entry.supported_endpoints) || !entry.supported_endpoints.includes('/chat/completions')) continue
      models.add(entry.id)
    }
    return { status: authenticatedCatalog ? 'authenticated' : 'public_catalog', models: [...models] }
  } catch {
    // Provider bodies and transport exceptions may contain key material. Do not print or persist them.
    return { status: 'unavailable' }
  }
}
