#!/usr/bin/env node
/**
 * Packaged-runtime proof: isolated node_modules from lockfile only (no NODE_PATH / dist).
 * Matches babel-desktop Windows pack: npm ci --omit=dev --omit=optional --ignore-scripts
 * plus explicit @napi-rs/canvas platform binding install.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CANVAS_PACKAGE_VERSION,
  installCanvasPlatformBinding,
  resolveCanvasPlatformBindingPackage,
  resolveInstalledModulePaths,
} from './research-v2-canvas-platform-binding.mjs'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function stagedEnv() {
  const env = { ...process.env }
  delete env.NODE_PATH
  return env
}

function probeCanvasImportInTree(cwd) {
  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import('@napi-rs/canvas').then(() => process.exit(0)).catch(() => process.exit(2))",
      ],
      { cwd, env: stagedEnv(), stdio: 'ignore', windowsHide: true },
    )
    return true
  } catch (err) {
    const code = err && typeof err === 'object' && 'status' in err ? err.status : 1
    return code === 0
  }
}
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'run via npm so npm_execpath is set')

const stagedRoot = mkdtempSync(join(tmpdir(), 'babel-research-v2-staged-cli-'))
const evidence = {
  schema: 'research-v2-pdfjs-staged-package-smoke/v1',
  staged_root: stagedRoot,
  npm_ci_args: ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
  canvas_package_version: CANVAS_PACKAGE_VERSION,
  platform_binding_package: resolveCanvasPlatformBindingPackage(),
  module_paths_before_binding: null,
  module_paths_after_binding: null,
  native_binding_loaded_before: false,
  native_binding_loaded_after: false,
  pdf_text_extracted: false,
  node_path_not_used: !process.env.NODE_PATH,
}

try {
  cpSync(join(cliRoot, 'package.json'), join(stagedRoot, 'package.json'))
  cpSync(join(cliRoot, 'package-lock.json'), join(stagedRoot, 'package-lock.json'))

  execFileSync(process.execPath, [npmCli, ...evidence.npm_ci_args], {
    cwd: stagedRoot,
    stdio: 'inherit',
    windowsHide: true,
  })

  evidence.module_paths_before_binding = resolveInstalledModulePaths(stagedRoot)
  evidence.native_binding_loaded_before = probeCanvasImportInTree(stagedRoot)
  assert.equal(evidence.native_binding_loaded_before, false, 'omit=optional must not load native canvas alone')

  const installedBinding = installCanvasPlatformBinding({
    cwd: stagedRoot,
    npmCli,
    nodeExec: process.execPath,
  })
  assert.equal(installedBinding, evidence.platform_binding_package)

  evidence.module_paths_after_binding = resolveInstalledModulePaths(stagedRoot)
  evidence.native_binding_loaded_after = probeCanvasImportInTree(stagedRoot)
  assert.equal(evidence.native_binding_loaded_after, true, 'platform binding must load canvas native module')

  const fixture = join(
    cliRoot,
    'src/research/v2/adapters/documents/fixtures/two-page-sample.pdf',
  )
  const extractCode = `
    import { readFileSync } from 'node:fs';
    await import('@napi-rs/canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(readFileSync(${JSON.stringify(fixture)}));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    const page = await doc.getPage(1);
    const text = await page.getTextContent();
    const joined = text.items.map((item) => item.str).join(' ');
    if (!/Page/i.test(joined)) process.exit(3);
    await doc.destroy();
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', extractCode], {
    cwd: stagedRoot,
    env: stagedEnv(),
    stdio: 'inherit',
    windowsHide: true,
  })
  evidence.pdf_text_extracted = true

  console.log(JSON.stringify(evidence, null, 2))
  console.log('research-v2-pdfjs-staged-package-smoke: ok')
} finally {
  rmSync(stagedRoot, { recursive: true, force: true })
}
