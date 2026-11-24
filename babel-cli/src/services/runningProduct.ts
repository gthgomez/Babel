/** Process-start product identity. Never infer executing code from the current Git HEAD. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
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

export interface BuildInfo {
  schemaVersion: 1
  packageVersion: string
  sourceCommit: string | null
  sourceTree: string | null
  workingTreeClean: boolean | null
  buildInputsDigest: null
  buildInputsReason: 'complete build inputs were not recorded'
  recordedBuildInputs?: {
    scope: 'cli-manifest-lock-config-and-tsc-files:v1'
    sha256: string
    packageLockSha256: string
  } | null
  nodeVersion: string
  typescriptVersion: string | null
}

function readBuildManifest(path: string, version: string | null): { info: BuildInfo | null; hash: string | null } {
  try {
    const expected = lstatSync(path, { bigint: true })
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n || expected.size > 16n * 1024n) return { info: null, hash: null }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    let bytes: Buffer
    try {
      const actual = fstatSync(fd, { bigint: true })
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino ||
          actual.nlink !== 1n || actual.size !== expected.size) return { info: null, hash: null }
      const buffer = Buffer.alloc(Number(actual.size) + 1)
      let offset = 0
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, null)
        if (!count) break
        offset += count
      }
      if (offset !== Number(actual.size)) return { info: null, hash: null }
      bytes = buffer.subarray(0, offset)
    } finally { closeSync(fd) }
    const hash = createHash('sha256').update(bytes).digest('hex')
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { return { info: null, hash } }
    if (!value || typeof value !== 'object') return { info: null, hash }
    const data = value as Record<string, unknown>
    const recorded = data['recordedBuildInputs']
    const recordedInfo = recorded && typeof recorded === 'object' ? recorded as Record<string, unknown> : null
    const digest = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
    const recordedBuildInputs = recordedInfo?.['scope'] === 'cli-manifest-lock-config-and-tsc-files:v1' &&
      digest(recordedInfo['sha256']) && digest(recordedInfo['packageLockSha256'])
      ? { scope: recordedInfo['scope'], sha256: recordedInfo['sha256'], packageLockSha256: recordedInfo['packageLockSha256'] } as const
      : null
    const objectId = (id: unknown): id is string | null => id === null ||
      (typeof id === 'string' && /^[a-f0-9]{40,64}$/.test(id))
    if (data['schemaVersion'] !== 1 || version === null || data['packageVersion'] !== version ||
        !objectId(data['sourceCommit']) || !objectId(data['sourceTree']) ||
        !(data['workingTreeClean'] === null || typeof data['workingTreeClean'] === 'boolean') ||
        (data['workingTreeClean'] === true && data['sourceCommit'] === null) ||
        data['buildInputsDigest'] !== null || data['buildInputsReason'] !== 'complete build inputs were not recorded' ||
        (recorded !== undefined && recorded !== null && recordedBuildInputs === null) ||
        typeof data['nodeVersion'] !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/.test(data['nodeVersion']) ||
        !(data['typescriptVersion'] === null || (typeof data['typescriptVersion'] === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(data['typescriptVersion'])))) {
      return { info: null, hash }
    }
    return { info: {
      schemaVersion: 1, packageVersion: version,
      sourceCommit: data['sourceCommit'] as string | null, sourceTree: data['sourceTree'] as string | null,
      workingTreeClean: data['workingTreeClean'] as boolean | null,
      buildInputsDigest: null, buildInputsReason: 'complete build inputs were not recorded',
      ...(recorded === undefined ? {} : { recordedBuildInputs }),
      nodeVersion: data['nodeVersion'], typescriptVersion: data['typescriptVersion'] as string | null,
    }, hash }
  } catch { return { info: null, hash: null } }
}

export interface RunningProduct {
  packageRoot: string
  entrypoint: string | null
  executable: string
  runningVersion: string | null
  revision: null
  packageFingerprint: string | null
  entryFingerprint: string | null
  /** Self-reported metadata only; an external receipt is required for provenance. */
  buildInfo?: BuildInfo | null
  buildManifestFingerprint?: string | null
}

export function captureRunningProduct(packageRoot: string, entrypoint: string | null): RunningProduct {
  const root = resolve(packageRoot); const packageFile = join(root, 'package.json')
  let version: string | null = null
  try {
    const data: unknown = JSON.parse(readFileSync(packageFile, 'utf8'))
    if (data && typeof data === 'object' && 'version' in data && typeof data.version === 'string') version = data.version
  } catch { /* Missing provenance remains unknown. */ }
  const entry = entrypoint ? resolve(entrypoint) : null
  const build = readBuildManifest(join(root, 'dist', 'cli', 'build-info.json'), version)
  return { packageRoot: root, entrypoint: entry, executable: process.execPath,
    runningVersion: version, revision: null, packageFingerprint: fingerprint(packageFile), entryFingerprint: fingerprint(entry),
    buildInfo: build.info, buildManifestFingerprint: build.hash }
}

export function inspectRunningProduct(running: RunningProduct) {
  const packageNow = fingerprint(join(running.packageRoot, 'package.json'))
  const entryNow = fingerprint(running.entrypoint)
  const buildNow = readBuildManifest(join(running.packageRoot, 'dist', 'cli', 'build-info.json'), running.runningVersion).hash
  const buildBefore = running.buildManifestFingerprint ?? null
  const changed = (running.packageFingerprint !== null && packageNow !== null && running.packageFingerprint !== packageNow) ||
    (running.entryFingerprint !== null && entryNow !== null && running.entryFingerprint !== entryNow) ||
    (buildBefore !== null && buildNow !== null && buildBefore !== buildNow)
  const complete = running.packageFingerprint !== null && packageNow !== null && running.entryFingerprint !== null && entryNow !== null &&
    (buildBefore === null || buildNow !== null)
  return { ...running, restartNeeded: changed ? true : complete ? false : null }
}

/** Snapshot once while this process loads, before a later installation can replace files. */
export const runningProduct = captureRunningProduct(resolveRuntimePaths().packageRoot, process.argv[1] ?? null)
