import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hardenGitHostEnvironment } from '../authority/unprivilegedChildEnv.js';

const FIXTURE_GIT_CONFIG_OVERRIDES = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.autocrlf=false',
  '-c', 'commit.gpgsign=false',
] as const;

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface GitCommandBytesResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export function getGitCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['BABEL_GIT_PATH']?.trim();
  if (configured) {
    return configured;
  }

  if (process.platform !== 'win32') {
    return 'git';
  }

  for (const root of [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'Programs') : undefined,
    'C:\\Program Files',
  ]) {
    if (!root) {
      continue;
    }
    const candidate = join(root, 'Git', 'cmd', 'git.exe');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'git';
}

export function buildGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  const pathValue = next['PATH'] ?? next['Path'];
  if (pathValue) {
    next['PATH'] = pathValue;
    next['Path'] = pathValue;
  }
  return hardenGitHostEnvironment(next);
}

export function runGitCommand(
  args: string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): GitCommandResult {
  const result = runGitCommandBytes(args, cwd, options);
  return {
    status: result.status,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}

/** Preserve raw Git pathname bytes for callers that must validate UTF-8 identity. */
export function runGitCommandBytes(
  args: string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
  } = {},
): GitCommandBytesResult {
  const env = buildGitEnv(options.env);
  const result = spawnSync(getGitCommand(env), args, {
    cwd,
    env,
    timeout: options.timeoutMs ?? 15_000,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    windowsHide: true,
  });
  return {
    // A spawn error (including maxBuffer overflow) means the process result is incomplete.
    status: result.error ? null : result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr?.length ? result.stderr : result.error
      ? Buffer.from(`Git process error: ${(result.error as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`)
      : Buffer.alloc(0),
  };
}

/**
 * Async version of runGitCommand. Uses non-blocking spawn so multiple calls
 * can be run in parallel without blocking the event loop.
 */
export function runGitCommandAsync(
  args: string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const env = buildGitEnv(options.env);
    const cmd = getGitCommand(env);
    const proc = spawn(cmd, args, {
      cwd,
      env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timeout = options.timeoutMs ?? 15_000;

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout,
        stderr: timedOut ? `Timeout after ${timeout}ms` : stderr,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: null,
        stdout: '',
        stderr: err.message,
      });
    });
  });
}

function decodeFixtureGitStdout(output: Buffer): string | null {
  return isUtf8(output) ? output.toString('utf8') : null;
}

/** Isolated env for disposable fixture roots only; not used by runGitCommandBytes. */
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
  };
}

function spawnFixtureGit(
  root: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number; encoding: 'utf8' | 'buffer' },
): { status: number | null; stdout: string | Buffer; stderr: string | Buffer } {
  const env = benchmarkGitObserveEnv();
  const result = spawnSync(getGitCommand(env), [
    ...FIXTURE_GIT_CONFIG_OVERRIDES,
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
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? (options.encoding === 'buffer' ? Buffer.alloc(0) : ''),
    stderr: result.stderr ?? (options.encoding === 'buffer' ? Buffer.alloc(0) : ''),
  };
}

/** Fixture-only UTF-8 observer; hardened porcelain uses runBenchmarkGitCommandBytes. */
export function runBenchmarkGitObserve(
  root: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnFixtureGit(root, args, { ...options, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/** Fixture-only byte-accurate Git output (GIT_OPTIONAL_LOCKS=0, explicit git-dir/work-tree). */
export function runBenchmarkGitCommandBytes(
  root: string,
  args: string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): GitCommandBytesResult {
  const result = spawnFixtureGit(root, args, { ...options, encoding: 'buffer' });
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
  };
}

export function observeBenchmarkWorkingTreeDirty(projectRoot: string): boolean {
  return benchmarkPorcelainRecords(projectRoot).length > 0;
}

export function benchmarkPorcelainRecords(projectRoot: string): string[] {
  const status = runBenchmarkGitCommandBytes(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.status !== 0) return [];
  const decoded = decodeFixtureGitStdout(status.stdout);
  if (decoded === null) return [];
  const records = decoded.split('\0');
  if (records.pop() !== '') return [];
  return records.filter(record =>
    record.length >= 4
    && record[2] === ' '
    && (() => {
      const path = record.slice(3);
      return path !== '.babel' && !path.startsWith('.babel/');
    })());
}
