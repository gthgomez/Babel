#!/usr/bin/env node
/**
 * Staged ESM resolution marker: resolve pdfjs, @napi-rs/canvas wrapper, and the
 * host platform binding package (e.g. @napi-rs/canvas-linux-x64-gnu) from dist
 * parentURL; assert realpaths stay inside BABEL_STAGED_ROOT. Fail closed.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
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

function resolveCanvasPlatformBindingPackage(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return '@napi-rs/canvas-linux-x64-gnu'
  if (platform === 'linux' && arch === 'arm64') return '@napi-rs/canvas-linux-arm64-gnu'
  if (platform === 'win32' && arch === 'x64') return '@napi-rs/canvas-win32-x64-msvc'
  if (platform === 'darwin' && arch === 'arm64') return '@napi-rs/canvas-darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return '@napi-rs/canvas-darwin-x64'
  return null
}

function assertResolvedUnderStageFromDist(specifier, label) {
  const resolved = import.meta.resolve(specifier, distPdfModule)
  return assertRealpathUnderStage(label, resolved)
}

const pdfjsReal = assertResolvedUnderStageFromDist(
  'pdfjs-dist/package.json',
  'pdfjs-dist/package.json (from dist parentURL)',
)

const canvasPkgReal = assertResolvedUnderStageFromDist(
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
const canvasPlatformNativeReal = assertRealpathUnderStage(
  `${platformBindingPkg} native .node`,
  pathToFileURL(join(platformPkgDir, nativeNodeFiles[0])),
)

console.log(
  JSON.stringify({
    marker: 'research-v2-production-package-esm-isolation-probe: ok',
    qualification: 'linux_staged_production_flags_only_not_windows_pack_qualification',
    stageReal,
    pdfjsReal,
    canvasPkgReal,
    canvasPlatformBindingPackage: platformBindingPkg,
    canvasPlatformPkgReal: platformPkgReal,
    canvasPlatformNativeReal,
  }),
)
