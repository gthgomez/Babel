/** General document PDF extractor bounds (offline admitted bytes). */
export const PDF_MAX_PAGES_PER_EXTRACTION = 512
/** Matches PassageTextRefSchema inline text max (UTF-16 code units). */
export const PDF_MAX_OUTPUT_UTF16_UNITS_PER_PAGE = 32_000
/** Wall-clock bound for a single admitted-PDF extraction (loading + pages). */
export const PDF_EXTRACTION_DEADLINE_MS = 120_000
/** Wall-clock bound waiting on pdfjs destroy() during cleanup. */
export const PDF_DESTROY_BOUND_MS = 5_000

export class PdfExtractionCancelled extends Error {
  constructor() {
    super('pdf extraction cancelled')
    this.name = 'PdfExtractionCancelled'
  }
}

export function throwIfPdfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfExtractionCancelled()
}
