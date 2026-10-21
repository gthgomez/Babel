#!/usr/bin/env node
/**
 * Explicit packaging integration: stage a production npm ci tree (Windows package flags),
 * install @napi-rs/canvas platform binding (A-owned), copy built dist + B probes, run
 * ESM isolation then PDF probe with loader env cleared. Writes a receipt path.
 *
 * Aligns with B #404 @ 8eb70ae0 reciprocal probes; not a default unit-test shard.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCanvasNativeBindingLoads,
  installCanvasPlatformBinding,
  resolveCanvasPlatformBindingPackage,
  resolveInstalledModulePaths,
} from './research-v2-canvas-platform-binding.mjs'

const babelCliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(babelCliRoot, '..')

/** Matches babel-desktop/scripts/package-windows.mjs production npm ci flags. */
const PRODUCTION_NPM_CI_ARGS = [
  'ci',
  '--omit=dev',
  '--omit=optional',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]

function parseArg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

function stagedChildEnv(stageRoot, extra = {}) {
  const env = { BABEL_STAGED_ROOT: stageRoot, ...extra }
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function runStagedScript(stageRoot, scriptPath, extraEnv = {}) {
  return execFileSync(process.execPath, [scriptPath], {
    cwd: stageRoot,
    env: stagedChildEnv(stageRoot, extraEnv),
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 300_000,
  })
}

function canvasInstallEvidence(stageRoot) {
  const canvasPkg = join(stageRoot, 'node_modules', '@napi-rs', 'canvas', 'package.json')
  const pdfjsPkg = join(stageRoot, 'node_modules', 'pdfjs-dist', 'package.json')
  let modulePaths = null
  try {
    modulePaths = resolveInstalledModulePaths(stageRoot)
  } catch {
    modulePaths = null
  }
  return {
    canvasPackageJsonPresent: existsSync(canvasPkg),
    pdfjsPackageJsonPresent: existsSync(pdfjsPkg),
    canvasVersion: existsSync(canvasPkg)
      ? JSON.parse(readFileSync(canvasPkg, 'utf8')).version
      : null,
    platformBindingPackage: resolveCanvasPlatformBindingPackage(),
    modulePaths,
  }
}

async function main() {
  const keepStage = process.argv.includes('--keep-stage')
  const receiptPath =
    parseArg('receipt') ?? join(repoRoot, 'review-artifacts/integration-406-production-package-reciprocal-run.txt')

  const npmCli = process.env.npm_execpath
  if (!npmCli) {
    console.error('Run via npm (npm_execpath required for platform canvas binding install)')
    process.exit(1)
  }

  execFileSync('npm', ['run', 'build'], {
    cwd: babelCliRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 300_000,
  })

  const stageRoot = resolve(parseArg('stage') ?? mkdtempSync(join(tmpdir(), 'babel-prod-reciprocal-stage-')))
  const reciprocalDir = join(stageRoot, 'reciprocal')
  const fixtureDir = join(reciprocalDir, 'fixtures')
  const stagedDist = join(stageRoot, 'dist')

  mkdirSync(fixtureDir, { recursive: true })

  cpSync(join(babelCliRoot, 'package.json'), join(stageRoot, 'package.json'))
  cpSync(join(babelCliRoot, 'package-lock.json'), join(stageRoot, 'package-lock.json'))
  cpSync(join(babelCliRoot, 'dist'), stagedDist, { recursive: true })
  cpSync(
    join(babelCliRoot, 'src/research/v2/adapters/documents/fixtures/two-page-sample.pdf'),
    join(fixtureDir, 'two-page-sample.pdf'),
  )
  cpSync(
    join(babelCliRoot, 'scripts/research-v2-production-package-reciprocal-probe.mjs'),
    join(reciprocalDir, 'probe.mjs'),
  )
  cpSync(
    join(babelCliRoot, 'scripts/research-v2-production-package-esm-isolation-probe.mjs'),
    join(reciprocalDir, 'esm-isolation-probe.mjs'),
  )

  let npmCiOutput = ''
  try {
    npmCiOutput = execFileSync('npm', PRODUCTION_NPM_CI_ARGS, {
      cwd: stageRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
    })
  } catch (error) {
    const err = error
    writeReceipt(receiptPath, {
      stageRoot,
      outcome: 'npm_ci_failed',
      npmCiStdout: err.stdout ?? '',
      npmCiStderr: err.stderr ?? '',
      message: err.message ?? String(err),
      canvas: canvasInstallEvidence(stageRoot),
    })
    if (!keepStage) rmSync(stageRoot, { recursive: true, force: true })
    process.exit(1)
  }

  let platformBindingInstalled = null
  let platformBindingError = ''
  try {
    platformBindingInstalled = installCanvasPlatformBinding({
      cwd: stageRoot,
      npmCli,
      nodeExec: process.execPath,
    })
    process.env.BABEL_STAGED_CANVAS_BINDING_PKG = platformBindingInstalled
  } catch (error) {
    platformBindingError = error instanceof Error ? error.message : String(error)
    writeReceipt(receiptPath, {
      stageRoot,
      outcome: 'canvas_platform_binding_failed',
      productionNpmCiArgs: PRODUCTION_NPM_CI_ARGS.join(' '),
      platformBindingError,
      canvas: canvasInstallEvidence(stageRoot),
    })
    if (!keepStage) rmSync(stageRoot, { recursive: true, force: true })
    process.exit(1)
  }

  const stageReal = realpathSync(stageRoot)
  writeFileSync(join(stageRoot, 'node_modules', '.babel-staged-esm-marker'), `${stageReal}\n`)

  let canvasNative = null
  let canvasNativeError = ''
  try {
    canvasNative = await assertCanvasNativeBindingLoads(stageRoot)
  } catch (error) {
    canvasNativeError = error instanceof Error ? error.message : String(error)
    writeReceipt(receiptPath, {
      stageRoot,
      outcome: 'canvas_native_binding_missing',
      productionNpmCiArgs: PRODUCTION_NPM_CI_ARGS.join(' '),
      platformBindingInstalled,
      canvasNativeError,
      canvas: canvasInstallEvidence(stageRoot),
    })
    if (!keepStage) rmSync(stageRoot, { recursive: true, force: true })
    process.exit(1)
  }

  const canvas = { ...canvasInstallEvidence(stageRoot), canvasNativePath: canvasNative.nativePath }

  let esmStdout = ''
  let esmStderr = ''
  let esmExit = 0
  let esmError = ''
  try {
    esmStdout = runStagedScript(stageRoot, join(reciprocalDir, 'esm-isolation-probe.mjs'), {
      BABEL_STAGED_CANVAS_BINDING_PKG: platformBindingInstalled ?? '',
    })
  } catch (error) {
    esmExit = 1
    const err = error
    esmStdout = err.stdout ?? ''
    esmStderr = err.stderr ?? ''
    esmError = err.message ?? String(err)
    if (typeof err.status === 'number') esmExit = err.status
  }

  let probeStdout = ''
  let probeStderr = ''
  let probeExit = 0
  let probeError = ''
  if (esmExit === 0) {
    try {
      probeStdout = runStagedScript(stageRoot, join(reciprocalDir, 'probe.mjs'))
    } catch (error) {
      probeExit = 1
      const err = error
      probeStdout = err.stdout ?? ''
      probeStderr = err.stderr ?? ''
      probeError = err.message ?? String(err)
      if (typeof err.status === 'number') probeExit = err.status
    }
  } else {
    probeExit = 1
    probeError = 'skipped: ESM isolation probe failed'
  }

  const outcome =
    esmExit === 0 &&
    probeExit === 0 &&
    probeStdout.includes('research-v2-production-package-reciprocal-probe: ok')
      ? 'probe_ok'
      : esmExit !== 0
        ? 'esm_isolation_failed'
        : 'probe_failed'

  writeReceipt(receiptPath, {
    stageRoot,
    outcome,
    productionNpmCiArgs: PRODUCTION_NPM_CI_ARGS.join(' '),
    npmCiOutputTail: npmCiOutput.split('\n').slice(-8).join('\n'),
    platformBindingInstalled,
    canvas,
    esmExit,
    esmStdout,
    esmStderr,
    esmError,
    probeExit,
    probeStdout,
    probeStderr,
    probeError,
    coordinationNote:
      'A #406: direct @napi-rs/canvas + pdfjs-dist in dependencies; platform binding installed after npm ci --omit=optional; dist loads canvas before pdfjs (DOMMatrix).',
  })

  if (!keepStage) rmSync(stageRoot, { recursive: true, force: true })

  if (outcome !== 'probe_ok') {
    console.error(`production-package reciprocal: ${outcome} (receipt: ${receiptPath})`)
    process.exit(esmExit || probeExit || 1)
  }
  console.log(`production-package reciprocal: ok (receipt: ${receiptPath})`)
}

function writeReceipt(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  const text = [
    `# generated ${new Date().toISOString()}`,
    `outcome=${body.outcome}`,
    `stageRoot=${body.stageRoot}`,
    `production_npm_ci=${body.productionNpmCiArgs ?? ''}`,
    `platform_binding_installed=${body.platformBindingInstalled ?? ''}`,
    `canvas_package_json_present=${body.canvas?.canvasPackageJsonPresent}`,
    `pdfjs_package_json_present=${body.canvas?.pdfjsPackageJsonPresent}`,
    `canvas_version=${body.canvas?.canvasVersion ?? 'null'}`,
    body.canvas?.modulePaths
      ? `module_paths=${JSON.stringify(body.canvas.modulePaths)}`
      : '',
    body.platformBindingError ? `platform_binding_error=${body.platformBindingError}` : '',
    body.coordinationNote ?? '',
    '',
    body.npmCiOutputTail ? `--- npm ci (tail) ---\n${body.npmCiOutputTail}` : '',
    body.npmCiStdout ? `--- npm ci stdout ---\n${body.npmCiStdout}` : '',
    body.npmCiStderr ? `--- npm ci stderr ---\n${body.npmCiStderr}` : '',
    body.esmError ? `--- esm isolation error ---\n${body.esmError}` : '',
    `--- esm isolation stdout ---\n${body.esmStdout ?? ''}`,
    `--- esm isolation stderr ---\n${body.esmStderr ?? ''}`,
    body.probeError ? `--- probe error ---\n${body.probeError}` : '',
    `--- probe stdout ---\n${body.probeStdout ?? ''}`,
    `--- probe stderr ---\n${body.probeStderr ?? ''}`,
  ]
    .filter(Boolean)
    .join('\n')
  writeFileSync(path, text)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
