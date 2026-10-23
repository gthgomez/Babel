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
