/**
 * File-change / diff summary from existing Git workspace truth.
 * Not a second mutation engine — read-only git status/diff.
 */

import { spawnSync } from 'node:child_process';

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

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (result.error || result.status !== 0) {
    return { ok: false, stdout, stderr: stderr || result.error?.message || 'git failed' };
  }
  return { ok: true, stdout, stderr };
}

export function collectWorkspaceChanges(cwd: string): WorkspaceChangeSnapshot {
  const status = runGit(cwd, ['status', '--porcelain']);
  if (!status.ok) {
    return {
      available: false,
      files: [],
      diff: '',
      reason: status.stderr || 'git status unavailable',
    };
  }
  const files: WorkspaceFileChange[] = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => ({
      status: line.slice(0, 2).trim() || 'M',
      path: line.slice(3).trim(),
    }))
    .filter((file) => file.path.length > 0);

  // The file list comes from porcelain (tracked modifications, staged work and
  // untracked paths). The diff must cover the same truth: `git diff` alone only
  // shows unstaged tracked edits, which lets a remote advertise changes while
  // returning an empty diff (RT-09).
  const parts: string[] = [];
  const reasons: string[] = [];
  const unstaged = runGit(cwd, ['diff', '--no-color', '--', '.']);
  if (unstaged.ok && unstaged.stdout.trim()) parts.push(unstaged.stdout.trim());
  else if (!unstaged.ok) reasons.push('unstaged diff unavailable');
  const staged = runGit(cwd, ['diff', '--cached', '--no-color', '--', '.']);
  if (staged.ok && staged.stdout.trim()) parts.push(staged.stdout.trim());
  else if (!staged.ok) reasons.push('staged diff unavailable');

  const untracked = runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.ok) {
    for (const path of untracked.stdout.split('\0').filter(Boolean)) {
      const fileDiff = runGit(cwd, [
        'diff',
        '--no-index',
        '--no-color',
        '--',
        '/dev/null',
        path,
      ]);
      // `--no-index` exits 1 when the files differ; that is a successful diff.
      if ((fileDiff.ok || fileDiff.stdout.trim()) && fileDiff.stdout.trim()) {
        parts.push(`# Untracked file: ${JSON.stringify(path)}\n${fileDiff.stdout.trim()}`);
      } else if (!fileDiff.ok && !fileDiff.stdout.trim()) {
        reasons.push(`untracked diff unavailable for ${path}`);
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
}
