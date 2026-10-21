import type { IncomingHttpHeaders } from 'node:http'
import type { AdmittedHttpGetResult } from './admittedHttpGet.js'

const MAX_PUBLIC_MESSAGE_CHARS = 512
const MAX_HEADER_VALUE_CHARS = 128
const MAX_BODY_PEEK_BYTES = 4_096

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
])

export interface SanitizedHttpFailureMetadata {
  public_message?: string
  request_id?: string
  retry_after?: string
  rate_limit_remaining?: string
  rate_limit_reset?: string
  rate_limit_resource?: string
}

function normalizeHeaderRecord(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value
  }
  return out
}

function firstHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()]
  if (raw === undefined) return undefined
  const joined = Array.isArray(raw) ? raw[0] : raw
  return joined
}

export function sanitizePublicHttpScalar(value: string, maxChars: number): string | undefined {
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!stripped) return undefined
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped
}

function sanitizePublicMessageFromBody(buffer: Buffer, contentType: string): string | undefined {
  if (buffer.length === 0) return undefined
  const peek = buffer.subarray(0, Math.min(buffer.length, MAX_BODY_PEEK_BYTES))
  const text = peek.toString('utf8')
  const looksJson =
    contentType.toLowerCase().includes('application/json') || text.trimStart().startsWith('{')
  if (!looksJson) return undefined
  try {
    const parsed = JSON.parse(text) as { message?: unknown }
    if (typeof parsed.message !== 'string') return undefined
    return sanitizePublicHttpScalar(parsed.message, MAX_PUBLIC_MESSAGE_CHARS)
  } catch {
    return undefined
  }
}

/**
 * Bounded, credential-free HTTP failure fields for acquisition diagnostics.
 * Never retains Authorization, cookies, or full response bodies.
 */
export function sanitizedHttpFailureMetadataFromGet(
  response: AdmittedHttpGetResult,
): SanitizedHttpFailureMetadata | undefined {
  if (response.ok) return undefined
  const headers = normalizeHeaderRecord(response.responseHeaders ?? {})
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key)) {
      delete headers[key]
    }
  }

  const requestIdRaw =
    firstHeaderValue(headers, 'x-github-request-id') ?? firstHeaderValue(headers, 'x-request-id')
  const retryAfterRaw = firstHeaderValue(headers, 'retry-after')
  const remainingRaw = firstHeaderValue(headers, 'x-ratelimit-remaining')
  const resetRaw = firstHeaderValue(headers, 'x-ratelimit-reset')
  const resourceRaw = firstHeaderValue(headers, 'x-ratelimit-resource')

  const metadata: SanitizedHttpFailureMetadata = {}
  const publicMessage = sanitizePublicMessageFromBody(response.buffer, response.contentType)
  if (publicMessage) metadata.public_message = publicMessage

  const requestId = requestIdRaw
    ? sanitizePublicHttpScalar(requestIdRaw, MAX_HEADER_VALUE_CHARS)
    : undefined
  if (requestId) metadata.request_id = requestId

  const retryAfter = retryAfterRaw
    ? sanitizePublicHttpScalar(retryAfterRaw, MAX_HEADER_VALUE_CHARS)
    : undefined
  if (retryAfter) metadata.retry_after = retryAfter

  const remaining = remainingRaw
    ? sanitizePublicHttpScalar(remainingRaw, MAX_HEADER_VALUE_CHARS)
    : undefined
  if (remaining) metadata.rate_limit_remaining = remaining

  const reset = resetRaw ? sanitizePublicHttpScalar(resetRaw, MAX_HEADER_VALUE_CHARS) : undefined
  if (reset) metadata.rate_limit_reset = reset

  const resource = resourceRaw
    ? sanitizePublicHttpScalar(resourceRaw, MAX_HEADER_VALUE_CHARS)
    : undefined
  if (resource) metadata.rate_limit_resource = resource

  return Object.keys(metadata).length > 0 ? metadata : undefined
}
