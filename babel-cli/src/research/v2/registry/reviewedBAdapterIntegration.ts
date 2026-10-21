import type { SourceAdapter } from '../ports/sourceAdapter.js'
import {
  createTechnicalResearchRegistries,
  withAdditionalSourceAdapters,
} from './frozenRegistries.js'

/**
 * Agent B ownership: profiles/general, adapters/web, adapters/documents.
 * Register reviewed B adapters here after independent review — Agent A does not duplicate HTML/PDF extraction.
 */
const B_GENERAL_PLAIN_TEXT_ADAPTER = '../profiles/general/plainTextWebAdapter.js'
const B_WEB_HTML_ADAPTER = '../adapters/web/htmlWebSourceAdapter.js'
const B_DOCUMENT_PDF_ADAPTER = '../adapters/documents/pdfDocumentAdapter.js'

async function tryImport<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T
  } catch {
    return null
  }
}

async function loadAdapter(
  specifier: string,
  exportName: string,
): Promise<SourceAdapter | null> {
  const mod = await tryImport<Record<string, new () => SourceAdapter>>(specifier)
  if (!mod) return null
  const Ctor = mod[exportName]
  if (!Ctor) return null
  return new Ctor()
}

export interface CombinedResearchRegistries extends ReturnType<typeof createTechnicalResearchRegistries> {
  bAdaptersRegistered: string[]
}

/** Technical baseline plus optional B-reviewed adapters when modules exist locally. */
export async function createCombinedResearchRegistries(): Promise<CombinedResearchRegistries> {
  const technical = createTechnicalResearchRegistries()
  const extras: SourceAdapter[] = []
  const registered: string[] = []

  const plain = await loadAdapter(B_GENERAL_PLAIN_TEXT_ADAPTER, 'PlainTextWebSourceAdapter')
  if (plain) {
    extras.push(plain)
    registered.push('general/plainTextWebSourceAdapter')
  }

  const html = await loadAdapter(B_WEB_HTML_ADAPTER, 'HtmlWebSourceAdapter')
  if (html) {
    extras.push(html)
    registered.push('web/htmlWebSourceAdapter')
  }

  const pdf = await loadAdapter(B_DOCUMENT_PDF_ADAPTER, 'PdfDocumentSourceAdapter')
  if (pdf) {
    extras.push(pdf)
    registered.push('documents/pdfDocumentSourceAdapter')
  }

  const merged = extras.length > 0 ? withAdditionalSourceAdapters(technical, extras) : technical
  return { ...merged, bAdaptersRegistered: registered }
}
