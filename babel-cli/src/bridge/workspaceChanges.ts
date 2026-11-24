/**
 * File-change / diff summary from existing Git workspace truth.
 * Not a second mutation engine — read-only git status/diff.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WorkspaceFileChange {
  path: string;
  status: string;
}

export interface WorkspaceChangeSnapshot {
  available: boolean;
  files: WorkspaceFileChange[];
  diff: string;
  reason?: string;
}

const MAX_FILES = 200;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_TOTAL_TIME_MS = 15_000;

export function buildReadOnlyGitEnvironment(
  source: NodeJS.ProcessEnv,
  globalConfig: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'TMPDIR',
  ]);
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toUpperCase();
    if (value !== undefined && (allowed.has(normalized) || normalized === 'LANG' || normalized.startsWith('LC_'))) {
      env[name] = value;
    }
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

export function buildReadOnlyGitArgs(args: string[]): string[] {
  return [
    '--no-pager',
    '-c', 'core.fsmonitor=false',
    '-c', 'diff.external=',
    '-c', 'core.pager=cat',
    '-c', 'pager.diff=false',
    ...args,
  ];
}

function runGit(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deadline: number,
  acceptedExitCodes: number[] = [],
): { ok: boolean; status: number | null; stdout: string; stderr: string } {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { ok: false, status: null, stdout: '', stderr: 'Git inspection timed out' };
  const result = spawnSync(
    'git',
    buildReadOnlyGitArgs(args),
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: remaining,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (result.error || (result.status !== 0 && !acceptedExitCodes.includes(result.status ?? Number.NaN))) {
    return {
      ok: false,
      status: result.status,
      stdout,
      stderr: stderr || result.error?.message || 'git failed',
    };
  }
  return { ok: true, status: 0, stdout, stderr };
}

function unavailable(reason: string): WorkspaceChangeSnapshot {
  return { available: false, files: [], diff: '', reason };
}

export function collectWorkspaceChanges(
  cwd: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): WorkspaceChangeSnapshot {
  const tempRoot = mkdtempSync(join(tmpdir(), 'babel-safe-git-'));
  const deadline = Date.now() + MAX_TOTAL_TIME_MS;
  try {
    const globalConfig = join(tempRoot, 'empty.gitconfig');
    writeFileSync(globalConfig, '');
    const env = buildReadOnlyGitEnvironment(options.env ?? process.env, globalConfig);
    const filters = runGit(
      cwd,
      ['config', '--local', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|smudge)$'],
      env,
      deadline,
      [1],
    );
    if (!filters.ok) return unavailable('repository filter configuration could not be inspected');
    if (filters.stdout.trim()) return unavailable('repository filter configuration is unsupported');
    const status = runGit(cwd, ['status', '--porcelain'], env, deadline);
    if (!status.ok) return unavailable(status.stderr || 'git status unavailable');

    const files: WorkspaceFileChange[] = status.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .map((line) => ({
        status: line.slice(0, 2).trim() || 'M',
        path: line.slice(3).trim(),
      }))
      .filter((file) => file.path.length > 0);
    if (files.length > MAX_FILES) return unavailable('workspace file limit exceeded');

    const parts: string[] = [];
    const reasons: string[] = [];
    let totalDiffBytes = 0;
    const appendDiff = (diff: string): boolean => {
      const addition = Buffer.byteLength(diff, 'utf8') + (parts.length > 0 ? 2 : 0);
      if (totalDiffBytes + addition > MAX_OUTPUT_BYTES) return false;
      parts.push(diff);
      totalDiffBytes += addition;
      return true;
    };
    const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-color'];
    const unstaged = runGit(cwd, ['diff', ...diffArgs, '--', '.'], env, deadline);
    if (unstaged.ok && unstaged.stdout.trim()) {
      if (!appendDiff(unstaged.stdout.trim())) return unavailable('workspace diff output limit exceeded');
    } else if (!unstaged.ok) {
      reasons.push('unstaged diff unavailable');
    }
    const staged = runGit(cwd, ['diff', '--cached', ...diffArgs, '--', '.'], env, deadline);
    if (staged.ok && staged.stdout.trim()) {
      if (!appendDiff(staged.stdout.trim())) return unavailable('workspace diff output limit exceeded');
    } else if (!staged.ok) {
      reasons.push('staged diff unavailable');
    }

    const untracked = runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env, deadline);
    if (untracked.ok) {
      for (const path of untracked.stdout.split('\0').filter(Boolean)) {
        const fileDiff = runGit(
          cwd,
          ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', path],
          env,
          deadline,
          [1],
        );
        if (fileDiff.ok && fileDiff.stdout.trim()) {
          if (!appendDiff(`# Untracked file: ${JSON.stringify(path)}\n${fileDiff.stdout.trim()}`)) {
            return unavailable('workspace diff output limit exceeded');
          }
        } else if (!fileDiff.ok) {
          return unavailable(fileDiff.stderr || 'untracked diff unavailable');
        }
      }
    } else {
      reasons.push('untracked file listing unavailable');
    }

    const reason =
      reasons.length > 0
        ? `${reasons.join('; ')}; showing the diff that is available`
        : undefined;
    return {
      available: true,
      files,
      diff: parts.join('\n\n'),
      ...(reason !== undefined ? { reason } : {}),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
