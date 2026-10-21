import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { SourceAdapterReadResult } from '../../ports/sourceAdapter.js'
import type { SourceFetchResult } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'

export function cancelledRead(operationId: string): SourceAdapterReadResult {
  return { operationId, status: 'cancelled' }
}

export function bindingFailed(operationId: string, message: string): SourceAdapterReadResult {
  return {
    operationId,
    status: 'failed',
    failureCategory: 'contract_violation',
    message,
  }
}

export function assertReadPreconditions(
  operationId: string,
  source: SourceRecord,
  signal: AbortSignal,
): SourceAdapterReadResult | null {
  if (signal.aborted) return cancelledRead(operationId)
  if (!source.source_id?.trim()) {
    return bindingFailed(operationId, 'read request missing source_id')
  }
  return null
}

export function validateFetchBinding(
  operationId: string,
  source: SourceRecord,
  fetched: SourceFetchResult,
  signal: AbortSignal,
): SourceAdapterReadResult | null {
  if (signal.aborted) return cancelledRead(operationId)
  if (fetched.status !== 'ok') return fetched
  if (fetched.operationId !== operationId) {
    return bindingFailed(
      operationId,
      `port operationId ${fetched.operationId} does not match read ${operationId}`,
    )
  }
  const admitted: AdmittedContent = fetched.admitted
  if (admitted.operation_id !== operationId) {
    return bindingFailed(
      operationId,
      `admitted operation_id ${admitted.operation_id} does not match read ${operationId}`,
    )
  }
  if (admitted.revision.source_id !== source.source_id) {
    return bindingFailed(
      operationId,
      `admitted revision source_id ${admitted.revision.source_id} does not match requested ${source.source_id}`,
    )
  }
  if (!admitted.provenance.requested_url || !admitted.provenance.final_url) {
    return bindingFailed(operationId, 'admitted provenance missing requested_url or final_url')
  }
  return null
}
