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
import { MAX_INLINE_PASSAGE_UTF16_UNITS, passageTextHash } from './passageInlineText.js'

const pdfFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/two-page-sample.pdf')

function pdfAdmitted(operationId = 'op-pdf') {
  const bytes = readFileSync(pdfFixture)
  return buildAdmittedContent(operationId, 'src', 'rev', bytes, PDF_MEDIA_TYPE, {
    requestedUrl: 'https://example.invalid/two-page-sample.pdf',
    finalUrl: 'https://example.invalid/two-page-sample.pdf',
    redirectChain: ['https://example.invalid/two-page-sample.pdf'],
  })
}

test('passagesFromAdmittedPdf: two-page fixture with page locators', async () => {
  const passages = await passagesFromAdmittedPdf(pdfAdmitted())
  assert.equal(passages.length, 2)
  assert.equal(passages[0]?.locator.kind, 'page')
  assert.equal(passages[0]?.locator.start_page, 1)
  assert.match(passages[0]?.text_ref.mode === 'inline' ? passages[0].text_ref.text : '', /retention 90 days/)
  assert.match(passages[1]?.text_ref.mode === 'inline' ? passages[1].text_ref.text : '', /2026-03-15/)
  for (const p of passages) PassageRecordSchema.parse(p)
  assert.equal(PDF_TEXT_EXTRACTION_VERSION, 'general-pdf-text/0.1.0')
})

test('passagesFromAdmittedPdf: cancellation during delayed page loop', async () => {
  const admitted = pdfAdmitted()
  const controller = new AbortController()
  const promise = passagesFromAdmittedPdf(admitted, controller.signal, { pageDelayMs: 80 })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(promise, (err: unknown) => err instanceof PdfExtractionCancelled)
})

test('passagesFromAdmittedPdf: abort interrupts stalled loading without waiting', async () => {
  const admitted = pdfAdmitted()
  const controller = new AbortController()
  const started = Date.now()
  const promise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'loading' })
  controller.abort()
  await assert.rejects(promise, (err: unknown) => err instanceof PdfExtractionCancelled)
  assert.ok(Date.now() - started < 500)
})

test('passagesFromAdmittedPdf: abort interrupts stalled getPage', async () => {
  const admitted = pdfAdmitted()
  const controller = new AbortController()
  const started = Date.now()
  const promise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'getPage' })
  controller.abort()
  await assert.rejects(promise, (err: unknown) => err instanceof PdfExtractionCancelled)
  assert.ok(Date.now() - started < 500)
})

test('passagesFromAdmittedPdf: abort interrupts stalled getTextContent', async () => {
  const admitted = pdfAdmitted()
  const controller = new AbortController()
  const started = Date.now()
  const promise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'getTextContent' })
  controller.abort()
  await assert.rejects(promise, (err: unknown) => err instanceof PdfExtractionCancelled)
  assert.ok(Date.now() - started < 500)
})

test('passagesFromAdmittedPdf: hashes emitted inline text only when truncated', async () => {
  const passages = await passagesFromAdmittedPdf(pdfAdmitted('op'))
  for (const p of passages) {
    if (p.text_ref.mode === 'inline') {
      assert.equal(p.text_ref.text_hash, passageTextHash(p.text_ref.text))
    }
  }
})

test('passagesFromAdmittedPdf: long unicode page text satisfies PassageRecordSchema', async () => {
  const emoji = '😀'
  const pageText = 'a'.repeat(MAX_INLINE_PASSAGE_UTF16_UNITS - 1) + emoji
  const passages = await passagesFromAdmittedPdf(pdfAdmitted(), undefined, {
    synthesizePageText: { 1: pageText },
  })
  assert.equal(passages.length, 1)
  PassageRecordSchema.parse(passages[0])
  if (passages[0]?.text_ref.mode === 'inline') {
    assert.equal(passages[0].text_ref.text.length, MAX_INLINE_PASSAGE_UTF16_UNITS - 1)
    assert.equal(passages[0].text_ref.text_hash, passageTextHash(passages[0].text_ref.text))
  }
})

test('passagesFromAdmittedPdf: rejected load destroys loading task', async () => {
  let destroyCalls = 0
  const admitted = pdfAdmitted()
  await assert.rejects(
    () =>
      passagesFromAdmittedPdf(admitted, undefined, {
        testHooks: {
          createLoadingTask: () => ({
            promise: Promise.reject(new Error('synthetic load failure')),
            destroy: () => {
              destroyCalls++
              return Promise.reject(new Error('synthetic destroy failure'))
            },
          }),
        },
      }),
    /synthetic load failure/,
  )
  assert.ok(destroyCalls >= 1)
})

test('passagesFromAdmittedPdf: aborted read returns while hanging doc destroy stays bounded', async () => {
  const user = new AbortController()
  const admitted = pdfAdmitted()
  const promise = passagesFromAdmittedPdf(admitted, user.signal, {
    testHooks: {
      createLoadingTask: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: () => new Promise<{ items: Array<{ str?: string }> }>(() => {}),
          }),
          destroy: () => new Promise<void>(() => {}),
        }),
        destroy: () => Promise.resolve(),
      }),
    },
  })
  user.abort()
  const started = Date.now()
  await assert.rejects(promise, (err: unknown) => err instanceof PdfExtractionCancelled)
  assert.ok(Date.now() - started < 500)
})

test('passagesFromAdmittedPdf: rejects non-pdf bytes', async () => {
  const bytes = Buffer.from('not a pdf file', 'utf8')
  const admitted = buildAdmittedContent('op', 's', 'r', bytes, PDF_MEDIA_TYPE)
  await assert.rejects(() => passagesFromAdmittedPdf(admitted), /PDF header/)
})
