#!/usr/bin/env node
/**
 * Explicit packaging integration: stage a production npm ci tree (Windows package flags),
 * copy built dist + probe + fixture inside the stage, run reciprocal PDF probe with no
 * host node_modules fallback. Writes a receipt path via --receipt= or stdout.
 *
 * Not part of default unit-test shards (may use network for npm ci).
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function canvasInstallEvidence(stageRoot) {
  const canvasPkg = join(stageRoot, 'node_modules', '@napi-rs', 'canvas', 'package.json')
  const pdfjsPkg = join(stageRoot, 'node_modules', 'pdfjs-dist', 'package.json')
  return {
    canvasPackageJsonPresent: existsSync(canvasPkg),
    pdfjsPackageJsonPresent: existsSync(pdfjsPkg),
    canvasVersion: existsSync(canvasPkg)
      ? JSON.parse(readFileSync(canvasPkg, 'utf8')).version
      : null,
  }
}

function main() {
  const keepStage = process.argv.includes('--keep-stage')
  const receiptPath = parseArg('receipt') ?? join(repoRoot, 'review-artifacts/integration-406-production-package-reciprocal-run.txt')

  execFileSync('npm', ['run', 'build'], {
    cwd: babelCliRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 300_000,
  })

  const stageRoot = resolve(parseArg('stage') ?? mkdtempSync(join(tmpdir(), 'babel-prod-reciprocal-stage-')))
  const reciprocalDir = join(stageRoot, 'reciprocal')
  const fixtureDir = join(reciprocalDir, 'fixtures')
  const runtimeDist = join(stageRoot, 'runtime', 'dist')

  mkdirSync(fixtureDir, { recursive: true })
  mkdirSync(dirname(runtimeDist), { recursive: true })

  cpSync(join(babelCliRoot, 'package.json'), join(stageRoot, 'package.json'))
  cpSync(join(babelCliRoot, 'package-lock.json'), join(stageRoot, 'package-lock.json'))
  cpSync(join(babelCliRoot, 'dist'), runtimeDist, { recursive: true })
  cpSync(
    join(babelCliRoot, 'src/research/v2/adapters/documents/fixtures/two-page-sample.pdf'),
    join(fixtureDir, 'two-page-sample.pdf'),
  )
  cpSync(
    join(babelCliRoot, 'scripts/research-v2-production-package-reciprocal-probe.mjs'),
    join(reciprocalDir, 'probe.mjs'),
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

  const canvas = canvasInstallEvidence(stageRoot)
  const env = {
    ...process.env,
    BABEL_STAGED_ROOT: stageRoot,
    // Explicitly strip host resolution hacks.
    NODE_PATH: '',
  }
  delete env.NODE_PATH

  let probeStdout = ''
  let probeStderr = ''
  let probeExit = 0
  let probeError = ''
  try {
    probeStdout = execFileSync(process.execPath, [join(reciprocalDir, 'probe.mjs')], {
      cwd: stageRoot,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
    })
  } catch (error) {
    probeExit = 1
    const err = error
    probeStdout = err.stdout ?? ''
    probeStderr = err.stderr ?? ''
    probeError = err.message ?? String(err)
    if (typeof err.status === 'number') probeExit = err.status
  }

  const outcome =
    probeExit === 0 && probeStdout.includes('research-v2-production-package-reciprocal-probe: ok')
      ? 'probe_ok'
      : 'probe_failed'

  writeReceipt(receiptPath, {
    stageRoot,
    outcome,
    productionNpmCiArgs: PRODUCTION_NPM_CI_ARGS.join(' '),
    npmCiOutputTail: npmCiOutput.split('\n').slice(-8).join('\n'),
    canvas,
    probeExit,
    probeStdout,
    probeStderr,
    probeError,
    coordinationNote:
      'Authoritative @napi-rs/canvas direct dependency is Agent A #406 package repair (in progress at f00db4c5); B does not edit package.json.',
  })

  if (!keepStage) rmSync(stageRoot, { recursive: true, force: true })

  if (outcome !== 'probe_ok') {
    console.error(`production-package reciprocal: ${outcome} (receipt: ${receiptPath})`)
    process.exit(probeExit || 1)
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
    `canvas_package_json_present=${body.canvas?.canvasPackageJsonPresent}`,
    `pdfjs_package_json_present=${body.canvas?.pdfjsPackageJsonPresent}`,
    `canvas_version=${body.canvas?.canvasVersion ?? 'null'}`,
    body.coordinationNote ?? '',
    '',
    body.npmCiOutputTail ? `--- npm ci (tail) ---\n${body.npmCiOutputTail}` : '',
    body.npmCiStdout ? `--- npm ci stdout ---\n${body.npmCiStdout}` : '',
    body.npmCiStderr ? `--- npm ci stderr ---\n${body.npmCiStderr}` : '',
    body.probeError ? `--- probe error ---\n${body.probeError}` : '',
    `--- probe stdout ---\n${body.probeStdout ?? ''}`,
    `--- probe stderr ---\n${body.probeStderr ?? ''}`,
  ]
    .filter(Boolean)
    .join('\n')
  writeFileSync(path, text)
}

main()
