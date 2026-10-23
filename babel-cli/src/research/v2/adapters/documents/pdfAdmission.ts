import type { AdmittedContent } from '../../contracts/admittedContent.js'

export const PDF_MEDIA_TYPE = 'application/pdf'

export function isPdfMediaType(mediaType: string): boolean {
  return mediaType === PDF_MEDIA_TYPE
}

/** Reject obvious non-PDF payloads before invoking parser. */
export function rejectNonPdfBytes(admitted: AdmittedContent, raw: Buffer): void {
  if (!isPdfMediaType(admitted.media_type)) return
  if (raw.length < 5 || raw.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('admitted bytes are not a PDF header')
  }
}
