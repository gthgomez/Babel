import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import arxivManifest from './1706.03762.manifest.json' with { type: 'json' }

export interface ArxivPaperManifestRef {
  artifact_path: string
  content_sha256: string
  byte_length: number
}

export type ArxivPaperCacheResolveResult =
  | {
      status: 'ok'
      bytes: Buffer
      resolvedPath: string
      contentSha256: string
    }
  | {
      status: 'missing'
      expectedPath: string
      manifestSha256: string
      manifestByteLength: number
    }
  | {
      status: 'not_regular_file'
      resolvedPath: string
      message: string
    }
  | {
      status: 'size_mismatch'
      resolvedPath: string
      manifestByteLength: number
      actualByteLength: number
      message: string
    }
  | {
      status: 'read_failed'
      resolvedPath: string
      message: string
    }
  | {
      status: 'digest_mismatch'
      resolvedPath: string
      manifestSha256: string
      actualSha256: string
    }

function defaultCacheRoot(): string {
  const override = process.env.BABEL_RESEARCH_V2_CAMPAIGN_PAPER_CACHE?.trim()
  if (override) {
    return override
  }
  return join(homedir(), '.cache', 'babel', 'research-v2', 'campaign', 'papers')
}

function resolveArtifactPath(cacheRoot: string, artifactPath: string): string {
  return join(cacheRoot, artifactPath)
}

const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0)

type BoundedReadResult =
  | { ok: true; bytes: Buffer }
  | {
      ok: false
      status: 'not_regular_file' | 'size_mismatch' | 'read_failed'
      message: string
      actualByteLength?: number
    }

export function assertRegularFileSizeStableAfterRead(
  fd: number,
  expectedByteLength: number,
): BoundedReadResult {
  try {
    const after = fstatSync(fd)
    if (!after.isFile()) {
      return {
        ok: false,
        status: 'not_regular_file',
        message: 'cache entry changed to a non-regular file during read',
      }
    }
    if (after.size !== expectedByteLength) {
      return {
        ok: false,
        status: 'size_mismatch',
        message: 'cache file size changed during bounded read',
        actualByteLength: after.size,
      }
    }
    return { ok: true, bytes: Buffer.alloc(0) }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 'read_failed', message }
  }
}

/**
 * Open without following symlinks; stat before read; reject growth before and after read.
 */
export function readBoundedRegularFileAtPath(
  resolvedPath: string,
  expectedByteLength: number,
): BoundedReadResult {
  let fd: number | undefined
  try {
    fd = openSync(resolvedPath, OPEN_FLAGS)
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      return {
        ok: false,
        status: 'not_regular_file',
        message: 'cache entry is not a regular file',
      }
    }
    const size = stat.size
    if (size > expectedByteLength) {
      return {
        ok: false,
        status: 'size_mismatch',
        message: 'cache file exceeds manifest byte_length (possible growth)',
        actualByteLength: size,
      }
    }
    if (size !== expectedByteLength) {
      return {
        ok: false,
        status: 'size_mismatch',
        message: 'cache file size does not match manifest byte_length',
        actualByteLength: size,
      }
    }
    const bytes = Buffer.alloc(expectedByteLength)
    const bytesRead = readSync(fd, bytes, 0, expectedByteLength, 0)
    if (bytesRead !== expectedByteLength) {
      return {
        ok: false,
        status: 'read_failed',
        message: `expected ${expectedByteLength} bytes, read ${bytesRead}`,
      }
    }
    const stable = assertRegularFileSizeStableAfterRead(fd, expectedByteLength)
    if (!stable.ok) {
      return stable
    }
    return { ok: true, bytes }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const notRegular =
      message.includes('ENOTSUP') ||
      message.includes('EOPNOTSUPP') ||
      message.includes('EINVAL') ||
      message.includes('ELOOP')
    return {
      ok: false,
      status: notRegular ? 'not_regular_file' : 'read_failed',
      message,
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

export function resolveManifestedPaperBytesFromExternalCache(
  manifest: ArxivPaperManifestRef,
  options?: { cacheRoot?: string },
): ArxivPaperCacheResolveResult {
  const cacheRoot = options?.cacheRoot ?? defaultCacheRoot()
  const expectedPath = resolveArtifactPath(cacheRoot, manifest.artifact_path)
  if (!existsSync(expectedPath)) {
    return {
      status: 'missing',
      expectedPath,
      manifestSha256: manifest.content_sha256,
      manifestByteLength: manifest.byte_length,
    }
  }

  const read = readBoundedRegularFileAtPath(expectedPath, manifest.byte_length)
  if (!read.ok) {
    if (read.status === 'not_regular_file') {
      return {
        status: 'not_regular_file',
        resolvedPath: expectedPath,
        message: read.message,
      }
    }
    if (read.status === 'size_mismatch') {
      return {
        status: 'size_mismatch',
        resolvedPath: expectedPath,
        manifestByteLength: manifest.byte_length,
        actualByteLength: read.actualByteLength ?? -1,
        message: read.message,
      }
    }
    return {
      status: 'read_failed',
      resolvedPath: expectedPath,
      message: read.message,
    }
  }

  const actualSha256 = createHash('sha256').update(read.bytes).digest('hex')
  if (actualSha256 !== manifest.content_sha256) {
    return {
      status: 'digest_mismatch',
      resolvedPath: expectedPath,
      manifestSha256: manifest.content_sha256,
      actualSha256,
    }
  }
  return {
    status: 'ok',
    bytes: read.bytes,
    resolvedPath: expectedPath,
    contentSha256: actualSha256,
  }
}

/** Opt-in: arXiv full-paper bytes are not tracked in Git; verify with BABEL_RESEARCH_V2_VERIFY_ARXIV_PAPER_CACHE=1. */
export function resolveArxiv170603762PaperBytesFromExternalCache(options?: {
  cacheRoot?: string
}): ArxivPaperCacheResolveResult {
  return resolveManifestedPaperBytesFromExternalCache(arxivManifest, options)
}
