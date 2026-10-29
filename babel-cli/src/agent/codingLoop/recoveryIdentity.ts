import { isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalizeContained } from '../../bridge/workspaceBound.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { RevisionManager } from '../../evidence/revisionBoundReceipt.js'
import { fileURLToPath } from 'node:url'

/** Resolve through the existing path-containment primitive before reduction. */
export function recoveryTargetIdentity(projectRoot: string, target: string): string | null {
  if (!target.trim() || target.includes('\0')) return null
  try {
    // safe_repo's fixed /app mount names the same contained candidate tree.
    // Reject traversal before URL parsing can normalize it away.
    const decoded = decodeURIComponent(target)
    if (decoded.split(/[\\/]/).includes('..')) return null
    if (decoded.startsWith('file:///app/')) target = decoded.slice('file:///app/'.length)
    else if (decoded.startsWith('/app/')) target = decoded.slice('/app/'.length)
    else if (target.startsWith('file:')) target = fileURLToPath(target)
    const root = canonicalizeContained(projectRoot)
    const absolute = canonicalizeContained(isAbsolute(target) ? target : resolve(root, target))
    const within = relative(root, absolute)
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return null
    return within.split(sep).join('/')
  } catch {
    return null
  }
}

/** Bind the indexed tree plus the live content of every dirty and untracked path. */
export function recoveryWorkspaceRevision(projectRoot: string): string | null {
  try {
    const gitPaths = (args: string[]): string[] => execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
    }).split('\0').filter(Boolean)
    const capture = RevisionManager.computeRevisionSync(projectRoot, [], {
      scope_kind: 'repository', git_binding: 'optional',
      require_physical_capture: true,
    })
    // A null HEAD is valid in a newly initialized repository only after the
    // revision manager has proven a stable physical tree. Never accept its
    // random unverified fallback as candidate identity.
    if (!Object.hasOwn(capture.fileHashes, '<repository>')) return null
    const indexed = capture.compositeTreeHash
    const paths = [...new Set([
      ...gitPaths(['diff', '--name-only', '--no-ext-diff', '-z']),
      ...gitPaths(['ls-files', '-o', '--exclude-standard', '-z']),
    ])].sort()
    if (paths.some((path) => recoveryTargetIdentity(projectRoot, path) === null)) return null
    const live = paths.length > 0
      ? RevisionManager.computeRevisionSync(projectRoot, paths).compositeTreeHash
      : ''
    // Preserve commit binding when it exists; content-only Git identity is
    // limited to repositories whose unborn tree was physically captured.
    return createHash('sha256').update(JSON.stringify([capture.gitCommitHash, indexed, live])).digest('hex')
  } catch {
    return null
  }
}
