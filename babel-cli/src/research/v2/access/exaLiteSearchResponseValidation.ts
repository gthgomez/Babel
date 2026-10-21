import type { SourceAccessFailureCategory } from '../ports/sourceAccessTypes.js'

export interface SanitizedExaLiteReceiptMetadata {
  request_id: string | null
  resolved_search_type: string | null
  warnings: string[]
  notices: string[]
  /** Provider-reported estimate only — not an invoice. */
  estimated_cost_dollars: number | null
  estimated_cost_detail: Record<string, number> | null
}

export interface ValidatedExaLiteSearchRow {
  title: string
  url: string
  highlights: string[]
}

export interface ValidatedExaLiteSearchResponse {
  results: ValidatedExaLiteSearchRow[]
  metadata: SanitizedExaLiteReceiptMetadata
}

export class ExaLiteResponseValidationError extends Error {
  readonly failureCategory: SourceAccessFailureCategory

  constructor(message: string, failureCategory: SourceAccessFailureCategory) {
    super(message)
    this.name = 'ExaLiteResponseValidationError'
    this.failureCategory = failureCategory
  }
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function sanitizeCostDollars(raw: unknown): {
  estimated_cost_dollars: number | null
  estimated_cost_detail: Record<string, number> | null
} {
  if (raw === null || raw === undefined) {
    return { estimated_cost_dollars: null, estimated_cost_detail: null }
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { estimated_cost_dollars: raw, estimated_cost_detail: null }
  }
  if (typeof raw !== 'object') {
    return { estimated_cost_dollars: null, estimated_cost_detail: null }
  }
  const record = raw as Record<string, unknown>
  const detail: Record<string, number> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      detail[key] = value
    }
  }
  const total =
    typeof record.total === 'number' && Number.isFinite(record.total)
      ? record.total
      : Object.values(detail).reduce((sum, n) => sum + n, 0) || null
  return {
    estimated_cost_dollars: total,
    estimated_cost_detail: Object.keys(detail).length > 0 ? detail : null,
  }
}

export function mapExaLiteHttpStatusToFailure(status: number): {
  failureCategory: SourceAccessFailureCategory
  message: string
} {
  if (status === 401 || status === 403) {
    return {
      failureCategory: 'search_provider_unavailable',
      message: 'configured search provider rejected the request',
    }
  }
  if (status === 402) {
    return {
      failureCategory: 'search_provider_unavailable',
      message: 'configured search provider billing precondition failed',
    }
  }
  if (status === 408) {
    return { failureCategory: 'timeout', message: 'configured search provider request timed out' }
  }
  if (status === 422) {
    return { failureCategory: 'policy_denied', message: 'configured search provider rejected request policy' }
  }
  if (status === 429) {
    return { failureCategory: 'rate_limited', message: 'configured search provider rate limited the request' }
  }
  if (status >= 500) {
    return { failureCategory: 'network_error', message: 'configured search provider server error' }
  }
  return {
    failureCategory: 'network_error',
    message: `configured search provider HTTP ${status}`,
  }
}

export function validateExaLiteSearchResponseBody(bodyText: string): ValidatedExaLiteSearchResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    throw new ExaLiteResponseValidationError(
      'configured search provider returned non-JSON body',
      'extraction_failed',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ExaLiteResponseValidationError(
      'configured search provider JSON root must be an object',
      'extraction_failed',
    )
  }
  const root = parsed as Record<string, unknown>
  if (!('results' in root)) {
    throw new ExaLiteResponseValidationError(
      'configured search provider JSON missing results array',
      'extraction_failed',
    )
  }
  if (!Array.isArray(root.results)) {
    throw new ExaLiteResponseValidationError(
      'configured search provider results must be an array',
      'extraction_failed',
    )
  }

  const results: ValidatedExaLiteSearchRow[] = []
  for (const [index, row] of root.results.entries()) {
    if (typeof row !== 'object' || row === null) {
      throw new ExaLiteResponseValidationError(
        `configured search provider results[${index}] must be an object`,
        'extraction_failed',
      )
    }
    const record = row as Record<string, unknown>
    const url = asNonEmptyString(record.url)
    if (!url) {
      throw new ExaLiteResponseValidationError(
        `configured search provider results[${index}].url must be a non-empty string`,
        'extraction_failed',
      )
    }
    const title = asNonEmptyString(record.title) ?? url
    let highlights: string[] = []
    if (Array.isArray(record.highlights)) {
      highlights = sanitizeStringList(record.highlights)
    } else if (record.contents && typeof record.contents === 'object') {
      const inner = (record.contents as { highlights?: unknown }).highlights
      highlights = sanitizeStringList(inner)
    }
    results.push({ title, url, highlights })
  }

  const cost = sanitizeCostDollars(root.costDollars ?? root.cost_dollars)
  return {
    results,
    metadata: {
      request_id: asNonEmptyString(root.requestId ?? root.request_id),
      resolved_search_type: asNonEmptyString(root.resolvedSearchType ?? root.resolved_search_type),
      warnings: sanitizeStringList(root.warnings),
      notices: sanitizeStringList(root.notices),
      estimated_cost_dollars: cost.estimated_cost_dollars,
      estimated_cost_detail: cost.estimated_cost_detail,
    },
  }
}
