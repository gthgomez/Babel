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

  const diff = runGit(cwd, ['diff', '--no-color', '--', '.']);
  return {
    available: true,
    files,
    diff: diff.ok ? diff.stdout : status.stdout,
    ...(diff.ok ? {} : { reason: 'git diff unavailable; showing status only' }),
  };
}
