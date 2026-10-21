import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import {
  awaitWithPdfAbort,
  destroyPdfResources,
  mergeAbortSignals,
} from './pdfAbortable.js'
import { buildInlinePassageTextRef } from './passageInlineText.js'
import { decodeAdmittedInlineBytes } from './plainTextFromAdmittedBytes.js'
import { PDF_MEDIA_TYPE } from './pdfAdmission.js'
import {
  PDF_EXTRACTION_DEADLINE_MS,
  PDF_MAX_PAGES_PER_EXTRACTION,
  PdfExtractionCancelled,
  throwIfPdfAborted,
} from './pdfExtractionLimits.js'

export const PDF_TEXT_EXTRACTION_VERSION = 'general-pdf-text/0.1.0'

export type PdfExtractionStallStage = 'loading' | 'getPage' | 'getTextContent'

export type PdfExtractionOptions = {
  /** Test hook: delay between pages to exercise cancellation. */
  pageDelayMs?: number
  /** Test hook: never-resolving parser stage (deterministic cancel interrupt). */
  stallStage?: PdfExtractionStallStage
  /** Test hook: build passages without pdfjs (page number → raw page text). */
  synthesizePageText?: Record<number, string>
}

type PdfPageLike = {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
}

type PdfDocumentLike = {
  numPages: number
  getPage: (n: number) => Promise<PdfPageLike>
  destroy: () => Promise<void>
}

type PdfLoadingTaskLike = {
  promise: Promise<PdfDocumentLike>
  destroy: () => void
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
  await awaitWithPdfAbort(
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })
    }),
    signal,
  )
}

function neverResolving<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

function buildPassageFromPageText(
  admitted: AdmittedContent,
  pageNum: number,
  text: string,
): PassageRecord {
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
  return record
}

function passagesFromSynthesizedPages(
  admitted: AdmittedContent,
  synthesizePageText: Record<number, string>,
): PassageRecord[] {
  const pageNums = Object.keys(synthesizePageText)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  const passages = pageNums.map((pageNum) =>
    buildPassageFromPageText(admitted, pageNum, synthesizePageText[pageNum] ?? ''),
  )
  if (passages.length === 0) {
    throw new Error('pdf extraction produced no text passages')
  }
  return passages
}

async function loadPdfDocument(
  raw: Buffer,
  signal?: AbortSignal,
  stallStage?: PdfExtractionStallStage,
): Promise<{ doc: PdfDocumentLike; loadingTask: PdfLoadingTaskLike }> {
  if (stallStage === 'loading') {
    const loadingTask: PdfLoadingTaskLike = {
      promise: neverResolving<PdfDocumentLike>(),
      destroy: () => {},
    }
    const doc = await awaitWithPdfAbort(loadingTask.promise, signal, () => {
      loadingTask.destroy()
    })
    return { doc, loadingTask }
  }

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  throwIfPdfAborted(signal)
  const loadingTask = getDocument({ data: new Uint8Array(raw), useSystemFonts: true }) as PdfLoadingTaskLike
  const doc = await awaitWithPdfAbort(loadingTask.promise, signal, () => {
    loadingTask.destroy()
  })
  return { doc, loadingTask }
}

async function extractPassagesFromDoc(
  admitted: AdmittedContent,
  activeDoc: PdfDocumentLike,
  signal?: AbortSignal,
  options?: PdfExtractionOptions,
): Promise<PassageRecord[]> {
  if (activeDoc.numPages > PDF_MAX_PAGES_PER_EXTRACTION) {
    throw new Error(
      `pdf exceeds page limit (${activeDoc.numPages} > ${PDF_MAX_PAGES_PER_EXTRACTION})`,
    )
  }
  const passages: PassageRecord[] = []
  for (let pageNum = 1; pageNum <= activeDoc.numPages; pageNum++) {
    throwIfPdfAborted(signal)
    if (options?.pageDelayMs) {
      await abortableDelay(options.pageDelayMs, signal)
    }

    const pagePromise =
      options?.stallStage === 'getPage' ? neverResolving<PdfPageLike>() : activeDoc.getPage(pageNum)
    const page = await awaitWithPdfAbort(pagePromise, signal)

    throwIfPdfAborted(signal)
    const textContentPromise =
      options?.stallStage === 'getTextContent'
        ? neverResolving<{ items: Array<{ str?: string }> }>()
        : page.getTextContent()
    const content = await awaitWithPdfAbort(textContentPromise, signal)

    throwIfPdfAborted(signal)
    const text = content.items
      .map((item) => ('str' in item ? String(item.str) : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    passages.push(buildPassageFromPageText(admitted, pageNum, text))
  }
  throwIfPdfAborted(signal)
  if (passages.length === 0) {
    throw new Error('pdf extraction produced no text passages')
  }
  return passages
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
  const scope = mergeAbortSignals(signal, PDF_EXTRACTION_DEADLINE_MS)
  const activeSignal = scope.signal

  throwIfPdfAborted(activeSignal)
  const raw = decodeAdmittedInlineBytes(admitted)
  assertPdfMagic(raw)

  if (options?.synthesizePageText) {
    throwIfPdfAborted(activeSignal)
    return passagesFromSynthesizedPages(admitted, options.synthesizePageText)
  }

  let doc: PdfDocumentLike | null = null
  let loadingTask: PdfLoadingTaskLike | null = null
  try {
    if (options?.stallStage === 'getPage' || options?.stallStage === 'getTextContent') {
      doc = {
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({ items: [{ str: 'unused' }] }),
        }),
        destroy: async () => {},
      }
      loadingTask = { promise: Promise.resolve(doc), destroy: () => {} }
      return await extractPassagesFromDoc(admitted, doc, activeSignal, options)
    }

    const loaded = await loadPdfDocument(raw, activeSignal, options?.stallStage)
    doc = loaded.doc
    loadingTask = loaded.loadingTask
    throwIfPdfAborted(activeSignal)
    return await extractPassagesFromDoc(admitted, doc, activeSignal, options)
  } catch (error) {
    if (error instanceof PdfExtractionCancelled) throw error
    throw error
  } finally {
    await destroyPdfResources(doc, loadingTask)
    scope.dispose()
  }
}
