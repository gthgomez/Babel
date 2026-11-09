import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

export interface VerifierInputPathFs {
  exists: (path: string) => boolean
  isFile?: (path: string) => boolean
  realpath?: (path: string) => string | null
}

const defaultFs: VerifierInputPathFs = {
  exists: existsSync,
  isFile: path => {
    try { return statSync(path).isFile() } catch { return false }
  },
  realpath: path => {
    try { return realpathSync.native(path) } catch { return null }
  },
}

function safeProjectRelativePath(projectRoot: string, absolutePath: string): string | null {
  const path = relative(projectRoot, absolutePath).replace(/\\/g, '/')
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) return null
  return path
}

/** Resolve exact verifier inputs to lexical and canonical in-root paths. */
export function resolveExistingVerifierInputPaths(
  projectRoot: string,
  inputs: readonly string[],
  fs: VerifierInputPathFs = defaultFs,
): string[] {
  const files = new Set<string>()
  for (const token of inputs) {
    const lexical = token.replace(/\\/g, '/')
    if (lexical.startsWith('../') || /^[A-Za-z]:|^\//.test(lexical) || /(^|\/)\.\.(\/|$)/.test(lexical)) continue
    const absolute = join(projectRoot, lexical)
    if (!fs.exists(absolute) || (fs.isFile && !fs.isFile(absolute))) continue
    const canonicalAbsolute = fs.realpath ? fs.realpath(absolute) : absolute
    if (!canonicalAbsolute) continue
    const canonical = safeProjectRelativePath(projectRoot, canonicalAbsolute)
    // An out-of-root symlink is never admitted as an independently verifiable input.
    if (!canonical) continue
    files.add(lexical)
    files.add(canonical)
  }
  return [...files].sort()
}
