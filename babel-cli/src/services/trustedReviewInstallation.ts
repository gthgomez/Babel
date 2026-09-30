import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/** Source identity for a controller installed from the PR's trusted base. */
export function assertTrustedReviewInstallation(installationRoot: string, baseSha?: string): string {
  if (baseSha !== undefined && !/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error('INVALID_REVIEW_BASE_SHA')
  const root = realpathSync(installationRoot)
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim()
  // Git status intentionally ignores paths marked assume-unchanged or skip-worktree.
  // Those index flags cannot be accepted as proof of an unchanged installation.
  const tracked = git(['ls-files', '-v', '-z']).split('\0').filter(Boolean)
  if (tracked.some((entry) => !entry.startsWith('H '))) throw new Error('TRUSTED_REVIEW_INDEX_FLAGS_UNSAFE')
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('TRUSTED_REVIEW_INSTALLATION_DIRTY')
  const sourceSha = git(['rev-parse', '--verify', 'HEAD'])
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('TRUSTED_REVIEW_SOURCE_INVALID')
  if (baseSha !== undefined && sourceSha.toLowerCase() !== baseSha.toLowerCase()) {
    try { git(['merge-base', '--is-ancestor', sourceSha, baseSha]) }
    catch { throw new Error('REVIEW_CONTROLLER_NOT_IN_TRUSTED_BASE') }
    throw new Error('REVIEW_CONTROLLER_NOT_EXACT_TRUSTED_BASE')
  }
  return sourceSha
}

/** Check the actual loaded controller file, not a path named by the candidate. */
export function assertTrustedReviewCodePath(
  installationRoot: string, baseSha: string, executingCodePath: string, expectedRelativePath: string,
): string {
  if (!expectedRelativePath || isAbsolute(expectedRelativePath) || expectedRelativePath.includes('\\') ||
      expectedRelativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('UNSAFE_TRUSTED_CONTROLLER_CODE_PATH')
  }
  const sourceSha = assertTrustedReviewInstallation(installationRoot, baseSha)
  const root = realpathSync(installationRoot)
  const code = realpathSync(executingCodePath)
  const actualRelativePath = relative(root, code).replaceAll('\\', '/')
  if (actualRelativePath !== expectedRelativePath) throw new Error('REVIEW_CONTROLLER_CODE_NOT_BASE_ROOTED')
  const committed = execFileSync('git', ['-C', root, 'show', `${sourceSha}:${expectedRelativePath}`], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  })
  const loaded = readFileSync(code, 'utf8')
  // Git records LF while Windows may check out CRLF for clean tracked text.
  const normalize = (value: string): string => value.replaceAll('\r\n', '\n')
  if (normalize(loaded) !== normalize(committed)) throw new Error('REVIEW_CONTROLLER_CODE_DIFFERS_FROM_BASE')
  return sourceSha
}
