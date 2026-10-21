import { createHash } from 'node:crypto'
import type { AdmittedContent } from '../../contracts/admittedContent.js'
import type { PassageRecord } from '../../contracts/passages.js'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { decodeAdmittedInlineBytes } from './plainTextFromAdmittedBytes.js'
import { PDF_MEDIA_TYPE } from './pdfAdmission.js'

export const PDF_TEXT_EXTRACTION_VERSION = 'general-pdf-text/0.1.0'

function passageTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function assertPdfMagic(bytes: Buffer): void {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('admitted bytes are not a PDF header')
  }
}

/**
 * Extract per-page text from admitted inline PDF bytes (pdfjs-dist; offline fixtures).
 */
export async function passagesFromAdmittedPdf(admitted: AdmittedContent): Promise<PassageRecord[]> {
  if (admitted.media_type !== PDF_MEDIA_TYPE) {
    throw new Error(
      `unsupported media_type for PDF extractor: ${admitted.media_type} (only ${PDF_MEDIA_TYPE})`,
    )
  }
  const raw = decodeAdmittedInlineBytes(admitted)
  assertPdfMagic(raw)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await getDocument({ data: new Uint8Array(raw), useSystemFonts: true }).promise
  const passages: PassageRecord[] = []
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? String(item.str) : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    const record: PassageRecord = {
      passage_id: `${admitted.operation_id}:pdf:p${pageNum}`,
      source_revision_id: admitted.revision.revision_id,
      locator: { kind: 'page', start_page: pageNum, end_page: pageNum },
      text_ref: {
        mode: 'inline',
        text: text.length > 32_000 ? text.slice(0, 32_000) : text,
        text_hash: passageTextHash(text),
      },
      extraction_notes: ['pdfjs_text_layer', 'offline_fixture_slice'],
    }
    PassageRecordSchema.parse(record)
    passages.push(record)
  }
  if (passages.length === 0) {
    throw new Error('pdf extraction produced no text passages')
  }
  return passages
}
