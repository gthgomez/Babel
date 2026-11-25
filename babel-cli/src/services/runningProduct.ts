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

interface RecordedBuildInputs {
  scope: 'cli-manifest-lock-config-and-tsc-files:v1'
  sha256: string
  packageLockSha256: string
}

interface BuildInfo {
  schemaVersion: 1
  packageVersion: string
  sourceCommit: string | null
  sourceTree: string | null
  workingTreeClean: boolean | null
  buildInputsDigest: null
  buildInputsReason: 'complete build inputs were not recorded'
  recordedBuildInputs?: RecordedBuildInputs | null
  nodeVersion: string
  typescriptVersion: string | null
}

function readBuildManifest(root: string): Buffer | null {
  const path = join(root, 'dist', 'cli', 'build-info.json')
  try {
    const expected = lstatSync(path, { bigint: true })
    if (!expected.isFile() || expected.nlink !== 1n || expected.size > 16n * 1024n) return null
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const actual = fstatSync(fd, { bigint: true })
      if (!actual.isFile() || actual.nlink !== 1n || actual.dev !== expected.dev ||
          actual.ino !== expected.ino || actual.size !== expected.size) return null
      const bytes = Buffer.alloc(Number(actual.size) + 1)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null)
        if (count === 0) break
        offset += count
      }
      return offset === Number(actual.size) ? bytes.subarray(0, offset) : null
    } finally { closeSync(fd) }
  } catch { return null }
}

function parseBuildInfo(bytes: Buffer, packageVersion: string): BuildInfo | null {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const { sourceCommit, sourceTree, workingTreeClean, nodeVersion, typescriptVersion, recordedBuildInputs } = data
  const objectId = (input: unknown): input is string | null =>
    input === null || (typeof input === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input))
  const version = (input: unknown): input is string =>
    typeof input === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(input)
  if (data['schemaVersion'] !== 1 || data['packageVersion'] !== packageVersion ||
      !objectId(sourceCommit) || !objectId(sourceTree) ||
      (sourceCommit !== null && sourceTree !== null && sourceCommit.length !== sourceTree.length) ||
      !(workingTreeClean === null || typeof workingTreeClean === 'boolean') ||
      (workingTreeClean === true && (sourceCommit === null || sourceTree === null)) ||
      data['buildInputsDigest'] !== null || data['buildInputsReason'] !== 'complete build inputs were not recorded' ||
      !version(nodeVersion) || !(typescriptVersion === null || version(typescriptVersion))) return null

  let inputs: RecordedBuildInputs | null = null
  if (recordedBuildInputs !== undefined && recordedBuildInputs !== null) {
    if (typeof recordedBuildInputs !== 'object' || Array.isArray(recordedBuildInputs)) return null
    const { scope, sha256, packageLockSha256 } = recordedBuildInputs as Record<string, unknown>
    const digest = (input: unknown): input is string => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input)
    if (scope !== 'cli-manifest-lock-config-and-tsc-files:v1' || !digest(sha256) || !digest(packageLockSha256)) return null
    inputs = { scope, sha256, packageLockSha256 }
  }
  return {
    schemaVersion: 1, packageVersion, sourceCommit, sourceTree, workingTreeClean,
    buildInputsDigest: null, buildInputsReason: 'complete build inputs were not recorded',
    ...(recordedBuildInputs === undefined ? {} : { recordedBuildInputs: inputs }),
    nodeVersion, typescriptVersion,
  }
}

function buildFingerprint(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
}

export interface RunningProduct {
  packageRoot: string
  entrypoint: string | null
  executable: string
  runningVersion: string | null
  revision: null
  packageFingerprint: string | null
  entryFingerprint: string | null
  /** Captured self-report. Archive and installed-byte verification belongs to the external receipt. */
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
  const buildManifest = readBuildManifest(root)
  return { packageRoot: root, entrypoint: entry, executable: process.execPath,
    runningVersion: version, revision: null, packageFingerprint: fingerprint(packageFile), entryFingerprint: fingerprint(entry),
    buildInfo: buildManifest !== null && version !== null ? parseBuildInfo(buildManifest, version) : null,
    buildManifestFingerprint: buildFingerprint(buildManifest) }
}

export function inspectRunningProduct(running: RunningProduct) {
  const packageNow = fingerprint(join(running.packageRoot, 'package.json'))
  const entryNow = fingerprint(running.entrypoint)
  const buildBefore = running.buildManifestFingerprint ?? null
  const buildNow = buildBefore === null ? null : buildFingerprint(readBuildManifest(running.packageRoot))
  const changed = (running.packageFingerprint !== null && packageNow !== null && running.packageFingerprint !== packageNow) ||
    (running.entryFingerprint !== null && entryNow !== null && running.entryFingerprint !== entryNow) ||
    (buildBefore !== null && buildNow !== null && buildBefore !== buildNow)
  const complete = running.packageFingerprint !== null && packageNow !== null && running.entryFingerprint !== null && entryNow !== null &&
    (buildBefore === null || buildNow !== null)
  return { ...running, restartNeeded: changed ? true : complete ? false : null }
}

/** Snapshot once while this process loads, before a later installation can replace files. */
export const runningProduct = captureRunningProduct(resolveRuntimePaths().packageRoot, process.argv[1] ?? null)
