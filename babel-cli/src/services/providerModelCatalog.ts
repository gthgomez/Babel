/** Explicit, credential-free public model metadata discovery. */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { isOfflineRequested } from '../config/offlineMode.js'
import { userSettingsPath } from '../config/userSettings.js'

const endpoints: Record<string, string> = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/models',
  'command-code': 'https://api.commandcode.ai/provider/v1/models',
})
const limit = 4 * 1024 * 1024
const modelId = /^[\w./:+-]{1,200}$/
type Catalog = { models: string[]; fetchedAt: string; source: string; qualification: 'unverified' }
type Cache = { schemaVersion: 1; providers: Record<string, Catalog> }
function pathFor(env: NodeJS.ProcessEnv) { return join(dirname(userSettingsPath(env)), 'model-catalog.json') }
function load(path: string): Cache {
  if (!existsSync(path)) return { schemaVersion: 1, providers: {} }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw new Error('The model catalog cache is unsafe; existing data was preserved.')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('The model catalog cache is invalid; existing data was preserved.') }
  if (!value || typeof value !== 'object' || (value as Cache).schemaVersion !== 1 || !(value as Cache).providers || typeof (value as Cache).providers !== 'object' || Array.isArray((value as Cache).providers)) throw new Error('The model catalog cache is invalid or unsupported; existing data was preserved.')
  for (const [provider, entry] of Object.entries((value as Cache).providers)) {
    if (!Object.hasOwn(endpoints, provider) || !entry || !Array.isArray(entry.models) || entry.models.length > 5000 || !entry.models.every(id => typeof id === 'string' && modelId.test(id)) || entry.source !== endpoints[provider] || typeof entry.fetchedAt !== 'string' || entry.qualification !== 'unverified') throw new Error('The model catalog cache is invalid; existing data was preserved.')
  }
  return value as Cache
}
export function readProviderModelCatalog(provider: string, env: NodeJS.ProcessEnv = process.env): Catalog | null {
  if (!Object.hasOwn(endpoints, provider)) return null
  try { return load(pathFor(env)).providers[provider] ?? null } catch { return null }
}
async function boundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); throw new Error('Provider model catalog exceeded the size limit.') }
  const reader = response.body?.getReader()
  if (!reader) { const text = await response.text(); if (Buffer.byteLength(text) > limit) throw new Error('Provider model catalog exceeded the size limit.'); return text }
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('Provider model catalog exceeded the size limit.') }; chunks.push(value) }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally { reader.releaseLock() }
}
/** Called only by an explicit user refresh; never submits an inference request. */
export async function refreshProviderModelCatalog(provider: string, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<Catalog> {
  const endpoint = Object.hasOwn(endpoints, provider) ? endpoints[provider]! : null
  if (!endpoint) throw new Error('Select an approved provider before refreshing models.')
  const env = options.env ?? process.env
  if (isOfflineRequested(env)) throw new Error('Offline mode cannot refresh models. Cached choices were retained.')
  const path = pathFor(env)
  load(path) // Refuse to overwrite malformed or unsafe existing data.
  let result: Catalog
  try {
    const timeout = AbortSignal.timeout(15000)
    const response = await (options.fetchImpl ?? fetch)(endpoint, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Model catalog request failed (HTTP ${response.status}). Cached choices were retained.`) }
    const body = await boundedBody(response)
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new Error('Provider returned an invalid model catalog.') }
    const data = (parsed as { data?: unknown })?.data
    if (!Array.isArray(data) || data.length > 5000) throw new Error('Provider returned an invalid model catalog.')
    const ids = new Set<string>()
    for (const item of data) {
      if (!item || typeof item !== 'object') continue
      const entry = item as { id?: unknown; supported_endpoints?: unknown; deprecated?: unknown }
      if (typeof entry.id !== 'string' || !modelId.test(entry.id) || entry.deprecated === true) continue
      if (provider === 'command-code' && (!Array.isArray(entry.supported_endpoints) || !entry.supported_endpoints.includes('/chat/completions'))) continue
      ids.add(entry.id)
    }
    result = { models: [...ids], fetchedAt: new Date().toISOString(), source: endpoint, qualification: 'unverified' }
  } catch (error) {
    if (error instanceof Error && /^(?:Model catalog request|Provider model catalog|Provider returned)/.test(error.message)) throw error
    throw new Error('Model catalog refresh failed or was cancelled. Cached choices were retained.')
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.babel-lock`; let fd: number
  try { fd = openSync(lock, 'wx', 0o600) } catch { throw new Error('Model catalog cache is locked. Retry the refresh.') }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const current = load(path), next = { ...current, providers: { ...current.providers, [provider]: result } }
    const content = JSON.stringify(next, null, 2) + '\n'
    if (Buffer.byteLength(content) > limit) throw new Error('Provider model catalog exceeded the size limit.')
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }); closeSync(fd); rmSync(lock, { force: true }) }
  return result
}
