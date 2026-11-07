import type { ProviderId } from './providerRegistry.js'

/** Codes are provider-controlled text; retain only recognized operational facts. */
export function safeProviderErrorCode(code: string | null | undefined): string | null {
  return code && ['model_not_allowed', 'model_access_denied', 'permission_denied', 'insufficient_permissions', 'access_denied', 'organization_restricted', 'account_deactivated', 'invalid_api_key', 'authentication_error', 'rate_limit', 'rate_limit_exceeded', 'billing_required', 'insufficient_credits', 'insufficient_quota'].includes(code) ? code : null
}

/** Transport facts retained across orchestration without embedding provider response bodies. */
export class ProviderHttpError extends Error {
  readonly retryable: boolean
  readonly apiErrorCode: string | null
  constructor(readonly provider: ProviderId, readonly model: string, readonly status: number,
    readonly stage: 'response' | 'stream_retry', readonly requestId: string | null, message: string, code?: string | null) {
    const safeCode = safeProviderErrorCode(code)
    super(safeCode ? `${message} [${safeCode}]` : message)
    this.name = 'ProviderHttpError'
    this.apiErrorCode = safeCode
    this.retryable = [408, 429, 500, 502, 503, 504].includes(status)
  }
}
