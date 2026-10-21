import { acquisitionDiagnosticsFromAdmitted } from '../../contracts/sourceAcquisitionDiagnostics.js'
import type { SourceRecord } from '../../contracts/sources.js'
import type { SourceAccessPort, SourceClass } from '../../ports/sourceAccessPort.js'
import type {
  SourceAdapter,
  SourceAdapterReadRequest,
  SourceAdapterReadResult,
  SourceDiscoverRequest,
  SourceDiscoverResult,
} from '../../ports/sourceAdapter.js'
import {
  assertReadPreconditions,
  cancelledRead,
  validateFetchBinding,
} from '../documents/readBinding.js'
import {
  cancelledDiscoverResult,
  receiptFromSourceSearchResult,
} from './discoverSearchReceiptHandoff.js'
import { mergeDiscoverSearchReceipts } from '../../engine/sourceDiscoverSearchReceipt.js'
import { passageWithIntegrityVerification } from '../../integrity/passageIntegrityReceipt.js'
import {
  passagesFromAdmittedStaticHtml,
  STATIC_HTML_EXTRACTION_VERSION,
} from './htmlFromAdmittedBytes.js'

export const GENERAL_WEB_ADAPTER_ID = 'general-web/0.1.0'

export class GeneralWebAdapter implements SourceAdapter {
  readonly adapterId = GENERAL_WEB_ADAPTER_ID
  readonly supportedKinds: readonly SourceClass[] = ['web']

  /**
   * Agent A (#406): discovery is search-backed via {@link SourceAccessPort#search}.
   * B80 catalog slices return `not_supported` without calling search — do not replace
   * this method wholesale when porting B extraction/read fixes.
   */
  async discover(
    request: SourceDiscoverRequest,
    access: SourceAccessPort,
  ): Promise<SourceDiscoverResult> {
    if (request.signal.aborted) {
      return cancelledDiscoverResult(request.operationId)
    }
    const search = await access.search({
      operationId: `${request.operationId}:search`,
      query: request.query,
      sourceClasses: [...this.supportedKinds],
      signal: request.signal,
    })
    const webSearchReceipt = receiptFromSourceSearchResult(search)
    if (request.signal.aborted) {
      return cancelledDiscoverResult(request.operationId, webSearchReceipt)
    }
    if (search.status === 'cancelled') {
      return cancelledDiscoverResult(request.operationId, webSearchReceipt)
    }
    if (search.status === 'failed') {
      const failedReceipt = mergeDiscoverSearchReceipts(search.receipt)
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: search.failureCategory,
        message: search.message,
        ...(failedReceipt ? { search_provider_receipt: failedReceipt } : {}),
      }
    }
    let candidates: SourceRecord[] = search.hits.map((hit) => hit.source)
    let searchReceipt = mergeDiscoverSearchReceipts(search.receipt)
    if (candidates.length === 0) {
      const docSearch = await access.search({
        operationId: `${request.operationId}:document-search`,
        query: request.query,
        sourceClasses: ['document'],
        signal: request.signal,
      })
      if (request.signal.aborted) {
        return cancelledDiscoverResult(request.operationId, searchReceipt)
      }
      if (docSearch.status === 'cancelled') {
        return cancelledDiscoverResult(request.operationId, searchReceipt)
      }
      if (docSearch.status === 'failed') {
        const failedReceipt =
          mergeDiscoverSearchReceipts(search.receipt, docSearch.receipt) ?? searchReceipt
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: docSearch.failureCategory,
          message: docSearch.message,
          ...(failedReceipt ? { search_provider_receipt: failedReceipt } : {}),
        }
      }
      candidates = docSearch.hits.map((hit) => hit.source)
      searchReceipt = mergeDiscoverSearchReceipts(search.receipt, docSearch.receipt) ?? searchReceipt
    }
    return {
      operationId: request.operationId,
      status: 'ok',
      candidates,
      ...(searchReceipt ? { search_provider_receipt: searchReceipt } : {}),
    }
  }

  async read(
    request: SourceAdapterReadRequest,
    access: SourceAccessPort,
  ): Promise<SourceAdapterReadResult> {
    const pre = assertReadPreconditions(request.operationId, request.source, request.signal)
    if (pre) return pre

    const fetched = await access.fetchContent({
      operationId: request.operationId,
      source: request.source,
      signal: request.signal,
    })

    if (request.signal.aborted) {
      return cancelledRead(request.operationId)
    }

    const binding = validateFetchBinding(
      request.operationId,
      request.source,
      fetched,
      request.signal,
    )
    if (binding) return binding

    if (fetched.status !== 'ok') return fetched

    const admitted = fetched.admitted
    try {
      const passages = passagesFromAdmittedStaticHtml(admitted).map((passage) =>
        passageWithIntegrityVerification(passage, {
          source: request.source,
          revision: admitted.revision,
          admitted,
          extractionVersion: STATIC_HTML_EXTRACTION_VERSION,
        }),
      )
      return {
        operationId: request.operationId,
        status: 'ok',
        revision: admitted.revision,
        passages,
        extraction_version: STATIC_HTML_EXTRACTION_VERSION,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failureCategory = message.includes('unsupported media_type')
        ? 'unsupported_media'
        : message.includes('incomplete') || message.includes('no heading')
          ? 'extraction_failed'
          : 'extraction_failed'
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory,
        message,
        acquisition_diagnostics: acquisitionDiagnosticsFromAdmitted(admitted),
      }
    }
  }
}
