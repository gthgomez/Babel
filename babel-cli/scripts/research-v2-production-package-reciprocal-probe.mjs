#!/usr/bin/env node
/**
 * Runs inside a staged package root (BABEL_STAGED_ROOT): imports built dist from
 * ../dist (packaged layout); pdfjs/canvas must resolve from staged node_modules only.
 */
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stageRoot = process.env.BABEL_STAGED_ROOT
if (!stageRoot) {
  throw new Error('BABEL_STAGED_ROOT is required (staged package root with node_modules + dist)')
}
if (process.env.NODE_PATH) {
  throw new Error('NODE_PATH must be unset for staged reciprocal probe (no host dependency fallback)')
}
if (process.env.NODE_OPTIONS) {
  throw new Error('NODE_OPTIONS must be unset for staged reciprocal probe')
}

const stageReal = realpathSync(stageRoot)
const distRoot = join(stageReal, 'dist')
const distUrl = pathToFileURL(join(distRoot, '/')).href
const distPdfModule = new URL('research/v2/adapters/documents/pdfFromAdmittedBytes.js', distUrl)
const fixturePath = join(stageReal, 'reciprocal', 'fixtures', 'two-page-sample.pdf')

function assertRealpathUnderStage(label, resolvedUrl) {
  const resolvedPath = fileURLToPath(resolvedUrl)
  const resolvedReal = realpathSync(resolvedPath)
  const prefix = stageReal.endsWith(sep) ? stageReal : stageReal + sep
  assert.ok(
    resolvedReal === stageReal || resolvedReal.startsWith(prefix),
    `${label} resolved outside stage: ${resolvedReal} (stage ${stageReal})`,
  )
  return resolvedReal
}

const pdfjsPkg = import.meta.resolve('pdfjs-dist/package.json', distPdfModule)
assertRealpathUnderStage('pdfjs-dist/package.json (from dist parentURL)', pdfjsPkg)
try {
  assertRealpathUnderStage(
    '@napi-rs/canvas/package.json (from dist parentURL)',
    import.meta.resolve('@napi-rs/canvas/package.json', distPdfModule),
  )
} catch {
  console.error(
    'staged_probe: @napi-rs/canvas not installed under production flags (expected until A #406 package repair lands)',
  )
}

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

// Deterministic control hook (injected stall at load stage) — not evidence of pdfjs destroy/cleanup.
const admitted = buildAdmittedContent('op-cancel-prod', source.source_id, 'rev', pdfBytes, 'application/pdf')
const controller = new AbortController()
const cancelPromise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'loading' })
controller.abort()
await assert.rejects(cancelPromise, (err) => err instanceof PdfExtractionCancelled)

console.log('research-v2-production-package-reciprocal-probe: ok')
