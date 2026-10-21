import { findVersionPinnedDocumentPolicy } from '../../access/versionPinnedDocumentAcquisition.js'
import type { AdmittedContent } from '../../contracts/admittedContent.js'
import { isPdfMediaType } from './pdfAdmission.js'
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

/** Admission: fetch must name a URL the selected source already exposes. */
export function admitsRequestedUrlForSource(source: SourceRecord, requestedUrl: string): boolean {
  return source.observed_urls.includes(requestedUrl)
}

/**
 * Redirect provenance must describe a chain from requested_url to final_url.
 * Final URL may differ from requested (legitimate redirects); equality is not required.
 */
export function validateAdmittedRedirectProvenance(
  provenance: AdmittedContent['provenance'],
): string | null {
  const { requested_url, final_url, redirect_chain } = provenance
  if (!requested_url || !final_url) {
    return 'admitted provenance missing requested_url or final_url'
  }
  if (redirect_chain.length < 1) {
    return 'admitted redirect_chain must contain at least the requested URL'
  }
  if (redirect_chain[0] !== requested_url) {
    return 'admitted redirect_chain must start with requested_url'
  }
  if (redirect_chain[redirect_chain.length - 1] !== final_url) {
    return 'admitted redirect_chain must end with final_url'
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
  if (fetched.operationId !== operationId) {
    return bindingFailed(
      operationId,
      `port operationId ${fetched.operationId} does not match read ${operationId}`,
    )
  }
  if (fetched.status === 'cancelled') {
    return cancelledRead(operationId)
  }
  if (fetched.status === 'failed') {
    return fetched
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
  if (!admitsRequestedUrlForSource(source, admitted.provenance.requested_url)) {
    return bindingFailed(
      operationId,
      'admitted requested_url is not listed on source observed_urls',
    )
  }
  const redirectErr = validateAdmittedRedirectProvenance(admitted.provenance)
  if (redirectErr) {
    return bindingFailed(operationId, redirectErr)
  }
  const pinnedPolicy = findVersionPinnedDocumentPolicy(source)
  if (
    pinnedPolicy?.require_complete_body &&
    isPdfMediaType(admitted.media_type) &&
    admitted.revision.completeness === 'truncated'
  ) {
    return bindingFailed(
      operationId,
      `version-pinned document ${pinnedPolicy.provenance.arxiv_id} requires complete PDF admission`,
    )
  }
  return null
}
