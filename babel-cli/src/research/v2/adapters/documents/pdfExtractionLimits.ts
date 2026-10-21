/** General document PDF extractor bounds (offline admitted bytes). */
export const PDF_MAX_PAGES_PER_EXTRACTION = 512
export const PDF_MAX_OUTPUT_CODE_POINTS_PER_PAGE = 32_000

export class PdfExtractionCancelled extends Error {
  constructor() {
    super('pdf extraction cancelled')
    this.name = 'PdfExtractionCancelled'
  }
}

export function throwIfPdfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfExtractionCancelled()
}
