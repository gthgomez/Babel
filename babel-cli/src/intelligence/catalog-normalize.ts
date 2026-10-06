import { createCatalogSnapshot } from './catalog.js'
import { hashCanonical } from './hash.js'
import { modelRefKey } from './model-ref.js'
import {
  normalizeOpenRouterModelMetadata,
  selectOpenRouterModelEntry,
  type OpenRouterModelEntry,
} from './openrouterMetadata.js'
import type {
  CapabilityEvidence,
  CatalogSnapshot,
  CatalogSourceCompleteness,
  CatalogSourceResult,
  CatalogSourceStatus,
  LabModelSpec,
  LimitEvidence,
  ProviderModelProfile,
} from './types.js'

/**
 * One read of the configured OpenRouter catalog path.
 *
 * Status and completeness travel with the facts so an outage, an unauthorized
 * account or a truncated page can never be mistaken for an authoritative empty
 * catalog. Only the configured OpenRouter source is implemented; other
 * providers are intentionally out of scope.
 */
export interface CatalogSourceInput {
  sourceId: string
  /** Non-secret account/endpoint scope; distinct scopes never share facts. */
  scopeId?: string
  endpoint?: string
  status: CatalogSourceStatus
  completeness: CatalogSourceCompleteness
  fetchedAt: string
  /** Already-parsed OpenRouter entries from the configured source. */
  models: readonly OpenRouterModelEntry[]
  /** Exact-case selectors to normalize; defaults to every provided entry. */
  requestedModels?: readonly string[]
  warnings?: readonly string[]
}

/** Normalized observations ready to compose into an immutable snapshot. */
export interface CatalogObservationBatch {
  sourceId: string
  scopeId?: string
  endpoint?: string
  status: CatalogSourceStatus
  completeness: CatalogSourceCompleteness
  fetchedAt: string
  labModels: readonly LabModelSpec[]
  providerModels: readonly ProviderModelProfile[]
  sourceResults: readonly CatalogSourceResult[]
  warnings: readonly string[]
}

/**
 * Normalize OpenRouter catalog entries into lab and provider profiles while
 * preserving the capability/limit evidence owned by {@link LabModelSpec} and
 * {@link ProviderModelProfile}.
 *
 * This is a pure projection: it never fetches, never retires a model and never
 * touches routing policy. The caller supplies status/completeness explicitly.
 */
export function normalizeCatalog(source: CatalogSourceInput): CatalogObservationBatch {
  if (typeof source.sourceId !== 'string' || source.sourceId.length === 0) {
    throw new Error('Catalog source requires a non-empty sourceId.')
  }
  const warnings = [...(source.warnings ?? [])]
  const selectors = source.requestedModels
  const selected =
    selectors === undefined || selectors.length === 0
      ? [...source.models]
      : selectors.flatMap((selector) => {
          const selection = selectOpenRouterModelEntry(source.models, selector)
          if (!selection) {
            warnings.push(`Catalog source did not contain requested model "${selector}".`)
            return []
          }
          return [selection.entry]
        })

  const labModels: LabModelSpec[] = []
  const providerModels: ProviderModelProfile[] = []
  const seen = new Set<string>()
  for (const entry of selected) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      warnings.push('Skipped a catalog entry without a provider model id.')
      continue
    }
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    const normalized = normalizeOpenRouterModelMetadata({
      requestedModel: entry.id,
      entry,
      observedAt: source.fetchedAt,
    })
    labModels.push(normalized.labModel)
    providerModels.push(normalized.providerProfile)
  }

  const sourceResult = buildSourceResult(source, warnings)
  return {
    sourceId: source.sourceId,
    ...(source.scopeId === undefined ? {} : { scopeId: source.scopeId }),
    ...(source.endpoint === undefined ? {} : { endpoint: source.endpoint }),
    status: source.status,
    completeness: source.completeness,
    fetchedAt: source.fetchedAt,
    labModels,
    providerModels,
    sourceResults: [sourceResult],
    warnings,
  }
}

function buildSourceResult(
  source: CatalogSourceInput,
  warnings: readonly string[],
): CatalogSourceResult {
  const contentDigest = hashCanonical({
    sourceId: source.sourceId,
    models: source.models,
  })
  return {
    sourceId: source.sourceId,
    ...(source.scopeId === undefined ? {} : { scopeId: source.scopeId }),
    status: source.status,
    completeness: source.completeness,
    fetchedAt: source.fetchedAt,
    contentDigest,
    ...(warnings.length === 0 ? {} : { warnings: [...warnings] }),
  }
}

/**
 * Compose normalized observations with an optional previous snapshot.
 *
 * A successful-complete batch is authoritative for the models it lists: absent
 * rows may mean removal. Authoritative removal is scoped to the batch's own
 * source+scope: when the previous snapshot also holds facts owned by another
 * source, a complete read of this source cannot speak for those models, so they
 * are retained rather than retired. A partial, unavailable, unauthorized or
 * failed batch is never authoritative, so previous facts are retained and
 * absence is not treated as retirement. Previous facts for the same identity are
 * superseded by the incoming batch.
 */
export function composeCatalogSnapshot(
  previous: CatalogSnapshot | undefined,
  batch: CatalogObservationBatch,
): CatalogSnapshot {
  const sourceResults = mergeSourceResults(previous?.sourceResults ?? [], batch.sourceResults)
  // Removal is only authoritative for models this batch's source+scope owns.
  // A previous source result with a different source+scope means foreign facts
  // are present that this read cannot retire.
  const ownsPreviousSnapshot = (previous?.sourceResults ?? []).every(
    (entry) =>
      entry.sourceId === batch.sourceId &&
      (entry.scopeId ?? undefined) === (batch.scopeId ?? undefined),
  )
  const authoritative =
    batch.status === 'ok' && batch.completeness === 'complete' && ownsPreviousSnapshot

  if (authoritative) {
    return createCatalogSnapshot({
      observedAt: batch.fetchedAt,
      sourceResults,
      labModels: batch.labModels,
      providerModels: batch.providerModels,
    })
  }

  const providerModels = new Map<string, ProviderModelProfile>()
  for (const profile of previous?.providerModels ?? []) {
    providerModels.set(
      modelRefKey({ provider: profile.provider, modelId: profile.providerModelId }),
      profile,
    )
  }
  for (const profile of batch.providerModels) {
    providerModels.set(
      modelRefKey({ provider: profile.provider, modelId: profile.providerModelId }),
      profile,
    )
  }
  const labModels = new Map<string, LabModelSpec>()
  for (const model of previous?.labModels ?? []) {
    labModels.set(model.canonicalModelId, model)
  }
  for (const model of batch.labModels) {
    labModels.set(model.canonicalModelId, model)
  }
  return createCatalogSnapshot({
    observedAt: batch.fetchedAt,
    sourceResults,
    labModels: [...labModels.values()],
    providerModels: [...providerModels.values()],
  })
}

/** Combine source results, replacing entries for the same source+scope. */
export function mergeSourceResults(
  previous: readonly CatalogSourceResult[],
  incoming: readonly CatalogSourceResult[],
): CatalogSourceResult[] {
  const result = new Map<string, CatalogSourceResult>()
  for (const entry of previous) {
    result.set(sourceResultKey(entry), entry)
  }
  for (const entry of incoming) {
    result.set(sourceResultKey(entry), entry)
  }
  return [...result.values()]
}

function sourceResultKey(entry: CatalogSourceResult): string {
  return JSON.stringify([entry.sourceId, entry.scopeId ?? null])
}

/** Result of validating provenance/freshness for every dated catalog fact. */
export interface CatalogFreshnessResult {
  status: 'pass' | 'fail'
  checkedAt: string
  issues: string[]
}

/** Freshness/provenance validation input for a normalized observation batch. */
export interface CatalogFreshnessInput {
  batch: CatalogObservationBatch
  now: Date
  /** Maximum accepted age of a dated fact, regardless of fact group. */
  maxAgeDays?: number
}

/**
 * Validate source provenance and observation freshness for every fact group in
 * a batch, including models that only carry limits.
 *
 * The check is driven by the presence of dated facts, not by incidental price
 * or capability arrays, so a limits-only model cannot silently skip validation.
 */
export function validateCatalogFreshness(input: CatalogFreshnessInput): CatalogFreshnessResult {
  const maxAgeDays = input.maxAgeDays ?? 30
  const nowMs = input.now.getTime()
  const cutoff = nowMs - maxAgeDays * 86_400_000
  const issues: string[] = []

  for (const model of input.batch.labModels) {
    const label = `lab:${model.canonicalModelId}`
    checkSourceEvidence(issues, label, model.sourceEvidence, nowMs, cutoff)
    checkLimitEvidence(issues, `${label}.limits`, model.limitEvidence, nowMs, cutoff)
    for (const [capability, observation] of Object.entries(model.nativeCapabilities)) {
      checkCapabilityEvidence(issues, `${label}.${capability}`, observation?.evidence, nowMs, cutoff)
    }
  }

  for (const profile of input.batch.providerModels) {
    const label = `provider:${profile.provider}/${profile.providerModelId}`
    checkSourceEvidence(issues, label, profile.sourceEvidence, nowMs, cutoff)
    checkLimitEvidence(issues, `${label}.limits`, profile.limitEvidence, nowMs, cutoff)
    checkCapabilityEvidence(issues, `${label}.observed`, profile.observedEvidence, nowMs, cutoff)
    for (const endpoint of profile.endpointProfiles ?? []) {
      const endpointLabel = `${label}.endpoint:${endpoint.endpointId}`
      checkSourceEvidence(issues, endpointLabel, endpoint.sourceEvidence, nowMs, cutoff)
      checkLimitEvidence(issues, `${endpointLabel}.limits`, endpoint.limitEvidence, nowMs, cutoff)
    }
  }

  return {
    status: issues.length === 0 ? 'pass' : 'fail',
    checkedAt: input.now.toISOString(),
    issues,
  }
}

function checkSourceEvidence(
  issues: string[],
  label: string,
  evidence: readonly { source: string; uri?: string; retrievedAt: string }[] | undefined,
  nowMs: number,
  cutoff: number,
): void {
  if (evidence === undefined || evidence.length === 0) {
    issues.push(`${label}: missing source provenance.`)
    return
  }
  for (const entry of evidence) {
    if (typeof entry.source !== 'string' || entry.source.length === 0) {
      issues.push(`${label}: source provenance has no source label.`)
    }
    if (entry.uri !== undefined && !/^https:\/\//.test(entry.uri)) {
      issues.push(`${label}: source uri must be an absolute https URL.`)
    }
    checkObservedAt(issues, label, entry.retrievedAt, nowMs, cutoff)
  }
}

function checkLimitEvidence(
  issues: string[],
  label: string,
  evidence: readonly LimitEvidence[] | undefined,
  nowMs: number,
  cutoff: number,
): void {
  for (const entry of evidence ?? []) {
    if (entry.value !== undefined && (!Number.isSafeInteger(entry.value) || entry.value <= 0)) {
      issues.push(`${label}: ${entry.field} must be a positive safe integer.`)
    }
    checkObservedAt(issues, `${label}.${entry.field}`, entry.observedAt, nowMs, cutoff)
  }
}

function checkCapabilityEvidence(
  issues: string[],
  label: string,
  evidence: readonly CapabilityEvidence[] | undefined,
  nowMs: number,
  cutoff: number,
): void {
  for (const entry of evidence ?? []) {
    checkObservedAt(issues, `${label}.${entry.capability}`, entry.observedAt, nowMs, cutoff)
  }
}

function checkObservedAt(
  issues: string[],
  label: string,
  observedAt: string,
  nowMs: number,
  cutoff: number,
): void {
  const parsed = Date.parse(observedAt)
  if (!Number.isFinite(parsed)) {
    issues.push(`${label}: observedAt "${observedAt}" is not a valid date.`)
    return
  }
  if (parsed > nowMs) {
    issues.push(`${label}: observedAt "${observedAt}" is in the future.`)
    return
  }
  if (parsed < cutoff) {
    issues.push(`${label}: observedAt "${observedAt}" is older than the freshness window.`)
  }
}
