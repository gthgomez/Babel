import type { SourceRecord } from '../../contracts/sources.js'
import type { SourceAccessPort } from '../../ports/sourceAccessPort.js'
import type {
  SourceAdapter,
  SourceAdapterReadRequest,
  SourceAdapterReadResult,
  SourceDiscoverRequest,
  SourceDiscoverResult,
} from '../../ports/sourceAdapter.js'
import {
  assertRepositoryFilePinning,
  TechnicalRepositoryPinError,
} from './repositoryFilePinning.js'
import {
  passagesFromAdmittedPlainText,
  TECHNICAL_PLAIN_EXTRACTION_VERSION,
} from './plainTextFromAdmitted.js'
import { TechnicalRepositoryAdmissionError } from './technicalRepositoryAdmission.js'

export const TECHNICAL_REPOSITORY_FILE_ADAPTER_ID = 'technical-repository-file'

function cancelledDiscover(request: SourceDiscoverRequest): SourceDiscoverResult | null {
  if (request.signal.aborted) {
    return { operationId: request.operationId, status: 'cancelled' }
  }
  return null
}

function cancelledRead(request: SourceAdapterReadRequest): SourceAdapterReadResult | null {
  if (request.signal.aborted) {
    return { operationId: request.operationId, status: 'cancelled' }
  }
  return null
}

function adapterFailure(
  operationId: string,
  err: TechnicalRepositoryPinError | TechnicalRepositoryAdmissionError,
): SourceAdapterReadResult {
  return {
    operationId,
    status: 'failed',
    failureCategory: err instanceof TechnicalRepositoryAdmissionError ? err.failureCategory : 'pin_binding_failed',
    message: err.message,
  }
}

/**
 * Technical profile adapter for pinned repository files — IO only via {@link SourceAccessPort}.
 */
export class TechnicalRepositoryFileAdapter implements SourceAdapter {
  readonly adapterId = TECHNICAL_REPOSITORY_FILE_ADAPTER_ID
  readonly supportedKinds = ['repository_file'] as const

  async discover(
    request: SourceDiscoverRequest,
    access: SourceAccessPort,
  ): Promise<SourceDiscoverResult> {
    const pre = cancelledDiscover(request)
    if (pre) return pre
    const search = await access.search({
      operationId: `${request.operationId}:search`,
      query: request.query,
      sourceClasses: [...this.supportedKinds],
      signal: request.signal,
    })
    const post = cancelledDiscover(request)
    if (post) return post
    if (search.status === 'cancelled') {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    if (search.status === 'failed') {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: search.failureCategory,
        message: search.message,
      }
    }
    const candidates: SourceRecord[] = search.hits.map((hit) => hit.source)
    return { operationId: request.operationId, status: 'ok', candidates }
  }

  async read(
    request: SourceAdapterReadRequest,
    access: SourceAccessPort,
  ): Promise<SourceAdapterReadResult> {
    const pre = cancelledRead(request)
    if (pre) return pre
    if (request.source.kind !== 'repository_file') {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'unsupported_source_kind',
        message: `adapter ${this.adapterId} does not support kind ${request.source.kind}`,
      }
    }
    try {
      assertRepositoryFilePinning(request.source)
    } catch (err) {
      if (err instanceof TechnicalRepositoryPinError) {
        return adapterFailure(request.operationId, err)
      }
      throw err
    }
    const fetchOperationId = `${request.operationId}:fetch`
    const fetched = await access.fetchContent({
      operationId: fetchOperationId,
      source: request.source,
      signal: request.signal,
    })
    const post = cancelledRead(request)
    if (post) return post
    if (fetched.status === 'cancelled') {
      return { operationId: request.operationId, status: 'cancelled' }
    }
    if (fetched.status === 'failed') {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: fetched.failureCategory,
        message: fetched.message,
      }
    }
    if (fetched.operationId !== fetchOperationId) {
      return adapterFailure(
        request.operationId,
        new TechnicalRepositoryPinError('fetch response operation_id does not match request'),
      )
    }
    try {
      const revision = fetched.admitted.revision
      const passages = passagesFromAdmittedPlainText(
        request.source,
        fetchOperationId,
        fetched.operationId,
        revision,
        fetched.admitted,
      )
      return {
        operationId: request.operationId,
        status: 'ok',
        revision,
        passages,
        extraction_version: TECHNICAL_PLAIN_EXTRACTION_VERSION,
      }
    } catch (err) {
      if (
        err instanceof TechnicalRepositoryPinError ||
        err instanceof TechnicalRepositoryAdmissionError
      ) {
        return adapterFailure(request.operationId, err)
      }
      throw err
    }
  }
}
