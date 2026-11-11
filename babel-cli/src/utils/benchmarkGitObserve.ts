/** Non-mutating, hardened Git observation for benchmark/calibration fixture repos. */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { getGitCommand } from './gitExec.js'

const CONFIG_OVERRIDES = [
  ['-c', 'core.hooksPath=/dev/null'],
  ['-c', 'core.fsmonitor=false'],
  ['-c', 'core.attributesFile=/dev/null'],
  ['-c', 'core.autocrlf=false'],
  ['-c', 'commit.gpgsign=false'],
] as const

export function benchmarkGitObserveEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: base['PATH'],
    SystemRoot: base['SystemRoot'],
    TEMP: base['TEMP'],
    TMP: base['TMP'],
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  }
}

/** Hardened Git with explicit fixture git-dir/work-tree; avoids index stat refresh from porcelain status. */
export function runBenchmarkGitObserve(
  root: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string } {
  const env = benchmarkGitObserveEnv()
  const result = spawnSync(getGitCommand(env), [
    ...CONFIG_OVERRIDES.flat(),
    '--git-dir', join(root, '.git'),
    '--work-tree', root,
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10_000,
    env,
    windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Read-only dirty-tree observation: diff-index + untracked listing never refresh index stat cache. */
export function observeBenchmarkWorkingTreeDirty(projectRoot: string): boolean {
  return describeBenchmarkPorcelain(projectRoot).length > 0
}

/** Porcelain-shaped lines without invoking `git status` (which refreshes index stat cache). */
export function describeBenchmarkPorcelain(projectRoot: string): string[] {
  if (runBenchmarkGitObserve(projectRoot, ['rev-parse', 'HEAD']).status !== 0) return []
  const lines: string[] = []
  const diff = runBenchmarkGitObserve(projectRoot, ['diff-index', 'HEAD', '-z', '--name-status'])
  if (diff.status !== 0) return []
  const parts = diff.stdout.split('\0').filter(part => part.length > 0)
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index] ?? ''
    const path = parts[index + 1] ?? ''
    if (!path || path === '.babel' || path.startsWith('.babel/')) continue
  // diff-index emits XY path; map to porcelain prefix (first column staged, second worktree)
    const staged = status[0] === ' ' ? ' ' : status[0] ?? ' '
    const worktree = status[1] === ' ' ? ' ' : status[1] ?? ' '
    lines.push(`${staged}${worktree} ${path}`)
  }
  const untracked = runBenchmarkGitObserve(projectRoot, ['ls-files', '-o', '-z', '--exclude-standard'])
  if (untracked.status !== 0) return lines
  for (const path of untracked.stdout.split('\0')) {
    if (!path || path === '.babel' || path.startsWith('.babel/')) continue
    lines.push(`?? ${path}`)
  }
  return lines.sort()
}
