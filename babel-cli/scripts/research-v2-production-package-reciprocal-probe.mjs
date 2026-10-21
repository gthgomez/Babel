#!/usr/bin/env node
/**
 * Runs inside a staged package root (BABEL_STAGED_ROOT): imports dist from
 * ./runtime/dist only; pdfjs/canvas resolve from ./node_modules (no host fallback).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stageRoot = process.env.BABEL_STAGED_ROOT
if (!stageRoot) {
  throw new Error('BABEL_STAGED_ROOT is required (staged package root with node_modules + runtime/dist)')
}
if (process.env.NODE_PATH) {
  throw new Error('NODE_PATH must be unset for staged reciprocal probe (no host dependency fallback)')
}

const probeDir = dirname(fileURLToPath(import.meta.url))
const stageRootResolved = join(stageRoot, '.')
const distRoot = join(stageRootResolved, 'runtime', 'dist')
const distUrl = pathToFileURL(join(distRoot, '/')).href
const fixturePath = join(stageRootResolved, 'reciprocal', 'fixtures', 'two-page-sample.pdf')

async function assertDependencyResolvedUnderStage(specifier) {
  const resolved = import.meta.resolve(specifier, import.meta.url)
  const resolvedPath = fileURLToPath(resolved)
  const nm = join(stageRootResolved, 'node_modules')
  assert.ok(
    resolvedPath.startsWith(nm + '/') || resolvedPath.startsWith(nm + '\\'),
    `${specifier} must resolve under staged node_modules, got ${resolvedPath}`,
  )
  return resolvedPath
}

await assertDependencyResolvedUnderStage('pdfjs-dist/package.json')
try {
  await assertDependencyResolvedUnderStage('@napi-rs/canvas/package.json')
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

const admitted = buildAdmittedContent('op-cancel-prod', source.source_id, 'rev', pdfBytes, 'application/pdf')
const controller = new AbortController()
const cancelPromise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'loading' })
controller.abort()
await assert.rejects(cancelPromise, (err) => err instanceof PdfExtractionCancelled)

console.log('research-v2-production-package-reciprocal-probe: ok')
