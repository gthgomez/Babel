import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { documentAdmissionCrlfHints, sha256Hex } from '../../../access/missionDocumentAcquisitionPolicy.js'
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
      actualByteLength: number
      message: string
    }
  | {
      status: 'unsupported_platform'
      message: string
      missing_constants: ('O_NOFOLLOW' | 'O_NONBLOCK')[]
      platform_qualification: 'requires_linux_open_nofollow_nonblock'
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

export type CacheFileOpenPlatformSupport =
  | {
      supported: true
      flags: number
      platform_qualification: 'linux_open_nofollow_nonblock'
    }
  | {
      supported: false
      status: 'unsupported_platform'
      message: string
      missing_constants: ('O_NOFOLLOW' | 'O_NONBLOCK')[]
      platform_qualification: 'requires_linux_open_nofollow_nonblock'
    }

/** Fail closed when symlink-safe open flags are unavailable (no silent `?? 0` fallback). */
export function resolveCacheFileOpenFlags(): CacheFileOpenPlatformSupport {
  const missing: ('O_NOFOLLOW' | 'O_NONBLOCK')[] = []
  if (typeof constants.O_NOFOLLOW !== 'number') {
    missing.push('O_NOFOLLOW')
  }
  if (typeof constants.O_NONBLOCK !== 'number') {
    missing.push('O_NONBLOCK')
  }
  if (missing.length > 0) {
    return {
      supported: false,
      status: 'unsupported_platform',
      message:
        `campaign paper cache requires fs.constants ${missing.join(' and ')} for bounded regular-file reads without following symlinks; this platform does not expose them`,
      missing_constants: missing,
      platform_qualification: 'requires_linux_open_nofollow_nonblock',
    }
  }
  return {
    supported: true,
    flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    platform_qualification: 'linux_open_nofollow_nonblock',
  }
}

type BoundedReadResult =
  | { ok: true; bytes: Buffer }
  | {
      ok: false
      status: 'not_regular_file' | 'size_mismatch' | 'read_failed' | 'unsupported_platform'
      message: string
      actualByteLength?: number
      missing_constants?: ('O_NOFOLLOW' | 'O_NONBLOCK')[]
    }

export interface ArxivPaperCacheReadOptions {
  cacheRoot?: string
  /** Defaults to {@link resolveCacheFileOpenFlags}; inject in tests for capability matrix coverage. */
  resolveOpenFlags?: () => CacheFileOpenPlatformSupport
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
  options?: Pick<ArxivPaperCacheReadOptions, 'resolveOpenFlags'>,
): BoundedReadResult {
  const openFlags = (options?.resolveOpenFlags ?? resolveCacheFileOpenFlags)()
  if (!openFlags.supported) {
    return {
      ok: false,
      status: 'unsupported_platform',
      message: openFlags.message,
      missing_constants: openFlags.missing_constants,
    }
  }
  let fd: number | undefined
  try {
    fd = openSync(resolvedPath, openFlags.flags)
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
  options?: ArxivPaperCacheReadOptions,
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

  const read = readBoundedRegularFileAtPath(expectedPath, manifest.byte_length, options)
  if (!read.ok) {
    if (read.status === 'unsupported_platform') {
      return {
        status: 'unsupported_platform',
        message: read.message,
        missing_constants: read.missing_constants ?? [],
        platform_qualification: 'requires_linux_open_nofollow_nonblock',
      }
    }
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

  const actualSha256 = sha256Hex(read.bytes)
  if (actualSha256 !== manifest.content_sha256) {
    const hints = documentAdmissionCrlfHints(
      read.bytes,
      manifest.content_sha256,
      manifest.byte_length,
    )
    const hintSuffix = hints.length > 0 ? ` (${hints.join('; ')})` : ''
    return {
      status: 'digest_mismatch',
      resolvedPath: expectedPath,
      manifestSha256: manifest.content_sha256,
      actualSha256,
      actualByteLength: read.bytes.length,
      message:
        `cached paper digest does not match manifest ` +
        `(actual=${actualSha256}, expected=${manifest.content_sha256}, byte_length=${read.bytes.length})` +
        hintSuffix,
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
export function resolveArxiv170603762PaperBytesFromExternalCache(
  options?: ArxivPaperCacheReadOptions,
): ArxivPaperCacheResolveResult {
  return resolveManifestedPaperBytesFromExternalCache(arxivManifest, options)
}
