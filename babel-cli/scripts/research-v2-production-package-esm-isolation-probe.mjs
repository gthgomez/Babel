#!/usr/bin/env node
/**
 * Staged ESM resolution marker: resolve pdfjs (and canvas when present) from a dist
 * module parentURL, then assert realpaths stay inside BABEL_STAGED_ROOT.
 * Fails if host/workspace node_modules satisfy dist imports.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stageRoot = process.env.BABEL_STAGED_ROOT
if (!stageRoot) {
  throw new Error('BABEL_STAGED_ROOT is required')
}
if (process.env.NODE_PATH) {
  throw new Error('NODE_PATH must be unset for staged ESM isolation probe')
}
if (process.env.NODE_OPTIONS) {
  throw new Error('NODE_OPTIONS must be unset for staged ESM isolation probe')
}

const stageReal = realpathSync(stageRoot)
const distPdfModule = new URL('../dist/research/v2/adapters/documents/pdfFromAdmittedBytes.js', import.meta.url)

const markerPath = join(stageReal, 'node_modules', '.babel-staged-esm-marker')
assert.ok(existsSync(markerPath), `missing staged ESM marker at ${markerPath}`)
const markerBody = readFileSync(markerPath, 'utf8').trim()
assert.equal(markerBody, stageReal, 'staged ESM marker must match staged root realpath')

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
const pdfjsReal = assertRealpathUnderStage('pdfjs-dist/package.json (from dist parentURL)', pdfjsPkg)

let canvasPkg = null
let canvasPkgReal = null
try {
  canvasPkg = import.meta.resolve('@napi-rs/canvas/package.json', distPdfModule)
  canvasPkgReal = assertRealpathUnderStage('@napi-rs/canvas/package.json (from dist parentURL)', canvasPkg)
} catch {
  console.error(
    'esm_isolation_probe: @napi-rs/canvas not resolvable from dist under production flags (A must add direct dep + target-platform install)',
  )
}

let canvasNativeReal = null
if (canvasPkg) {
  const canvasRoot = dirname(fileURLToPath(canvasPkg))
  const nativeCandidates = [
    join(canvasRoot, 'index.node'),
    join(canvasRoot, 'skia.node'),
  ]
  let nativeFound = null
  for (const candidate of nativeCandidates) {
    if (existsSync(candidate)) {
      nativeFound = candidate
      break
    }
  }
  if (!nativeFound) {
    console.error(
      'esm_isolation_probe: canvas package present but native .node missing; optional @napi-rs/canvas-* platform entries omitted by --omit=optional (A must ensure target-platform install)',
    )
  } else {
    canvasNativeReal = assertRealpathUnderStage('@napi-rs/canvas native binding', pathToFileURL(nativeFound))
  }
}

console.log(
  JSON.stringify({
    marker: 'research-v2-production-package-esm-isolation-probe: ok',
    stageReal,
    pdfjsReal,
    canvasPkgReal,
    canvasNativeReal,
  }),
)
