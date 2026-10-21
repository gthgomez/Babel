#!/usr/bin/env node
/**
 * Exact @napi-rs/canvas platform prebuild artifacts allowed to bypass personal-path
 * scans in Windows packaging. Bytes verified from public npm @0.1.80 registry tarballs.
 */
import { createHash } from 'node:crypto'
import { CANVAS_PACKAGE_VERSION } from './research-v2-canvas-platform-binding.mjs'

/** @type {readonly { packageName: string, version: string, relativePath: string, sha256: string, provenance: string }[]} */
export const CANVAS_VENDOR_NATIVE_ALLOWLIST = [
  {
    packageName: '@napi-rs/canvas-linux-x64-gnu',
    version: CANVAS_PACKAGE_VERSION,
    relativePath: '@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node',
    sha256: '7607cda801e86bee96d88b685766e7d22b707128de25134147f68192304220c5',
    provenance: 'https://registry.npmjs.org/@napi-rs/canvas-linux-x64-gnu/-/canvas-linux-x64-gnu-0.1.80.tgz',
  },
  {
    packageName: '@napi-rs/canvas-win32-x64-msvc',
    version: CANVAS_PACKAGE_VERSION,
    relativePath: '@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
    sha256: '30646342fc284109aa9542155287d37147c97132d5168cf621f851a9c69e0c99',
    provenance: 'https://registry.npmjs.org/@napi-rs/canvas-win32-x64-msvc/-/canvas-win32-x64-msvc-0.1.80.tgz',
  },
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {string} relPath archive-relative path (forward or backslashes)
 * @param {Buffer} fileBytes
 */
export function isAllowlistedCanvasVendorNativeArtifact(relPath, fileBytes) {
  const normalized = relPath.replaceAll('\\', '/')
  for (const entry of CANVAS_VENDOR_NATIVE_ALLOWLIST) {
    if (!normalized.endsWith(entry.relativePath)) continue
    return sha256(fileBytes) === entry.sha256
  }
  return false
}
