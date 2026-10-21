import type { SourceAccessPort, SourceClass } from '../../ports/sourceAccessPort.js'
import type {
  SourceAdapter,
  SourceAdapterReadRequest,
  SourceAdapterReadResult,
  SourceDiscoverRequest,
  SourceDiscoverResult,
} from '../../ports/sourceAdapter.js'
import {
  PLAIN_TEXT_EXTRACTION_VERSION,
  passagesFromAdmittedPlainText,
  PLAIN_TEXT_MEDIA_TYPE,
} from './plainTextFromAdmittedBytes.js'
import { isPdfMediaType } from './pdfAdmission.js'
import { PdfExtractionCancelled } from './pdfExtractionLimits.js'
import {
  PDF_TEXT_EXTRACTION_VERSION,
  passagesAndCoverageFromAdmittedPdf,
} from './pdfFromAdmittedBytes.js'
import {
  assertReadPreconditions,
  cancelledRead,
  validateFetchBinding,
} from './readBinding.js'

export const GENERAL_DOCUMENT_ADAPTER_ID = 'general-document/0.1.0'

export class GeneralDocumentAdapter implements SourceAdapter {
  readonly adapterId = GENERAL_DOCUMENT_ADAPTER_ID
  readonly supportedKinds: readonly SourceClass[] = ['document']

  async discover(
    request: SourceDiscoverRequest,
    _access: SourceAccessPort,
  ): Promise<SourceDiscoverResult> {
    if (request.signal.aborted) {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    return {
      operationId: request.operationId,
      status: 'failed',
      failureCategory: 'not_supported',
      message: 'general document adapter does not implement network discovery',
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
      if (isPdfMediaType(admitted.media_type)) {
        const extracted = await passagesAndCoverageFromAdmittedPdf(admitted, request.signal)
        if (request.signal.aborted) {
          return cancelledRead(request.operationId)
        }
        const coverage = extracted.coverage
        const extractionComplete =
          coverage.pages_processed === coverage.pdf_page_count &&
          coverage.last_page_with_passage === coverage.pdf_page_count &&
          coverage.pages_with_passages > 0
        return {
          operationId: request.operationId,
          status: 'ok',
          revision: admitted.revision,
          passages: extracted.passages,
          extraction_version: PDF_TEXT_EXTRACTION_VERSION,
          document_pdf_extraction_coverage: {
            pdf_page_count: coverage.pdf_page_count,
            pages_processed: coverage.pages_processed,
            pages_with_passages: coverage.pages_with_passages,
            last_page_with_passage: coverage.last_page_with_passage,
            extraction_complete: extractionComplete,
          },
        }
      }
      if (admitted.media_type !== PLAIN_TEXT_MEDIA_TYPE) {
        throw new Error(`unsupported media_type for document adapter: ${admitted.media_type}`)
      }
      const passages = passagesFromAdmittedPlainText(admitted)
      return {
        operationId: request.operationId,
        status: 'ok',
        revision: admitted.revision,
        passages,
        extraction_version: PLAIN_TEXT_EXTRACTION_VERSION,
      }
    } catch (error) {
      if (error instanceof PdfExtractionCancelled || request.signal.aborted) {
        return cancelledRead(request.operationId)
      }
      const message = error instanceof Error ? error.message : String(error)
      const failureCategory = message.includes('unsupported media_type')
        ? 'unsupported_media'
        : 'extraction_failed'
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory,
        message,
      }
    }
  }
}
