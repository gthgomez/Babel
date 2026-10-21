import type { SourceAccessFailureCategory } from '../ports/sourceAccessTypes.js'
import { AdmittedNetworkPolicyError } from './admittedHttpGet.js'
import { ExaLiteCallerAbortError, ExaLiteOperationDeadlineError } from './exaLiteOperationAbort.js'

export interface ClassifiedExaLiteTransportFailure {
  failureCategory: SourceAccessFailureCategory
  message: string
  callerCancelled: boolean
}

export function classifyExaLiteTransportFailure(err: unknown): ClassifiedExaLiteTransportFailure {
  if (err instanceof ExaLiteCallerAbortError) {
    return {
      failureCategory: 'cancelled',
      message: 'search cancelled',
      callerCancelled: true,
    }
  }
  if (err instanceof ExaLiteOperationDeadlineError) {
    return {
      failureCategory: 'timeout',
      message: 'configured search provider request timed out',
      callerCancelled: false,
    }
  }
  const text = err instanceof Error ? err.message : String(err)
  if (/HTTP request timed out|operation deadline exceeded/i.test(text)) {
    return {
      failureCategory: 'timeout',
      message: 'configured search provider request timed out',
      callerCancelled: false,
    }
  }
  if (/exceeds configured maxBytes/i.test(text)) {
    return {
      failureCategory: 'truncated',
      message: 'configured search provider response exceeded size limit',
      callerCancelled: false,
    }
  }
  if (err instanceof AdmittedNetworkPolicyError) {
    return {
      failureCategory: 'policy_denied',
      message: 'configured search provider network policy blocked request',
      callerCancelled: false,
    }
  }
  return {
    failureCategory: 'network_error',
    message: 'configured search provider transport failed',
    callerCancelled: false,
  }
}
