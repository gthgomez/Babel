import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from './testAdmittedFixtures.js'
import { GeneralDocumentAdapter } from './generalDocumentAdapter.js'
import { PDF_TEXT_EXTRACTION_VERSION } from './pdfFromAdmittedBytes.js'

const pdfFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/two-page-sample.pdf')

function stubPort(fetchContent: SourceAccessPort['fetchContent']): SourceAccessPort {
  return {
    async search(request: SourceSearchRequest) {
      return {
        operationId: request.operationId,
        status: 'failed',
        failureCategory: 'search_provider_unavailable',
        message: 'test stub',
      }
    },
    fetchContent,
  }
}

test('GeneralDocumentAdapter.read: application/pdf via pdfjs page passages', async () => {
  const bytes = readFileSync(pdfFixture)
  const source: SourceRecord = {
    source_id: 'pdf-src',
    kind: 'document',
    canonical_key: 'fixture:pdf',
    observed_urls: ['https://example.invalid/sample.pdf'],
  }
  const port = stubPort(async (request: SourceFetchRequest) => ({
    operationId: request.operationId,
    status: 'ok',
    admitted: buildAdmittedContent(
      request.operationId,
      source.source_id,
      'rev-pdf',
      bytes,
      'application/pdf',
      {
        requestedUrl: 'https://example.invalid/sample.pdf',
        finalUrl: 'https://example.invalid/sample.pdf',
        redirectChain: ['https://example.invalid/sample.pdf'],
      },
    ),
  }))
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-pdf', source, signal: AbortSignal.timeout(30_000) },
    port,
  )
  assert.equal(result.status, 'ok')
  if (result.status !== 'ok') return
  assert.equal(result.extraction_version, PDF_TEXT_EXTRACTION_VERSION)
  assert.equal(result.passages.length, 2)
})

test('GeneralDocumentAdapter.read: malformed pdf bytes extraction_failed', async () => {
  const bytes = Buffer.from('%PDF-1.4\n% corrupted', 'utf8')
  const source: SourceRecord = {
    source_id: 'bad-pdf',
    kind: 'document',
    canonical_key: 'fixture:bad',
    observed_urls: ['https://example.invalid/bad.pdf'],
  }
  const port = stubPort(async (request: SourceFetchRequest) => ({
    operationId: request.operationId,
    status: 'ok',
    admitted: buildAdmittedContent(request.operationId, source.source_id, 'rev', bytes, 'application/pdf', {
      requestedUrl: 'https://example.invalid/bad.pdf',
      finalUrl: 'https://example.invalid/bad.pdf',
      redirectChain: ['https://example.invalid/bad.pdf'],
    }),
  }))
  const result = await new GeneralDocumentAdapter().read(
    { operationId: 'op-bad', source, signal: AbortSignal.timeout(30_000) },
    port,
  )
  assert.equal(result.status, 'failed')
})
