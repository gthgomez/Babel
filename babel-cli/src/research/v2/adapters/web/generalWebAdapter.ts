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
  passagesFromAdmittedStaticHtml,
  STATIC_HTML_EXTRACTION_VERSION,
} from './htmlFromAdmittedBytes.js'

export const GENERAL_WEB_ADAPTER_ID = 'general-web/0.1.0'

export class GeneralWebAdapter implements SourceAdapter {
  readonly adapterId = GENERAL_WEB_ADAPTER_ID
  readonly supportedKinds: readonly SourceClass[] = ['web']

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
      message: 'general web adapter: offline slice does not implement live discovery',
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
      const passages = passagesFromAdmittedStaticHtml(admitted)
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
      }
    }
  }
}
