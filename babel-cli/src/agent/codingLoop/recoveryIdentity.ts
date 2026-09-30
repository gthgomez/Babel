import { isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalizeContained } from '../../bridge/workspaceBound.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { RevisionManager } from '../../evidence/revisionBoundReceipt.js'

/** Resolve through the existing path-containment primitive before reduction. */
export function recoveryTargetIdentity(projectRoot: string, target: string): string | null {
  if (!target.trim() || target.includes('\0')) return null
  try {
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
    const indexed = RevisionManager.computeRevisionSync(projectRoot, [], {
      scope_kind: 'repository', git_binding: 'optional',
    }).compositeTreeHash
    const paths = [...new Set([
      ...gitPaths(['diff', '--name-only', '--no-ext-diff', '-z']),
      ...gitPaths(['ls-files', '-o', '--exclude-standard', '-z']),
    ])].sort()
    if (paths.some((path) => recoveryTargetIdentity(projectRoot, path) === null)) return null
    const live = paths.length > 0
      ? RevisionManager.computeRevisionSync(projectRoot, paths).compositeTreeHash
      : ''
    return createHash('sha256').update(JSON.stringify([indexed, live])).digest('hex')
  } catch {
    return null
  }
}
