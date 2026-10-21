import { realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Resolve a manifest-relative path under a fixed fixture root (quarantine).
 * Rejects traversal outside the root after normalization.
 */
export function resolveQuarantinedFixturePath(fixtureRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`quarantine: rejected relative path ${relativePath}`)
  }
  const rootReal = realpathSync(resolve(fixtureRoot))
  const candidate = resolve(rootReal, normalized)
  let candidateReal: string
  try {
    candidateReal = realpathSync(candidate)
  } catch {
    throw new Error(`quarantine: missing fixture path ${relativePath}`)
  }
  const rel = relative(rootReal, candidateReal)
  if (rel.startsWith('..') || rel.includes(`..${'/'}`)) {
    throw new Error(`quarantine: path escapes fixture root: ${relativePath}`)
  }
  return candidateReal
}
