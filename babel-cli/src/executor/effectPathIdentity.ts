import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface EffectParentIdentity { canonicalPath: string; device: string; inode: string; relativeParent?: string[] }

/** Capture the admitted parent before an effect, not from a later replacement. */
export function captureEffectParentIdentity(path: string): EffectParentIdentity {
  let ancestor = resolve(dirname(path))
  const relativeParent: string[] = []
  let canonicalPath: string
  while (true) {
    try { canonicalPath = realpathSync(ancestor); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
      relativeParent.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
  const stat = lstatSync(canonicalPath, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('EFFECT_PARENT_IDENTITY_UNAVAILABLE')
  return { canonicalPath, device: String(stat.dev), inode: String(stat.ino), relativeParent }
}

/** Reuse the originally admitted canonical parent; reject ancestor redirection. */
export function resolveOwnedEffectPath(path: string, expected: EffectParentIdentity): string {
  const stat = lstatSync(expected.canonicalPath, { bigint: true })
  const parent = join(expected.canonicalPath, ...(expected.relativeParent ?? []))
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(expected.canonicalPath) !== expected.canonicalPath
    || realpathSync(dirname(path)) !== parent || String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode) {
    throw new Error('EFFECT_PARENT_IDENTITY_CHANGED')
  }
  return join(parent, basename(path))
}

/** Exact host identity of an attested file, captured without Number rounding. */
export interface EffectFileIdentity { device: string; inode: string }

/**
 * Capture the exact device/inode strings the host attested for a file.
 *
 * Windows stat packs the NTFS MFT reference (record | sequence<<48) into a
 * double for the Number APIs, so `statSync().ino.toString()` is rounded above
 * 2^53 while the durable evidence compares exact BigInt strings. Always mint
 * ownership identity from the BigInt API, and reject unattestable entries.
 *
 * @param path - Existing regular file to attest.
 * @returns Device and inode as exact decimal strings.
 */
export function captureEffectFileIdentity(path: string): EffectFileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.ino <= 0n) {
    throw new Error('EFFECT_FILE_IDENTITY_UNAVAILABLE')
  }
  return { device: String(stat.dev), inode: String(stat.ino) }
}
