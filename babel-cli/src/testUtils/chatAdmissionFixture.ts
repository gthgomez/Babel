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

const ADMISSION_ENV_KEYS = ['BABEL_RUNS_DIR', 'BABEL_CHAT_MAX_COST'] as const

/** Snapshot chat admission env vars for restoration after a test file or suite. */
export function snapshotChatAdmissionEnv(): { restore(): void } {
  const prior = Object.fromEntries(
    ADMISSION_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof ADMISSION_ENV_KEYS)[number], string | undefined>
  return {
    restore() {
      for (const key of ADMISSION_ENV_KEYS) {
        const value = prior[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}
