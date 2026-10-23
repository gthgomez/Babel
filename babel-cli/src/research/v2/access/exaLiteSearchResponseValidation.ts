import type { SourceAccessFailureCategory } from '../ports/sourceAccessTypes.js'

const MAX_DIAGNOSTIC_MESSAGE_LEN = 500
const MAX_DIAGNOSTIC_DETAILS_KEYS = 8
const MAX_DIAGNOSTIC_DETAIL_VALUE_LEN = 200

export interface ExaLiteDiagnosticRecord {
  code: string
  path: string | null
  message: string
  details: Record<string, string> | null
}

export interface SanitizedExaLiteReceiptMetadata {
  request_id: string | null
  resolved_search_type: string | null
  warnings: ExaLiteDiagnosticRecord[]
  notices: ExaLiteDiagnosticRecord[]
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

function sanitizeBoundedString(value: unknown, maxLen: number): string | null {
  const raw = asNonEmptyString(value)
  if (!raw) return null
  return raw.length > maxLen ? raw.slice(0, maxLen) : raw
}

function sanitizeDiagnosticDetails(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_DIAGNOSTIC_DETAILS_KEYS) break
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    out[key] = trimmed.length > MAX_DIAGNOSTIC_DETAIL_VALUE_LEN
      ? trimmed.slice(0, MAX_DIAGNOSTIC_DETAIL_VALUE_LEN)
      : trimmed
  }
  return Object.keys(out).length > 0 ? out : null
}

function sanitizeDiagnosticRecord(value: unknown, label: string, index: number): ExaLiteDiagnosticRecord {
  if (typeof value === 'string') {
    const message = sanitizeBoundedString(value, MAX_DIAGNOSTIC_MESSAGE_LEN)
    if (!message) {
      throw new ExaLiteResponseValidationError(
        `configured search provider ${label}[${index}] must be a diagnostic object or non-empty string`,
        'extraction_failed',
      )
    }
    return { code: 'provider_message', path: null, message, details: null }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExaLiteResponseValidationError(
      `configured search provider ${label}[${index}] must be a diagnostic object`,
      'extraction_failed',
    )
  }
  const record = value as Record<string, unknown>
  const code = sanitizeBoundedString(record.code, 120)
  const message = sanitizeBoundedString(record.message, MAX_DIAGNOSTIC_MESSAGE_LEN)
  if (!code || !message) {
    throw new ExaLiteResponseValidationError(
      `configured search provider ${label}[${index}] requires code and message`,
      'extraction_failed',
    )
  }
  return {
    code,
    path: sanitizeBoundedString(record.path, 240),
    message,
    details: sanitizeDiagnosticDetails(record.details),
  }
}

function sanitizeDiagnosticList(value: unknown, label: string): ExaLiteDiagnosticRecord[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ExaLiteResponseValidationError(
      `configured search provider ${label} must be an array`,
      'extraction_failed',
    )
  }
  return value.map((entry, index) => sanitizeDiagnosticRecord(entry, label, index))
}

function sanitizeNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null
  }
  return value
}

function sanitizeCostDollars(raw: unknown): {
  estimated_cost_dollars: number | null
  estimated_cost_detail: Record<string, number> | null
} {
  if (raw === null || raw === undefined) {
    return { estimated_cost_dollars: null, estimated_cost_detail: null }
  }
  if (typeof raw === 'number') {
    return { estimated_cost_dollars: null, estimated_cost_detail: null }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { estimated_cost_dollars: null, estimated_cost_detail: null }
  }
  const record = raw as Record<string, unknown>
  const detail: Record<string, number> = {}
  let total: number | null = null
  for (const [key, value] of Object.entries(record)) {
    if (key === 'total') {
      total = sanitizeNonNegativeNumber(value)
      continue
    }
    const amount = sanitizeNonNegativeNumber(value)
    if (amount !== null) {
      detail[key] = amount
    }
  }
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
      warnings: sanitizeDiagnosticList(root.warnings, 'warnings'),
      notices: sanitizeDiagnosticList(root.notices, 'notices'),
      estimated_cost_dollars: cost.estimated_cost_dollars,
      estimated_cost_detail: cost.estimated_cost_detail,
    },
  }
}
