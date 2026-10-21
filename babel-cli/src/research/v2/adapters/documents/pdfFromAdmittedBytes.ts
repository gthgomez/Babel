import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { buildInlinePassageTextRef } from './passageInlineText.js'
import { decodeAdmittedInlineBytes } from './plainTextFromAdmittedBytes.js'
import { PDF_MEDIA_TYPE } from './pdfAdmission.js'
import {
  PDF_MAX_PAGES_PER_EXTRACTION,
  PdfExtractionCancelled,
  throwIfPdfAborted,
} from './pdfExtractionLimits.js'

export const PDF_TEXT_EXTRACTION_VERSION = 'general-pdf-text/0.1.0'

export type PdfExtractionOptions = {
  /** Test hook: delay between pages to exercise cancellation. */
  pageDelayMs?: number
}

function assertPdfMagic(bytes: Buffer): void {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('admitted bytes are not a PDF header')
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfPdfAborted(signal)
    return
  }
  throwIfPdfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new PdfExtractionCancelled())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  throwIfPdfAborted(signal)
}

type PdfDocumentLike = {
  numPages: number
  getPage: (n: number) => Promise<{
    getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
  }>
  destroy: () => Promise<void>
}

/**
 * Extract per-page text from admitted inline PDF bytes (pdfjs-dist).
 */
export async function passagesFromAdmittedPdf(
  admitted: AdmittedContent,
  signal?: AbortSignal,
  options?: PdfExtractionOptions,
): Promise<PassageRecord[]> {
  if (admitted.media_type !== PDF_MEDIA_TYPE) {
    throw new Error(
      `unsupported media_type for PDF extractor: ${admitted.media_type} (only ${PDF_MEDIA_TYPE})`,
    )
  }
  throwIfPdfAborted(signal)
  const raw = decodeAdmittedInlineBytes(admitted)
  assertPdfMagic(raw)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  throwIfPdfAborted(signal)
  const loadingTask = getDocument({ data: new Uint8Array(raw), useSystemFonts: true })
  let doc: PdfDocumentLike | null = null
  try {
    doc = (await loadingTask.promise) as unknown as PdfDocumentLike
    throwIfPdfAborted(signal)
    const activeDoc = doc
    if (activeDoc.numPages > PDF_MAX_PAGES_PER_EXTRACTION) {
      throw new Error(
        `pdf exceeds page limit (${activeDoc.numPages} > ${PDF_MAX_PAGES_PER_EXTRACTION})`,
      )
    }
    const pageCap = activeDoc.numPages
    const passages: PassageRecord[] = []
    for (let pageNum = 1; pageNum <= pageCap; pageNum++) {
      throwIfPdfAborted(signal)
      if (options?.pageDelayMs) {
        await abortableDelay(options.pageDelayMs, signal)
      }
      const page = await activeDoc.getPage(pageNum)
      throwIfPdfAborted(signal)
      const content = await page.getTextContent()
      throwIfPdfAborted(signal)
      const text = content.items
        .map((item) => ('str' in item ? String(item.str) : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      const inline = buildInlinePassageTextRef(text)
      const record: PassageRecord = {
        passage_id: `${admitted.operation_id}:pdf:p${pageNum}`,
        source_revision_id: admitted.revision.revision_id,
        locator: { kind: 'page', start_page: pageNum, end_page: pageNum },
        text_ref: {
          mode: 'inline',
          text: inline.text,
          text_hash: inline.text_hash,
        },
        extraction_notes: ['pdfjs_text_layer', 'admitted_inline_pdf', ...inline.truncationNotes],
      }
      PassageRecordSchema.parse(record)
      passages.push(record)
    }
    throwIfPdfAborted(signal)
    if (passages.length === 0) {
      throw new Error('pdf extraction produced no text passages')
    }
    return passages
  } finally {
    if (doc) {
      try {
        await doc.destroy()
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      loadingTask.destroy()
    } catch {
      /* best-effort cleanup */
    }
  }
}
