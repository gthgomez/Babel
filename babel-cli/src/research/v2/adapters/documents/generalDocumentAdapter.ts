import type {
  SourceAccessPort,
  SourceAdapter,
  SourceAdapterReadRequest,
  SourceAdapterReadResult,
  SourceClass,
} from '../frozenPorts0ccd1733.js'
import { passagesFromAdmittedPlainText, plainTextExtractionVersion } from './plainTextFromAdmittedBytes.js'

export const GENERAL_DOCUMENT_ADAPTER_ID = 'general-document/0.1.0'

export class GeneralDocumentAdapter implements SourceAdapter {
  readonly adapterId = GENERAL_DOCUMENT_ADAPTER_ID
  readonly supportedKinds: readonly SourceClass[] = ['document']

  async read(
    request: SourceAdapterReadRequest,
    access: SourceAccessPort,
  ): Promise<SourceAdapterReadResult> {
    const fetched = await access.fetchContent({
      operationId: request.operationId,
      source: request.source,
      signal: request.signal,
    })
    if (fetched.status !== 'ok') return fetched
    const admitted = fetched.admitted
    try {
      const passages = passagesFromAdmittedPlainText(admitted)
      return {
        operationId: request.operationId,
        status: 'ok',
        revision: admitted.revision,
        passages,
        extraction_version: plainTextExtractionVersion,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'extraction_failed',
        message,
      }
    }
  }
}
