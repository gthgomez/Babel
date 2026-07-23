/**
 * gitInfo.ts — Lightweight git metadata cache for the status bar.
 *
 * Runs `git` commands with a short TTL cache so the status bar can show
 * branch name and dirty-state without blocking the REPL loop on every turn.
 *
 * The first call in a TTL window runs synchronously (execSync, typically
 * < 50ms on local SSD). Subsequent calls within the window reuse the cached
 * result. On slow filesystems (NFS, WSL bind mounts, antivirus), the
 * initial call may block for up to the 2s timeout — the 5s TTL cache
 * amortizes this across ~20-100 REPL turns. If git is unavailable, the
 * call gracefully returns null branch with no error.
 *
 * Usage:
 *   import { getGitInfo } from './gitInfo.js';
 *   const { branch, dirty } = getGitInfo();
 */

import { execSync } from 'node:child_process';

const CACHE_TTL_MS = 5000;

export interface GitInfo {
  /** Current branch name, or null if not in a git repo. */
  branch: string | null;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean;
}

let cachedInfo: GitInfo | null = null;
let cacheTimestamp = 0;

function runGit(args: string[]): string | null {
  try {
    return execSync(`git ${args.join(' ')}`, {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get git branch and dirty state, cached for 5 seconds.
 *
 * Safe to call from the REPL loop — subsequent calls within the TTL window
 * return the cached result instantly.
 */
export function getGitInfo(): GitInfo {
  const now = Date.now();
  if (cachedInfo && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedInfo;
  }

  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = runGit(['status', '--porcelain']);
  const dirty = status !== null && status.length > 0;

  cachedInfo = { branch, dirty };
  cacheTimestamp = now;
  return cachedInfo;
}

/** Clear the git info cache. Useful for testing. */
export function clearGitCache(): void {
  cachedInfo = null;
  cacheTimestamp = 0;
}
