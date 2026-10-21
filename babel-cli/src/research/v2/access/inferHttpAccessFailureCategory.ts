import type { SourceAcquisitionDiagnostics } from '../contracts/sourceAcquisitionDiagnostics.js'
import type { SourceAccessFailureCategory } from '../ports/sourceAccessTypes.js'

function messageHintsRateLimit(message: string | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return lower.includes('rate limit') || lower.includes('secondary rate limit')
}

function messageHintsAuth(message: string | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return (
    lower.includes('bad credentials') ||
    lower.includes('requires authentication') ||
    lower.includes('must authenticate') ||
    lower.includes('authentication failed')
  )
}

/**
 * Infer failure category from bounded HTTP evidence only. Returns `network_error` when
 * auth/rate/policy cannot be established from sanitized metadata (not from status alone).
 */
export function inferHttpAccessFailureCategory(params: {
  httpStatus: number
  httpFailure?: NonNullable<SourceAcquisitionDiagnostics['http_failure']>
}): SourceAccessFailureCategory {
  const { httpStatus, httpFailure } = params
  const publicMessage = httpFailure?.public_message

  if (httpStatus === 429) {
    return 'rate_limited'
  }
  if (httpStatus === 404) {
    return 'not_found'
  }

  const rateEvidence =
    httpFailure?.retry_after !== undefined ||
    httpFailure?.rate_limit_remaining !== undefined ||
    httpFailure?.rate_limit_reset !== undefined ||
    httpFailure?.rate_limit_resource !== undefined ||
    messageHintsRateLimit(publicMessage) ||
    (httpStatus === 403 &&
      httpFailure?.rate_limit_remaining === '0')

  if (rateEvidence) {
    return 'rate_limited'
  }

  if (httpStatus === 401 || (httpStatus === 403 && messageHintsAuth(publicMessage))) {
    return 'policy_denied'
  }

  return 'network_error'
}
