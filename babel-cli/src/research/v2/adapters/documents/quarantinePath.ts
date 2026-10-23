import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * True when `candidate` resolves under `root` (platform-aware; rejects cross-drive on Windows).
 */
/** Windows-only containment (exported for path.win32 regressions on any host). */
export function isPathWithinQuarantineRootWin32(rootResolved: string, candidateResolved: string): boolean {
  const rootParsed = path.win32.parse(rootResolved)
  const candParsed = path.win32.parse(candidateResolved)
  if (rootParsed.root.toLowerCase() !== candParsed.root.toLowerCase()) {
    return false
  }
  const rel = path.win32.relative(rootResolved, candidateResolved)
  if (rel === '') return true
  if (path.win32.isAbsolute(rel)) return false
  return !rel.split(path.win32.sep).includes('..')
}

export function isPathWithinQuarantineRoot(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root)
  const candidateResolved = path.resolve(candidate)
  if (process.platform === 'win32') {
    return isPathWithinQuarantineRootWin32(rootResolved, candidateResolved)
  }
  const rel = path.relative(rootResolved, candidateResolved)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return !rel.split(path.sep).includes('..')
}

/**
 * Resolve a manifest-relative path under a fixed fixture root (quarantine).
 */
export function resolveQuarantinedFixturePath(fixtureRoot: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`quarantine: rejected absolute path ${relativePath}`)
  }
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`quarantine: rejected relative path ${relativePath}`)
  }
  const rootReal = realpathSync(path.resolve(fixtureRoot))
  const candidate = path.resolve(rootReal, normalized)
  let candidateReal: string
  try {
    candidateReal = realpathSync(candidate)
  } catch {
    throw new Error(`quarantine: missing fixture path ${relativePath}`)
  }
  if (!isPathWithinQuarantineRoot(rootReal, candidateReal)) {
    throw new Error(`quarantine: path escapes fixture root: ${relativePath}`)
  }
  return candidateReal
}
