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
} from './plainTextFromAdmittedBytes.js'
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
      const passages = passagesFromAdmittedPlainText(admitted)
      return {
        operationId: request.operationId,
        status: 'ok',
        revision: admitted.revision,
        passages,
        extraction_version: PLAIN_TEXT_EXTRACTION_VERSION,
      }
    } catch (error) {
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
