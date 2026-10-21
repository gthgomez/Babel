import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { PassageRecordSchema } from '../../contracts/passages.js'
import { buildAdmittedContent } from './testAdmittedFixtures.js'
import { PdfExtractionCancelled } from './pdfExtractionLimits.js'
import { passagesFromAdmittedPdf, PDF_TEXT_EXTRACTION_VERSION } from './pdfFromAdmittedBytes.js'
import { PDF_MEDIA_TYPE } from './pdfAdmission.js'
import { passageTextHash } from './passageInlineText.js'

const pdfFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/two-page-sample.pdf')

test('passagesFromAdmittedPdf: two-page fixture with page locators', async () => {
  const bytes = readFileSync(pdfFixture)
  const admitted = buildAdmittedContent('op-pdf', 'src', 'rev', bytes, PDF_MEDIA_TYPE, {
    requestedUrl: 'https://example.invalid/two-page-sample.pdf',
    finalUrl: 'https://example.invalid/two-page-sample.pdf',
    redirectChain: ['https://example.invalid/two-page-sample.pdf'],
  })
  const passages = await passagesFromAdmittedPdf(admitted)
  assert.equal(passages.length, 2)
  assert.equal(passages[0]?.locator.kind, 'page')
  assert.equal(passages[0]?.locator.start_page, 1)
  assert.match(passages[0]?.text_ref.mode === 'inline' ? passages[0].text_ref.text : '', /retention 90 days/)
  assert.match(passages[1]?.text_ref.mode === 'inline' ? passages[1].text_ref.text : '', /2026-03-15/)
  for (const p of passages) PassageRecordSchema.parse(p)
  assert.equal(PDF_TEXT_EXTRACTION_VERSION, 'general-pdf-text/0.1.0')
})

test('passagesFromAdmittedPdf: cancellation during delayed page loop', async () => {
  const bytes = readFileSync(pdfFixture)
  const admitted = buildAdmittedContent('op-pdf', 'src', 'rev', bytes, PDF_MEDIA_TYPE)
  const controller = new AbortController()
  const promise = passagesFromAdmittedPdf(admitted, controller.signal, { pageDelayMs: 80 })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(promise, (err: unknown) => err instanceof PdfExtractionCancelled)
})

test('passagesFromAdmittedPdf: hashes emitted inline text only when truncated', async () => {
  const bytes = readFileSync(pdfFixture)
  const admitted = buildAdmittedContent('op', 'src', 'rev', bytes, PDF_MEDIA_TYPE)
  const passages = await passagesFromAdmittedPdf(admitted)
  for (const p of passages) {
    if (p.text_ref.mode === 'inline') {
      assert.equal(p.text_ref.text_hash, passageTextHash(p.text_ref.text))
    }
  }
})

test('passagesFromAdmittedPdf: rejects non-pdf bytes', async () => {
  const bytes = Buffer.from('not a pdf file', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, PDF_MEDIA_TYPE)
  await assert.rejects(() => passagesFromAdmittedPdf(admitted), /PDF header/)
})
