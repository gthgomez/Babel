import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import {
  awaitWithPdfAbort,
  destroyLoadingTask,
  destroyPdfResources,
  mergeAbortSignals,
  type PdfLoadingTaskLike,
} from './pdfAbortable.js'
import { buildInlinePassageTextRef } from './passageInlineText.js'
import { passageWithIntegrityVerification } from '../../integrity/passageIntegrityReceipt.js'
import { decodeAdmittedInlineBytes } from './plainTextFromAdmittedBytes.js'
import { PDF_MEDIA_TYPE } from './pdfAdmission.js'
import {
  PDF_EXTRACTION_DEADLINE_MS,
  PDF_MAX_PAGES_PER_EXTRACTION,
  PdfExtractionCancelled,
  throwIfPdfAborted,
} from './pdfExtractionLimits.js'
import { ensurePdfJsNodeCanvasRuntime } from './pdfNodeCanvasPolyfill.js'

export const PDF_TEXT_EXTRACTION_VERSION = 'general-pdf-text/0.1.0'

export interface PdfExtractionCoverage {
  pdf_page_count: number
  pages_processed: number
  pages_with_passages: number
  pages_without_extractable_text: number
  pages_with_truncated_inline_text: number
  last_page_with_passage: number | null
  page_traversal_complete: boolean
  text_extraction_complete: boolean
}

export type PdfExtractionStallStage = 'loading' | 'getPage' | 'getTextContent'

export type PdfExtractionTestHooks = {
  /** Replace pdfjs loading task (deterministic load failure/cleanup tests). */
  createLoadingTask?: () => PdfLoadingTaskLike
}

export type PdfExtractionOptions = {
  /** Test hook: delay between pages to exercise cancellation. */
  pageDelayMs?: number
  /** Test hook: never-resolving parser stage (deterministic cancel interrupt). */
  stallStage?: PdfExtractionStallStage
  /** Test hook: build passages without pdfjs (page number → raw page text). */
  synthesizePageText?: Record<number, string>
  testHooks?: PdfExtractionTestHooks
}

type PdfPageLike = {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>
}

type PdfDocumentLike = {
  numPages: number
  getPage: (n: number) => Promise<PdfPageLike>
  destroy: () => Promise<void>
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
  options?: PdfExtractionOptions,
): Promise<{ doc: PdfDocumentLike; loadingTask: PdfLoadingTaskLike }> {
  const stallStage = options?.stallStage
  let loadingTask: PdfLoadingTaskLike

  if (options?.testHooks?.createLoadingTask) {
    loadingTask = options.testHooks.createLoadingTask()
  } else if (stallStage === 'loading') {
    loadingTask = {
      promise: neverResolving<PdfDocumentLike>(),
      destroy: () => Promise.resolve(),
    }
  } else {
    await ensurePdfJsNodeCanvasRuntime()
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    throwIfPdfAborted(signal)
    loadingTask = getDocument({
      data: new Uint8Array(raw),
      useSystemFonts: true,
    }) as PdfLoadingTaskLike
  }

  try {
    const doc = (await awaitWithPdfAbort(loadingTask.promise as Promise<PdfDocumentLike>, signal, () => {
      void destroyLoadingTask(loadingTask)
    })) as PdfDocumentLike
    return { doc, loadingTask }
  } catch (error) {
    await destroyLoadingTask(loadingTask)
    throw error
  }
}

async function extractPassagesFromDoc(
  admitted: AdmittedContent,
  activeDoc: PdfDocumentLike,
  signal?: AbortSignal,
  options?: PdfExtractionOptions,
): Promise<{ passages: PassageRecord[]; coverage: PdfExtractionCoverage }> {
  if (activeDoc.numPages > PDF_MAX_PAGES_PER_EXTRACTION) {
    throw new Error(
      `pdf exceeds page limit (${activeDoc.numPages} > ${PDF_MAX_PAGES_PER_EXTRACTION})`,
    )
  }
  const passages: PassageRecord[] = []
  let lastPageWithPassage: number | null = null
  let pagesWithoutExtractableText = 0
  let pagesWithTruncatedInline = 0
  for (let pageNum = 1; pageNum <= activeDoc.numPages; pageNum++) {
    throwIfPdfAborted(signal)
    if (options?.pageDelayMs) {
      await abortableDelay(options.pageDelayMs, signal)
    }

    let text = ''
    if (options?.synthesizePageText) {
      text = (options.synthesizePageText[pageNum] ?? '').replace(/\s+/g, ' ').trim()
    } else {
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
      text = content.items
        .map((item) => ('str' in item ? String(item.str) : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    }
    if (!text) {
      pagesWithoutExtractableText += 1
      continue
    }
    const basePassage = buildPassageFromPageText(admitted, pageNum, text)
    const passage =
      options?.synthesizePageText !== undefined
        ? basePassage
        : passageWithIntegrityVerification(basePassage, {
            source: { source_id: admitted.revision.source_id },
            revision: admitted.revision,
            admitted,
            extractionVersion: PDF_TEXT_EXTRACTION_VERSION,
            preverifiedPageText: text,
          })
    if (
      passage.extraction_notes?.some((note) => note.startsWith('inline_text_truncated:')) === true
    ) {
      pagesWithTruncatedInline += 1
    }
    passages.push(passage)
    lastPageWithPassage = pageNum
  }
  throwIfPdfAborted(signal)
  if (passages.length === 0) {
    throw new Error('pdf extraction produced no text passages')
  }
  const pageTraversalComplete = activeDoc.numPages > 0
  const textExtractionComplete =
    pageTraversalComplete &&
    pagesWithoutExtractableText === 0 &&
    pagesWithTruncatedInline === 0 &&
    passages.length > 0
  return {
    passages,
    coverage: {
      pdf_page_count: activeDoc.numPages,
      pages_processed: activeDoc.numPages,
      pages_with_passages: passages.length,
      pages_without_extractable_text: pagesWithoutExtractableText,
      pages_with_truncated_inline_text: pagesWithTruncatedInline,
      last_page_with_passage: lastPageWithPassage,
      page_traversal_complete: pageTraversalComplete,
      text_extraction_complete: textExtractionComplete,
    },
  }
}

/**
 * Extract per-page text from admitted inline PDF bytes (pdfjs-dist).
 */
export async function passagesAndCoverageFromAdmittedPdf(
  admitted: AdmittedContent,
  signal?: AbortSignal,
  options?: PdfExtractionOptions,
): Promise<{ passages: PassageRecord[]; coverage: PdfExtractionCoverage }> {
  if (admitted.media_type !== PDF_MEDIA_TYPE) {
    throw new Error(
      `unsupported media_type for PDF extractor: ${admitted.media_type} (only ${PDF_MEDIA_TYPE})`,
    )
  }
  const scope = mergeAbortSignals(signal, PDF_EXTRACTION_DEADLINE_MS)
  const activeSignal = scope.signal

  try {
    throwIfPdfAborted(activeSignal)
    const raw = decodeAdmittedInlineBytes(admitted)
    assertPdfMagic(raw)

    if (options?.synthesizePageText) {
      throwIfPdfAborted(activeSignal)
      const pageNums = Object.keys(options.synthesizePageText)
        .map((k) => Number(k))
        .filter((n) => Number.isInteger(n) && n > 0)
      const numPages = pageNums.length > 0 ? Math.max(...pageNums) : 0
      const syntheticDoc: PdfDocumentLike = {
        numPages,
        getPage: async () => ({
          getTextContent: async () => ({ items: [] }),
        }),
        destroy: async () => {},
      }
      return await extractPassagesFromDoc(admitted, syntheticDoc, activeSignal, options)
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
        loadingTask = { promise: Promise.resolve(doc), destroy: () => Promise.resolve() }
        return await extractPassagesFromDoc(admitted, doc, activeSignal, options)
      }

      const loaded = await loadPdfDocument(raw, activeSignal, options)
      doc = loaded.doc
      loadingTask = loaded.loadingTask
      throwIfPdfAborted(activeSignal)
      return await extractPassagesFromDoc(admitted, doc, activeSignal, options)
    } finally {
      await destroyPdfResources(doc, loadingTask)
    }
  } catch (error) {
    if (error instanceof PdfExtractionCancelled) throw error
    throw error
  } finally {
    scope.dispose()
  }
}

export async function passagesFromAdmittedPdf(
  admitted: AdmittedContent,
  signal?: AbortSignal,
  options?: PdfExtractionOptions,
): Promise<PassageRecord[]> {
  const extracted = await passagesAndCoverageFromAdmittedPdf(admitted, signal, options)
  return extracted.passages
}
