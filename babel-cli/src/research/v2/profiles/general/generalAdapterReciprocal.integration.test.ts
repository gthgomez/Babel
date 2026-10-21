import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { PassageRecordSchema } from '../../contracts/passages.js'
import type { SourceAdapter } from '../../ports/sourceAdapter.js'
import type { SourceAccessPort, SourceFetchRequest, SourceSearchRequest } from '../../ports/sourceAccessPort.js'
import type { SourceRecord } from '../../contracts/sources.js'
import { buildAdmittedContent } from '../../adapters/documents/testAdmittedFixtures.js'
import { resolveQuarantinedFixturePath } from '../../adapters/documents/quarantinePath.js'
import { passageTextHash } from '../../adapters/documents/passageInlineText.js'
import { PDF_TEXT_EXTRACTION_VERSION } from '../../adapters/documents/pdfFromAdmittedBytes.js'
import { STATIC_HTML_EXTRACTION_VERSION } from '../../adapters/web/htmlFromAdmittedBytes.js'
import { PdfExtractionCancelled } from '../../adapters/documents/pdfExtractionLimits.js'
import { generalAdapterCatalog } from './generalAdapterCatalog.js'

const devCorpusRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/dev-corpus',
)
const pdfFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../adapters/documents/fixtures/two-page-sample.pdf',
)

/** Mirrors Agent A registry registration keys → bare adapterId lookup. */
function registryFromCatalog(): {
  getAdapter(adapterId: string): SourceAdapter | undefined
  registeredKeys: string[]
} {
  const adapters = [
    generalAdapterCatalog.document.factory(),
    generalAdapterCatalog.web.factory(),
  ]
  const byId = new Map(adapters.map((a) => [a.adapterId, a]))
  return {
    getAdapter: (id) => byId.get(id),
    registeredKeys: [
      `documents/${generalAdapterCatalog.document.adapterId}`,
      `web/${generalAdapterCatalog.web.adapterId}`,
    ],
  }
}

function trackingPort(fetchContent: SourceAccessPort['fetchContent']): {
  port: SourceAccessPort
  getSearchCalls: () => number
} {
  let searchCalls = 0
  return {
    getSearchCalls: () => searchCalls,
    port: {
      async search(request: SourceSearchRequest) {
        searchCalls++
        return {
          operationId: request.operationId,
          status: 'failed',
          failureCategory: 'search_provider_unavailable',
          message: 'integration stub search',
        }
      },
      fetchContent,
    },
  }
}

function assertPassageProvenance(
  operationId: string,
  revisionId: string,
  passages: Array<{ passage_id: string; source_revision_id: string; text_ref: { mode: string; text?: string; text_hash?: string } }>,
): void {
  for (const passage of passages) {
    PassageRecordSchema.parse(passage)
    assert.equal(passage.source_revision_id, revisionId)
    assert.match(passage.passage_id, new RegExp(`^${operationId}:`))
    if (passage.text_ref.mode === 'inline') {
      assert.equal(passage.text_ref.text_hash, passageTextHash(passage.text_ref.text ?? ''))
      assert.ok((passage.text_ref.text ?? '').length <= 32_000)
    }
  }
}

describe('general adapter reciprocal integration (B80 catalog, offline)', () => {
  it('registers catalog factories under bare adapterId (A registry contract)', () => {
    const reg = registryFromCatalog()
    assert.deepEqual(reg.registeredKeys, [
      'documents/general-document/0.1.0',
      'web/general-web/0.1.0',
    ])
    assert.ok(reg.getAdapter(generalAdapterCatalog.document.adapterId))
    assert.ok(reg.getAdapter(generalAdapterCatalog.web.adapterId))
    assert.equal(reg.getAdapter('documents/general-document/0.1.0'), undefined)
  })

  it('discover → honest not_supported on document and web without port search (B80)', async () => {
    const reg = registryFromCatalog()
    const { port, getSearchCalls } = trackingPort(async () => ({
      operationId: 'unused',
      status: 'cancelled',
    }))
    for (const adapterId of [
      generalAdapterCatalog.document.adapterId,
      generalAdapterCatalog.web.adapterId,
    ]) {
      const adapter = reg.getAdapter(adapterId)
      assert.ok(adapter)
      const result = await adapter.discover(
        { operationId: `disc-${adapterId}`, query: 'widgets', signal: AbortSignal.timeout(2_000) },
        port,
      )
      assert.equal(result.status, 'failed')
      if (result.status === 'failed') {
        assert.equal(result.failureCategory, 'not_supported')
      }
    }
    assert.equal(getSearchCalls(), 0)
  })

  it('fetch → read: G-DEV-01 HTML through registered web adapter', async () => {
    const reg = registryFromCatalog()
    const adapter = reg.getAdapter(generalAdapterCatalog.web.adapterId)
    assert.ok(adapter)
    const rel = 'G-DEV-01/sources/plan-a.html'
    const bytes = readFileSync(resolveQuarantinedFixturePath(devCorpusRoot, rel))
    const source: SourceRecord = {
      source_id: 'src-plan-a',
      kind: 'web',
      canonical_key: 'fixture:plan-a',
      observed_urls: ['https://example.invalid/plan-a'],
    }
    const operationId = 'op-html-reciprocal'
    const revisionId = 'rev-plan-a'
    const { port } = trackingPort(async (request: SourceFetchRequest) => ({
      operationId: request.operationId,
      status: 'ok',
      admitted: buildAdmittedContent(
        request.operationId,
        source.source_id,
        revisionId,
        bytes,
        'text/html',
        {
          requestedUrl: 'https://example.invalid/plan-a',
          finalUrl: 'https://example.invalid/plan-a',
          redirectChain: ['https://example.invalid/plan-a'],
        },
      ),
    }))
    const result = await adapter.read(
      { operationId, source, signal: AbortSignal.timeout(10_000) },
      port,
    )
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.operationId, operationId)
    assert.equal(result.extraction_version, STATIC_HTML_EXTRACTION_VERSION)
    assert.equal(result.revision.revision_id, revisionId)
    assert.ok(result.passages.length >= 1)
    assertPassageProvenance(operationId, revisionId, result.passages)
    const sectionIds = result.passages
      .map((p) => (p.locator.kind === 'section' ? p.locator.section_id : ''))
      .filter(Boolean)
    assert.equal(new Set(sectionIds).size, sectionIds.length)
  })

  it('fetch → read: two-page PDF through registered document adapter', async () => {
    const reg = registryFromCatalog()
    const adapter = reg.getAdapter(generalAdapterCatalog.document.adapterId)
    assert.ok(adapter)
    const bytes = readFileSync(pdfFixture)
    const source: SourceRecord = {
      source_id: 'src-two-page-pdf',
      kind: 'document',
      canonical_key: 'fixture:two-page-pdf',
      observed_urls: ['https://example.invalid/two-page-sample.pdf'],
    }
    const operationId = 'op-pdf-reciprocal'
    const revisionId = 'rev-pdf-2p'
    const { port } = trackingPort(async (request: SourceFetchRequest) => ({
      operationId: request.operationId,
      status: 'ok',
      admitted: buildAdmittedContent(
        request.operationId,
        source.source_id,
        revisionId,
        bytes,
        'application/pdf',
        {
          requestedUrl: 'https://example.invalid/two-page-sample.pdf',
          finalUrl: 'https://example.invalid/two-page-sample.pdf',
          redirectChain: ['https://example.invalid/two-page-sample.pdf'],
        },
      ),
    }))
    const result = await adapter.read(
      { operationId, source, signal: AbortSignal.timeout(60_000) },
      port,
    )
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.operationId, operationId)
    assert.equal(result.extraction_version, PDF_TEXT_EXTRACTION_VERSION)
    assert.equal(result.passages.length, 2)
    assertPassageProvenance(operationId, revisionId, result.passages)
    for (const passage of result.passages) {
      assert.equal(passage.locator.kind, 'page')
    }
  })

  it('read: post-fetch abort returns cancelled without hanging PDF cleanup', async () => {
    const reg = registryFromCatalog()
    const adapter = reg.getAdapter(generalAdapterCatalog.document.adapterId)
    assert.ok(adapter)
    const bytes = readFileSync(pdfFixture)
    const source: SourceRecord = {
      source_id: 'src-pdf-cancel',
      kind: 'document',
      canonical_key: 'fixture:pdf-cancel',
      observed_urls: ['https://example.invalid/two-page-sample.pdf'],
    }
    const controller = new AbortController()
    const { port } = trackingPort(async (request: SourceFetchRequest) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      return {
        operationId: request.operationId,
        status: 'ok',
        admitted: buildAdmittedContent(
          request.operationId,
          source.source_id,
          'rev',
          bytes,
          'application/pdf',
          {
            requestedUrl: 'https://example.invalid/two-page-sample.pdf',
            finalUrl: 'https://example.invalid/two-page-sample.pdf',
            redirectChain: ['https://example.invalid/two-page-sample.pdf'],
          },
        ),
      }
    })
    const started = Date.now()
    const result = await adapter.read(
      { operationId: 'op-cancel', source, signal: controller.signal },
      port,
    )
    assert.equal(result.status, 'cancelled')
    assert.ok(Date.now() - started < 5_000)
  })

  it('read: stalled PDF load abort rejects with PdfExtractionCancelled via adapter', async () => {
    const { passagesFromAdmittedPdf } = await import('../../adapters/documents/pdfFromAdmittedBytes.js')
    const bytes = readFileSync(pdfFixture)
    const admitted = buildAdmittedContent('op', 's', 'r', bytes, 'application/pdf')
    const controller = new AbortController()
    const promise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'loading' })
    controller.abort()
    await assert.rejects(promise, (err: unknown) => err instanceof PdfExtractionCancelled)
  })
})
