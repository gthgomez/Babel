import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimal git repo so P11 workspace capture can authorize provider dispatch. */
export function initMinimalGitProject(root: string): void {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'babel-test@example.com'])
  git(['config', 'user.name', 'Babel Test'])
  git(['commit', '-q', '--allow-empty', '-m', 'fixture'])
}

/** Evidence directory that must not overlap the selected project root. */
export function mkExternalRunsDir(prefix = 'babel-test-runs-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}
