import { createCatalogSnapshot } from './catalog.js'
import { catalogCacheKey } from './catalog-cache.js'
import {
  composeCatalogSnapshot,
  mergeSourceResults,
  normalizeCatalog,
  type CatalogObservationBatch,
} from './catalog-normalize.js'
import { OPENROUTER_MODELS_URL, type OpenRouterModelEntry } from './openrouterMetadata.js'
import type {
  CatalogSnapshot,
  CatalogSourceCompleteness,
  CatalogSourceResult,
  CatalogSourceStatus,
} from './types.js'

/** The only configurable catalog source; only OpenRouter is implemented. */
export interface CatalogRefreshSource {
  sourceId: string
  url: string
  /** Non-secret account/endpoint scope; distinct scopes never share facts. */
  scopeId?: string
  /** Opaque non-secret credential provenance label, never a token. */
  credentialScope?: string
}

/** Input to {@link refreshCatalog}; every external effect is injectable. */
export interface CatalogRefreshInput {
  source: CatalogRefreshSource
  previous?: CatalogSnapshot
  /** Injected fetch. When omitted the refresh is offline and never uses network. */
  fetchImpl?: typeof fetch
  now?: () => Date
  timeoutMs?: number
  maxBytes?: number
  maxItems?: number
  /** Force the offline path even when a fetch implementation is supplied. */
  offline?: boolean
  /** Currently published snapshot, used to fence a slow refresh. */
  current?: () => CatalogSnapshot | undefined
}

/** Outcome of a catalog refresh with explicit source state. */
export interface CatalogRefreshResult {
  status: CatalogSourceStatus
  completeness: CatalogSourceCompleteness
  snapshot: CatalogSnapshot
  batch?: CatalogObservationBatch
  warnings: readonly string[]
  /** True when the previous snapshot was retained rather than replaced. */
  preservedPrevious: boolean
  /** True when a newer snapshot won and this refresh was not applied. */
  superseded: boolean
  /** True when the result came from an offline snapshot read. */
  fromCache: boolean
  startedAt: string
  completedAt: string
}

/** Typed, non-secret refresh failure with a machine-stable code. */
export class CatalogRefreshError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CatalogRefreshError'
    this.code = code
  }
}

export const OPENROUTER_CATALOG_SOURCE: CatalogRefreshSource = {
  sourceId: 'openrouter-catalog',
  url: OPENROUTER_MODELS_URL,
}

export const DEFAULT_REFRESH_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_CATALOG_BYTES = 8_000_000
export const DEFAULT_MAX_CATALOG_ITEMS = 20_000

const TRUSTED_CATALOG_HOSTS = new Set(['openrouter.ai'])

const inFlight = new Map<string, Promise<CatalogRefreshResult>>()

/**
 * Drop the in-flight refresh registry. Tests call this between cases; ordinary
 * runtime never needs to.
 */
export function resetCatalogRefreshInFlight(): void {
  inFlight.clear()
}

/**
 * Validate that a refresh URL points at the trusted local provider boundary.
 *
 * Community or remote metadata is data, never a dispatcher: a stored citation
 * may be any URL, but a fetch target must be https on a configured host with no
 * embedded credentials.
 */
export function assertTrustedCatalogSource(source: CatalogRefreshSource): URL {
  let url: URL
  try {
    url = new URL(source.url)
  } catch {
    throw new CatalogRefreshError(
      'untrusted_source',
      `Catalog source URL "${source.url}" is not an absolute URL.`,
    )
  }
  if (url.protocol !== 'https:') {
    throw new CatalogRefreshError(
      'untrusted_source',
      `Catalog source URL must use https, received "${url.protocol}".`,
    )
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new CatalogRefreshError(
      'untrusted_source',
      'Catalog source URL must not embed credentials.',
    )
  }
  if (!TRUSTED_CATALOG_HOSTS.has(url.hostname.toLowerCase())) {
    throw new CatalogRefreshError(
      'untrusted_source',
      `Catalog source host "${url.hostname}" is not a trusted catalog host.`,
    )
  }
  return url
}

/**
 * Refresh the configured OpenRouter catalog.
 *
 * Network access is opt-in through `fetchImpl`; without it this returns the
 * previous snapshot (offline start) and never reaches the network. Concurrent
 * callers for the same identity share one in-flight refresh. A slow refresh
 * that completes after a newer snapshot is published is fenced and cannot
 * overwrite it. The function never mutates routing policy or qualifications.
 */
export async function refreshCatalog(input: CatalogRefreshInput): Promise<CatalogRefreshResult> {
  const now = input.now ?? (() => new Date())
  const startedAt = now().toISOString()

  if (input.offline === true || input.fetchImpl === undefined) {
    return offlineResult(input, startedAt, now())
  }

  const url = assertTrustedCatalogSource(input.source)
  const identity = {
    sourceId: input.source.sourceId,
    endpoint: url.toString(),
    ...(input.source.scopeId === undefined ? {} : { scopeId: input.source.scopeId }),
    ...(input.source.credentialScope === undefined
      ? {}
      : { credentialScope: input.source.credentialScope }),
  }
  const key = catalogCacheKey(identity)
  const existing = inFlight.get(key)
  if (existing) return existing

  const pending = performOnlineRefresh(input, url, startedAt, now)
  inFlight.set(key, pending)
  try {
    return await pending
  } finally {
    inFlight.delete(key)
  }
}

async function performOnlineRefresh(
  input: CatalogRefreshInput,
  url: URL,
  startedAt: string,
  now: () => Date,
): Promise<CatalogRefreshResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_CATALOG_BYTES
  const maxItems = input.maxItems ?? DEFAULT_MAX_CATALOG_ITEMS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response: Response
    try {
      response = await input.fetchImpl!(url.toString(), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        // Never auto-follow a redirect: the trusted-host check applies to the
        // configured URL, and a redirect is data that could point elsewhere.
        redirect: 'manual',
      })
    } catch (error) {
      return failureResult(
        input,
        startedAt,
        now(),
        'unavailable',
        [`Catalog refresh request failed: ${describeError(error)}`],
      )
    }

    if (response.status === 401 || response.status === 403) {
      return failureResult(input, startedAt, now(), 'unauthorized', [
        `Catalog source rejected the request with HTTP ${response.status}.`,
      ])
    }
    if (!response.ok) {
      // A manual 3xx is deliberately not followed and is reported as a failure.
      const status: CatalogSourceStatus = response.status >= 500 ? 'unavailable' : 'failed'
      return failureResult(input, startedAt, now(), status, [
        `Catalog source replied with HTTP ${response.status}.`,
      ])
    }

    // The abort timer stays armed through the body read so a slow-drip body is
    // interrupted, and the reader stops at the byte cap instead of buffering an
    // unbounded response.
    let text: string
    try {
      text = await readBoundedBodyText(response, maxBytes, controller)
    } catch (error) {
      if (error instanceof CatalogRefreshError && error.code === 'response_too_large') {
        return failureResult(input, startedAt, now(), 'failed', [
          `Catalog response exceeded the ${maxBytes} byte bound.`,
        ])
      }
      return failureResult(input, startedAt, now(), 'unavailable', [
        `Catalog response body could not be read: ${describeError(error)}`,
      ])
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return failureResult(input, startedAt, now(), 'failed', [
        'Catalog response was not valid JSON.',
      ])
    }

    let sanitized: { entries: OpenRouterModelEntry[]; warnings: string[] }
    try {
      sanitized = sanitizeCatalogPayload(body, maxItems)
    } catch (error) {
      return failureResult(input, startedAt, now(), 'failed', [describeError(error)])
    }

    // A 200 alone does not prove the full catalog was returned; only an
    // explicit signal may mark the read complete.
    const completeness = derivePayloadCompleteness(response, body, sanitized.entries.length)
    const warnings = [...sanitized.warnings, ...completeness.warnings]

    const completedAt = now().toISOString()

    // A refresh that finishes after a newer snapshot was published must not win.
    const current = input.current?.()
    if (current && Date.parse(current.observedAt) > Date.parse(startedAt)) {
      return {
        status: 'ok',
        completeness: 'complete',
        snapshot: current,
        warnings: ['A newer catalog snapshot was already published; refresh was not applied.'],
        preservedPrevious: true,
        superseded: true,
        fromCache: false,
        startedAt,
        completedAt,
      }
    }

    const endpoint = url.toString()
    const batch = normalizeCatalog({
      sourceId: input.source.sourceId,
      ...(input.source.scopeId === undefined ? {} : { scopeId: input.source.scopeId }),
      endpoint,
      status: 'ok',
      completeness: completeness.completeness,
      fetchedAt: completedAt,
      models: sanitized.entries,
      warnings,
    })
    const snapshot = composeCatalogSnapshot(input.previous, batch)
    return {
      status: 'ok',
      completeness: completeness.completeness,
      snapshot,
      batch,
      warnings: [...warnings],
      preservedPrevious: false,
      superseded: false,
      fromCache: false,
      startedAt,
      completedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read a response body under an explicit byte cap.
 *
 * `response.text()` would buffer the whole body before the cap is applied, so
 * an oversized or slow-drip response could exhaust memory or outlive its
 * deadline. This reader stops as soon as the cap is crossed, aborts the shared
 * signal and never decodes the rejected bytes.
 */
async function readBoundedBodyText(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const stream = response.body
  if (stream === null) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      if (total + value.byteLength > maxBytes) {
        controller.abort()
        try {
          await reader.cancel()
        } catch {
          // Cancellation is best-effort; the byte bound already rejected it.
        }
        throw new CatalogRefreshError(
          'response_too_large',
          `Catalog response exceeded the ${maxBytes} byte bound.`,
        )
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The reader may already be closed or cancelled.
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface PayloadCompleteness {
  completeness: CatalogSourceCompleteness
  warnings: string[]
}

/**
 * Derive source completeness from an explicit signal only.
 *
 * A 200 response is not proof that the full catalog was returned: an
 * unpaginated gateway may hand back a truncated page. Only a total/count equal
 * to the returned row count, or an explicit `has_more: false`, is authoritative.
 * Without such a signal the read is `partial`, so absent rows are never read as
 * removals.
 */
function derivePayloadCompleteness(
  response: Response,
  body: unknown,
  rowCount: number,
): PayloadCompleteness {
  const root = objectValue(body)
  const total =
    numericValue(response.headers.get('x-total-count')) ??
    numericValue(root?.['total']) ??
    numericValue(root?.['count'])
  if (total !== undefined) {
    if (total === rowCount) return { completeness: 'complete', warnings: [] }
    return {
      completeness: 'partial',
      warnings: [
        `Catalog completeness signal reported ${total} rows but ${rowCount} were returned; treating the read as partial.`,
      ],
    }
  }
  if (root?.['has_more'] === false) return { completeness: 'complete', warnings: [] }
  const advertisedNextPage =
    root?.['has_more'] === true || linkHeaderHasNext(response.headers.get('link'))
  return {
    completeness: 'partial',
    warnings: [
      advertisedNextPage
        ? 'Catalog response advertised a next page; treating the read as partial.'
        : 'Catalog response carried no completeness signal; treating the read as partial.',
    ],
  }
}

function linkHeaderHasNext(link: string | null): boolean {
  return link !== null && /rel\s*=\s*"?next"?/i.test(link)
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
  }
  return undefined
}


function offlineResult(
  input: CatalogRefreshInput,
  startedAt: string,
  completed: Date,
): CatalogRefreshResult {
  const completedAt = completed.toISOString()
  const previous = input.previous
  if (previous) {
    const state = sourceStateFromSnapshot(previous, input.source.sourceId)
    return {
      status: state.status,
      completeness: state.completeness,
      snapshot: previous,
      warnings: ['Catalog refresh is offline; using the last-known-good snapshot.'],
      preservedPrevious: true,
      superseded: false,
      fromCache: true,
      startedAt,
      completedAt,
    }
  }
  const snapshot = createCatalogSnapshot({
    observedAt: completedAt,
    sourceResults: [
      {
        sourceId: input.source.sourceId,
        ...(input.source.scopeId === undefined ? {} : { scopeId: input.source.scopeId }),
        status: 'unavailable',
        completeness: 'unknown',
        fetchedAt: completedAt,
        warnings: ['No catalog snapshot is available offline.'],
      },
    ],
    labModels: [],
    providerModels: [],
  })
  return {
    status: 'unavailable',
    completeness: 'unknown',
    snapshot,
    warnings: ['No catalog snapshot is available offline.'],
    preservedPrevious: false,
    superseded: false,
    fromCache: false,
    startedAt,
    completedAt,
  }
}

function failureResult(
  input: CatalogRefreshInput,
  startedAt: string,
  completed: Date,
  status: CatalogSourceStatus,
  warnings: readonly string[],
): CatalogRefreshResult {
  const completedAt = completed.toISOString()
  const completeness: CatalogSourceCompleteness = status === 'partial' ? 'partial' : 'unknown'
  const result: CatalogSourceResult = {
    sourceId: input.source.sourceId,
    ...(input.source.scopeId === undefined ? {} : { scopeId: input.source.scopeId }),
    status,
    completeness,
    fetchedAt: completedAt,
    warnings: [...warnings],
  }
  const previous = input.previous
  if (!previous) {
    return {
      status,
      completeness,
      snapshot: createCatalogSnapshot({
        observedAt: completedAt,
        sourceResults: [result],
        labModels: [],
        providerModels: [],
      }),
      warnings,
      preservedPrevious: false,
      superseded: false,
      fromCache: false,
      startedAt,
      completedAt,
    }
  }
  return {
    status,
    completeness,
    snapshot: createCatalogSnapshot({
      observedAt: previous.observedAt,
      sourceResults: mergeSourceResults(previous.sourceResults, [result]),
      labModels: previous.labModels,
      providerModels: previous.providerModels,
    }),
    warnings,
    preservedPrevious: true,
    superseded: false,
    fromCache: false,
    startedAt,
    completedAt,
  }
}

function sourceStateFromSnapshot(
  snapshot: CatalogSnapshot,
  sourceId: string,
): { status: CatalogSourceStatus; completeness: CatalogSourceCompleteness } {
  const matching = snapshot.sourceResults.filter((entry) => entry.sourceId === sourceId)
  const last = matching[matching.length - 1]
  return {
    status: last?.status ?? 'unavailable',
    completeness: last?.completeness ?? 'unknown',
  }
}

interface SanitizedCatalogPayload {
  entries: OpenRouterModelEntry[]
  warnings: string[]
}

/**
 * Validate catalog payload structure and numeric units, copying only known-safe
 * fields. Unknown keys (for example `endpoint`, `api_key` or `import`) are
 * ignored so remote metadata cannot become transport configuration.
 */
function sanitizeCatalogPayload(body: unknown, maxItems: number): SanitizedCatalogPayload {
  const root = objectValue(body)
  if (!root || !Array.isArray(root['data'])) {
    throw new CatalogRefreshError(
      'malformed_payload',
      'Catalog payload must be an object with a data array.',
    )
  }
  const data = root['data'] as unknown[]
  if (data.length > maxItems) {
    throw new CatalogRefreshError(
      'too_many_items',
      `Catalog payload has ${data.length} items, above the ${maxItems} item bound.`,
    )
  }
  const entries: OpenRouterModelEntry[] = []
  const warnings: string[] = []
  data.forEach((value, index) => {
    const item = objectValue(value)
    const id = item ? stringValue(item['id']) : undefined
    if (!item || id === undefined) {
      warnings.push(`Skipped catalog item ${index} without a string id.`)
      return
    }
    entries.push(sanitizeEntry(id, item, index, warnings))
  })
  return { entries, warnings }
}

function sanitizeEntry(
  id: string,
  item: Record<string, unknown>,
  index: number,
  warnings: string[],
): OpenRouterModelEntry {
  const entry: OpenRouterModelEntry = { id }
  const canonicalSlug = stringValue(item['canonical_slug'])
  if (canonicalSlug !== undefined) entry.canonical_slug = canonicalSlug

  const aliasTarget = objectValue(item['alias_target'])
  if (aliasTarget) {
    const name = stringValue(aliasTarget['name'])
    const slug = stringValue(aliasTarget['slug'])
    entry.alias_target = {
      ...(name === undefined ? {} : { name }),
      ...(slug === undefined ? {} : { slug }),
    }
  }

  const created = positiveSafeInteger(item['created'], `item ${index} created`, warnings)
  if (created !== undefined) entry.created = created
  const contextLength = positiveSafeInteger(
    item['context_length'],
    `item ${index} context_length`,
    warnings,
  )
  if (contextLength !== undefined) entry.context_length = contextLength

  const architecture = objectValue(item['architecture'])
  if (architecture) {
    const modality = stringValue(architecture['modality'])
    const tokenizer = stringValue(architecture['tokenizer'])
    const inputModalities = stringArray(architecture['input_modalities'])
    const outputModalities = stringArray(architecture['output_modalities'])
    entry.architecture = {
      ...(modality === undefined ? {} : { modality }),
      ...(inputModalities === undefined ? {} : { input_modalities: inputModalities }),
      ...(outputModalities === undefined ? {} : { output_modalities: outputModalities }),
      ...(tokenizer === undefined ? {} : { tokenizer }),
    }
  }

  const pricing = objectValue(item['pricing'])
  if (pricing) {
    const prompt = priceString(pricing['prompt'], `item ${index} pricing.prompt`, warnings)
    const completion = priceString(
      pricing['completion'],
      `item ${index} pricing.completion`,
      warnings,
    )
    const cacheRead = priceString(
      pricing['input_cache_read'],
      `item ${index} pricing.input_cache_read`,
      warnings,
    )
    const cacheWrite = priceString(
      pricing['input_cache_write'],
      `item ${index} pricing.input_cache_write`,
      warnings,
    )
    entry.pricing = {
      ...(prompt === undefined ? {} : { prompt }),
      ...(completion === undefined ? {} : { completion }),
      ...(cacheRead === undefined ? {} : { input_cache_read: cacheRead }),
      ...(cacheWrite === undefined ? {} : { input_cache_write: cacheWrite }),
    }
  }

  const topProvider = objectValue(item['top_provider'])
  if (topProvider) {
    const providerContext = positiveSafeInteger(
      topProvider['context_length'],
      `item ${index} top_provider.context_length`,
      warnings,
    )
    const maxCompletion = positiveSafeInteger(
      topProvider['max_completion_tokens'],
      `item ${index} top_provider.max_completion_tokens`,
      warnings,
    )
    entry.top_provider = {
      ...(providerContext === undefined ? {} : { context_length: providerContext }),
      ...(maxCompletion === undefined ? {} : { max_completion_tokens: maxCompletion }),
    }
  }

  const supported = stringArray(item['supported_parameters'])
  if (supported !== undefined) entry.supported_parameters = supported

  if (item['expiration_date'] === null) {
    entry.expiration_date = null
  } else {
    const expiration = stringValue(item['expiration_date'])
    if (expiration !== undefined) entry.expiration_date = expiration
  }

  const reasoning = objectValue(item['reasoning'])
  if (reasoning) {
    const efforts = stringArray(reasoning['supported_efforts'])
    const defaultEffort = stringValue(reasoning['default_effort'])
    entry.reasoning = {
      ...(typeof reasoning['mandatory'] === 'boolean'
        ? { mandatory: reasoning['mandatory'] }
        : {}),
      ...(typeof reasoning['default_enabled'] === 'boolean'
        ? { default_enabled: reasoning['default_enabled'] }
        : {}),
      ...(efforts === undefined ? {} : { supported_efforts: efforts }),
      ...(defaultEffort === undefined ? {} : { default_effort: defaultEffort }),
    }
  }

  return entry
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length === value.length ? items : undefined
}

function positiveSafeInteger(value: unknown, label: string, warnings: string[]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    warnings.push(`Dropped ${label} because it is not a positive safe integer.`)
    return undefined
  }
  return value
}

function priceString(value: unknown, label: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    warnings.push(`Dropped ${label} because it is not a decimal string.`)
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    warnings.push(`Dropped ${label} because it is not a non-negative price.`)
    return undefined
  }
  return value
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
