#!/usr/bin/env node
/**
 * B reciprocal probe: real two-page PDF extraction + cancellation cleanup under a
 * production-shaped node_modules tree (see integration test for npm ci flags).
 *
 * Requires:
 * - NODE_PATH → directory with `npm ci --omit=dev --omit=optional` output
 * - BABEL_CLI_DIST → babel-cli/dist (built adapter + pdfjs import path)
 * - BABEL_PDF_FIXTURE → absolute path to two-page-sample.pdf
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const dist = process.env.BABEL_CLI_DIST
const fixturePath = process.env.BABEL_PDF_FIXTURE
if (!dist || !fixturePath) {
  throw new Error('BABEL_CLI_DIST and BABEL_PDF_FIXTURE are required')
}

const distUrl = pathToFileURL(dist.endsWith('/') ? dist : `${dist}/`).href

const { GeneralDocumentAdapter } = await import(
  new URL('research/v2/adapters/documents/generalDocumentAdapter.js', distUrl).href
)
const { buildAdmittedContent } = await import(
  new URL('research/v2/adapters/documents/testAdmittedFixtures.js', distUrl).href
)
const { passagesFromAdmittedPdf } = await import(
  new URL('research/v2/adapters/documents/pdfFromAdmittedBytes.js', distUrl).href
)
const { PdfExtractionCancelled } = await import(
  new URL('research/v2/adapters/documents/pdfExtractionLimits.js', distUrl).href
)

const pdfBytes = readFileSync(fixturePath)
const source = {
  source_id: 'src-prod-reciprocal-pdf',
  kind: 'document',
  canonical_key: 'fixture:two-page-pdf',
  observed_urls: ['https://example.invalid/two-page-sample.pdf'],
}

const port = {
  async search() {
    return { operationId: 'unused', status: 'failed', failureCategory: 'not_supported', message: 'read-only' }
  },
  async fetchContent(request) {
    return {
      operationId: request.operationId,
      status: 'ok',
      admitted: buildAdmittedContent(
        request.operationId,
        source.source_id,
        'rev-prod-reciprocal',
        pdfBytes,
        'application/pdf',
        {
          requestedUrl: source.observed_urls[0],
          finalUrl: source.observed_urls[0],
          redirectChain: source.observed_urls,
        },
      ),
    }
  },
}

const adapter = new GeneralDocumentAdapter()
const readResult = await adapter.read(
  { operationId: 'op-prod-reciprocal', source, signal: AbortSignal.timeout(120_000) },
  port,
)
if (readResult.status !== 'ok') {
  const detail =
    readResult.status === 'failed'
      ? `${readResult.failureCategory}: ${readResult.message}`
      : readResult.status
  throw new Error(`production-package reciprocal PDF read failed: ${detail}`)
}
assert.equal(readResult.passages.length, 2, 'expected two page passages from two-page fixture')
for (const passage of readResult.passages) {
  assert.equal(passage.locator.kind, 'page')
}

const admitted = buildAdmittedContent('op-cancel-prod', source.source_id, 'rev', pdfBytes, 'application/pdf')
const controller = new AbortController()
const cancelPromise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'loading' })
controller.abort()
await assert.rejects(cancelPromise, (err) => err instanceof PdfExtractionCancelled)

console.log('research-v2-production-package-reciprocal-probe: ok')
