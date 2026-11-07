/** Process-start product identity. Never infer executing code from the current Git HEAD. */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveRuntimePaths } from '../config/runtimePaths.js'

function fingerprint(path: string | null): string | null {
  if (!path) return null
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > 10 * 1024 * 1024) return null
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch { return null }
}

export interface RunningProduct {
  packageRoot: string
  entrypoint: string | null
  executable: string
  runningVersion: string | null
  revision: null
  packageFingerprint: string | null
  entryFingerprint: string | null
}

export function captureRunningProduct(packageRoot: string, entrypoint: string | null): RunningProduct {
  const root = resolve(packageRoot); const packageFile = join(root, 'package.json')
  let version: string | null = null
  try {
    const data: unknown = JSON.parse(readFileSync(packageFile, 'utf8'))
    if (data && typeof data === 'object' && 'version' in data && typeof data.version === 'string') version = data.version
  } catch { /* Missing provenance remains unknown. */ }
  const entry = entrypoint ? resolve(entrypoint) : null
  return { packageRoot: root, entrypoint: entry, executable: process.execPath,
    runningVersion: version, revision: null, packageFingerprint: fingerprint(packageFile), entryFingerprint: fingerprint(entry) }
}

export function inspectRunningProduct(running: RunningProduct) {
  const packageNow = fingerprint(join(running.packageRoot, 'package.json'))
  const entryNow = fingerprint(running.entrypoint)
  const changed = (running.packageFingerprint !== null && packageNow !== null && running.packageFingerprint !== packageNow) ||
    (running.entryFingerprint !== null && entryNow !== null && running.entryFingerprint !== entryNow)
  const complete = running.packageFingerprint !== null && packageNow !== null && running.entryFingerprint !== null && entryNow !== null
  return { ...running, restartNeeded: changed ? true : complete ? false : null }
}

/** Snapshot once while this process loads, before a later installation can replace files. */
export const runningProduct = captureRunningProduct(resolveRuntimePaths().packageRoot, process.argv[1] ?? null)
