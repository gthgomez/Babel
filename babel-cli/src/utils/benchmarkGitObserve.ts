/** Non-mutating, hardened Git observation for benchmark/calibration fixture repos. */
import { isUtf8 } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { getGitCommand } from './gitExec.js'

function decodeGitStdout(output: Buffer): string | null {
  return isUtf8(output) ? output.toString('utf8') : null
}

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

function spawnBenchmarkGit(
  root: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number; encoding: 'utf8' | 'buffer' },
): { status: number | null; stdout: string | Buffer; stderr: string | Buffer } {
  const env = benchmarkGitObserveEnv()
  const result = spawnSync(getGitCommand(env), [
    ...CONFIG_OVERRIDES.flat(),
    '--git-dir', join(root, '.git'),
    '--work-tree', root,
    ...args,
  ], {
    cwd: root,
    encoding: options.encoding,
    timeout: options.timeoutMs ?? 10_000,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    env,
    windowsHide: true,
  })
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? (options.encoding === 'buffer' ? Buffer.alloc(0) : ''),
    stderr: result.stderr ?? (options.encoding === 'buffer' ? Buffer.alloc(0) : ''),
  }
}

/** UTF-8 text observer for non-porcelain benchmark queries. */
export function runBenchmarkGitObserve(
  root: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnBenchmarkGit(root, args, { ...options, encoding: 'utf8' })
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  }
}

/** Byte-accurate porcelain and pathname output; never decodes before validation. */
export function runBenchmarkGitCommandBytes(
  root: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): { status: number | null; stdout: Buffer; stderr: Buffer } {
  const result = spawnBenchmarkGit(root, args, { ...options, encoding: 'buffer' })
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
  }
}

/** Read-only dirty-tree observation via byte-accurate porcelain (GIT_OPTIONAL_LOCKS=0). */
export function observeBenchmarkWorkingTreeDirty(projectRoot: string): boolean {
  return benchmarkPorcelainRecords(projectRoot).length > 0
}

/** NUL-delimited porcelain v1 records from hardened `git status`; empty when clean. */
export function benchmarkPorcelainRecords(projectRoot: string): string[] {
  const status = runBenchmarkGitCommandBytes(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.status !== 0) return []
  const decoded = decodeGitStdout(status.stdout)
  if (decoded === null) return []
  const records = decoded.split('\0')
  if (records.pop() !== '') return []
  return records.filter(record =>
    record.length >= 4
    && record[2] === ' '
    && (() => {
      const path = record.slice(3)
      return path !== '.babel' && !path.startsWith('.babel/')
    })())
}
