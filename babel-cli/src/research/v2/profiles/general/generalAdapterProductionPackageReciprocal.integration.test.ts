import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const babelCliRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const pdfFixture = join(
  babelCliRoot,
  'src/research/v2/adapters/documents/fixtures/two-page-sample.pdf',
)
const probeScript = join(babelCliRoot, 'scripts/research-v2-production-package-reciprocal-probe.mjs')

/** Matches babel-desktop/scripts/package-windows.mjs production npm ci flags. */
const PRODUCTION_NPM_CI_ARGS = [
  'ci',
  '--omit=dev',
  '--omit=optional',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
]

function runProductionPackageReciprocalProbe(): { stdout: string; stderr: string } {
  execFileSync('npm', ['run', 'build'], {
    cwd: babelCliRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 300_000,
  })

  const installRoot = mkdtempSync(join(tmpdir(), 'babel-prod-package-reciprocal-'))
  cpSync(join(babelCliRoot, 'package.json'), join(installRoot, 'package.json'))
  cpSync(join(babelCliRoot, 'package-lock.json'), join(installRoot, 'package-lock.json'))
  execFileSync('npm', PRODUCTION_NPM_CI_ARGS, {
    cwd: installRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 300_000,
  })

  const env = {
    ...process.env,
    NODE_PATH: join(installRoot, 'node_modules'),
    BABEL_CLI_DIST: join(babelCliRoot, 'dist'),
    BABEL_PDF_FIXTURE: pdfFixture,
  }

  try {
    const stdout = execFileSync(process.execPath, [probeScript], {
      cwd: installRoot,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
    })
    return { stdout, stderr: '' }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const stdout = err.stdout ?? ''
    const stderr = err.stderr ?? ''
    const message = err.message ?? String(error)
    throw new Error(
      [
        'production-package reciprocal probe failed (real pdfjs, no mocked parser)',
        message,
        stdout ? `--- stdout ---\n${stdout}` : '',
        stderr ? `--- stderr ---\n${stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

describe('general adapter production package reciprocal (Windows-packaged npm flags)', () => {
  it('documents DOMMatrix failure when @napi-rs/canvas is omitted with --omit=optional', () => {
    const installRoot = mkdtempSync(join(tmpdir(), 'babel-prod-deps-negative-'))
    cpSync(join(babelCliRoot, 'package.json'), join(installRoot, 'package.json'))
    cpSync(join(babelCliRoot, 'package-lock.json'), join(installRoot, 'package-lock.json'))
    const pkg = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    delete pkg.dependencies?.['@napi-rs/canvas']
    writeFileSync(join(installRoot, 'package.json'), JSON.stringify(pkg, null, 2))

    execFileSync('npm', PRODUCTION_NPM_CI_ARGS, {
      cwd: installRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 300_000,
    })

    let threw = false
    let combined = ''
    try {
      execFileSync(
        process.execPath,
        [
          '-e',
          "import('pdfjs-dist/legacy/build/pdf.mjs').then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })",
        ],
        {
          cwd: installRoot,
          encoding: 'utf8',
          env: { ...process.env, NODE_PATH: join(installRoot, 'node_modules') },
          stdio: 'pipe',
          timeout: 60_000,
        },
      )
    } catch (error) {
      threw = true
      const err = error as { stdout?: string; stderr?: string }
      combined = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
    }
    assert.ok(threw, 'pdfjs legacy import must fail without direct @napi-rs/canvas under --omit=optional')
    assert.match(
      combined,
      /DOMMatrix is not defined|Cannot find module '@napi-rs\/canvas'/,
      `expected Windows-packaging failure signature, got:\n${combined}`,
    )
  })

  it('two-page PDF extraction + PdfExtractionCancelled cleanup under production npm ci flags', () => {
    const { stdout } = runProductionPackageReciprocalProbe()
    assert.match(stdout, /research-v2-production-package-reciprocal-probe: ok/)
  })
})
