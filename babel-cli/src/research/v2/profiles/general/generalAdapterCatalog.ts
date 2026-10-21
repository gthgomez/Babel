/**
 * B-owned adapter IDs for Agent A registry wiring (no registry edits here).
 * IO only through SourceAccessPort; mission/report loop remains Agent A.
 */
import { GENERAL_DOCUMENT_ADAPTER_ID, GeneralDocumentAdapter } from '../../adapters/documents/generalDocumentAdapter.js'
import { GENERAL_WEB_ADAPTER_ID, GeneralWebAdapter } from '../../adapters/web/generalWebAdapter.js'

export const generalAdapterCatalog = {
  document: {
    adapterId: GENERAL_DOCUMENT_ADAPTER_ID,
    factory: () => new GeneralDocumentAdapter(),
    extraction: 'text/plain inline bytes; application/pdf per-page text (pdfjs-dist, offline)',
  },
  web: {
    adapterId: GENERAL_WEB_ADAPTER_ID,
    factory: () => new GeneralWebAdapter(),
    extraction: 'static text/html heading-bounded sections (offline fixtures)',
  },
} as const
