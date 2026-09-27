import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

/** Source identity for a controller installed from the PR's trusted base. */
export function assertTrustedReviewInstallation(installationRoot: string, baseSha?: string): string {
  if (baseSha !== undefined && !/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error('INVALID_REVIEW_BASE_SHA')
  const root = realpathSync(installationRoot)
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  }).trim()
  // Git status intentionally ignores paths marked assume-unchanged or skip-worktree.
  // Those index flags cannot be accepted as proof of an unchanged installation.
  const tracked = git(['ls-files', '-v', '-z']).split('\0').filter(Boolean)
  if (tracked.some((entry) => !entry.startsWith('H '))) throw new Error('TRUSTED_REVIEW_INDEX_FLAGS_UNSAFE')
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('TRUSTED_REVIEW_INSTALLATION_DIRTY')
  const sourceSha = git(['rev-parse', '--verify', 'HEAD'])
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('TRUSTED_REVIEW_SOURCE_INVALID')
  if (baseSha !== undefined) {
    try { git(['merge-base', '--is-ancestor', sourceSha, baseSha]) }
    catch { throw new Error('REVIEW_CONTROLLER_NOT_IN_TRUSTED_BASE') }
  }
  return sourceSha
}
