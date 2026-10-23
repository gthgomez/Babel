#!/usr/bin/env node
/**
 * @napi-rs/canvas publishes native bindings as separate optional packages.
 * `npm ci --omit=dev --omit=optional` (Windows runtime pack) installs the JS
 * wrapper but not the platform .node — install the matching binding explicitly.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const CANVAS_PACKAGE_VERSION = '0.1.80'

/** @returns {string | null} npm package name for this host, if supported */
export function resolveCanvasPlatformBindingPackage(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return '@napi-rs/canvas-linux-x64-gnu'
  if (platform === 'linux' && arch === 'arm64') return '@napi-rs/canvas-linux-arm64-gnu'
  if (platform === 'win32' && arch === 'x64') return '@napi-rs/canvas-win32-x64-msvc'
  if (platform === 'darwin' && arch === 'arm64') return '@napi-rs/canvas-darwin-arm64'
  if (platform === 'darwin' && arch === 'x64') return '@napi-rs/canvas-darwin-x64'
  return null
}

export function resolveInstalledModulePaths(cwd) {
  const require = createRequire(join(cwd, 'package.json'))
  const paths = {
    canvas_package_json: require.resolve('@napi-rs/canvas/package.json'),
    pdfjs_entry: require.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
  }
  const bindingPkg = resolveCanvasPlatformBindingPackage()
  if (bindingPkg) {
    try {
      paths.canvas_platform_binding_package_json = require.resolve(`${bindingPkg}/package.json`)
    } catch {
      paths.canvas_platform_binding_package_json = null
    }
  }
  return paths
}

export function canvasNativeBindingLoads(cwd) {
  const prior = process.cwd()
  try {
    process.chdir(cwd)
    return import('@napi-rs/canvas').then(() => true).catch(() => false)
  } finally {
    process.chdir(prior)
  }
}

export function resolveCanvasNativeBindingFile(cwd) {
  const bindingPkg = resolveCanvasPlatformBindingPackage()
  if (!bindingPkg) return null
  const pkgRoot = join(cwd, 'node_modules', ...bindingPkg.split('/'))
  const candidates = [
    join(pkgRoot, 'skia.linux-x64-gnu.node'),
    join(pkgRoot, 'skia.linux-arm64-gnu.node'),
    join(pkgRoot, 'skia.win32-x64-msvc.node'),
    join(pkgRoot, 'skia.darwin-x64.node'),
    join(pkgRoot, 'skia.darwin-arm64.node'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Fail closed when platform binding package or import is missing after staged npm ci. */
export async function assertCanvasNativeBindingLoads(cwd) {
  const bindingPkg = resolveCanvasPlatformBindingPackage()
  if (!bindingPkg) {
    throw new Error(`no canvas platform binding for ${process.platform}/${process.arch}`)
  }
  const nativePath = resolveCanvasNativeBindingFile(cwd)
  if (!nativePath) {
    throw new Error(
      `${bindingPkg} native .node missing under ${cwd}; run installCanvasPlatformBinding after npm ci --omit=optional`,
    )
  }
  const loads = await canvasNativeBindingLoads(cwd)
  if (!loads) {
    throw new Error(`@napi-rs/canvas import failed in ${cwd} despite ${nativePath}`)
  }
  return { bindingPkg, nativePath }
}

/**
 * Install platform binding into an existing node_modules tree (no package.json mutation).
 * @param {{ cwd: string, npmCli?: string, nodeExec?: string }} options
 */
export function installCanvasPlatformBinding(options) {
  const bindingPkg = resolveCanvasPlatformBindingPackage()
  if (!bindingPkg) {
    throw new Error(
      `no @napi-rs/canvas platform binding mapping for ${process.platform}/${process.arch}`,
    )
  }
  const nodeExec = options.nodeExec ?? process.execPath
  const npmCli =
    options.npmCli ??
    process.env.npm_execpath ??
    (() => {
      throw new Error('npm_cli required when npm_execpath is unset')
    })()
  if (!existsSync(join(options.cwd, 'node_modules', '@napi-rs', 'canvas'))) {
    throw new Error('@napi-rs/canvas must be installed before platform binding')
  }
  execFileSync(
    nodeExec,
    [npmCli, 'install', `${bindingPkg}@${CANVAS_PACKAGE_VERSION}`, '--omit=dev', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: options.cwd, stdio: 'inherit', windowsHide: true },
  )
  return bindingPkg
}
