#!/usr/bin/env node
/**
 * Runs inside a staged package root (BABEL_STAGED_ROOT): imports built dist from
 * ../dist (packaged layout); pdfjs/canvas must resolve from staged node_modules only.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
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

function resolveCanvasPlatformBindingPackage(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return '@napi-rs/canvas-linux-x64-gnu'
  if (platform === 'linux' && arch === 'arm64') return '@napi-rs/canvas-linux-arm64-gnu'
  if (platform === 'win32' && arch === 'x64') return '@napi-rs/canvas-win32-x64-msvc'
  if (platform === 'darwin' && arch === 'arm64') return '@napi-rs/canvas-darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return '@napi-rs/canvas-darwin-x64'
  return null
}

function assertResolvedUnderStageFromDist(specifier, label) {
  return assertRealpathUnderStage(label, import.meta.resolve(specifier, distPdfModule))
}

assertResolvedUnderStageFromDist('pdfjs-dist/package.json', 'pdfjs-dist/package.json (from dist parentURL)')
assertResolvedUnderStageFromDist(
  '@napi-rs/canvas/package.json',
  '@napi-rs/canvas/package.json (from dist parentURL)',
)
const platformBindingPkg = resolveCanvasPlatformBindingPackage()
assert.ok(
  platformBindingPkg,
  `no @napi-rs/canvas platform binding mapping for ${process.platform}/${process.arch}`,
)
const platformPkgReal = assertResolvedUnderStageFromDist(
  `${platformBindingPkg}/package.json`,
  `${platformBindingPkg}/package.json (from dist parentURL)`,
)
const platformPkgDir = dirname(platformPkgReal)
const nativeNodeFiles = readdirSync(platformPkgDir).filter((name) => name.endsWith('.node'))
assert.ok(
  nativeNodeFiles.length > 0,
  `${platformBindingPkg} must contain a .node native binary (found none in ${platformPkgDir})`,
)
assertRealpathUnderStage(
  `${platformBindingPkg} native .node`,
  pathToFileURL(join(platformPkgDir, nativeNodeFiles[0])),
)

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
const extractedPageText = []
for (const passage of readResult.passages) {
  assert.equal(passage.locator.kind, 'page')
  if (passage.text_ref.mode === 'inline') {
    extractedPageText.push(passage.text_ref.text ?? '')
  }
}
console.log(
  JSON.stringify({
    pdf_extracted_page_text: extractedPageText,
    qualification: 'linux_staged_production_flags_only_not_windows_pack_qualification',
  }),
)

// Deterministic control hook (injected stall at load stage) — not evidence of pdfjs destroy/cleanup.
const admitted = buildAdmittedContent('op-cancel-prod', source.source_id, 'rev', pdfBytes, 'application/pdf')
const controller = new AbortController()
const cancelPromise = passagesFromAdmittedPdf(admitted, controller.signal, { stallStage: 'loading' })
controller.abort()
await assert.rejects(cancelPromise, (err) => err instanceof PdfExtractionCancelled)

console.log('research-v2-production-package-reciprocal-probe: ok')
