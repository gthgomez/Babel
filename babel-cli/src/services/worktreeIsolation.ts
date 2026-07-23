/**
 * worktreeIsolation.ts — Git worktree isolation for safe parallel work
 *
 * Provides general-purpose git worktree create/enter/exit/list commands
 * for isolating Babel runs from the main working tree. Reuses the
 * prepareGitWorktree pattern from dogfoodSandbox.ts and agentTeams.ts.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// BABEL_WORKTREE_ROOT env var is the primary integration point;
// no other constants needed from cli/constants.js

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
  detached: boolean;
  active: boolean;
}

export interface WorktreeCreateOptions {
  /** Project root to branch from. Default: process.cwd() */
  projectRoot?: string;
  /** Branch name for the worktree. Default: auto-generated babel-worktree-<name> */
  branch?: string;
  /** Git ref to base the worktree on. Default: HEAD */
  baseRef?: string;
  /** Detach HEAD (no branch). Default: false */
  detach?: boolean;
}

const WORKTREE_PREFIX = 'babel-worktree-';

function resolveProjectRoot(options?: WorktreeCreateOptions): string {
  return options?.projectRoot ?? process.cwd();
}

// ─── Worktree operations ───────────────────────────────────────────────────

export function createWorktree(name: string, options?: WorktreeCreateOptions): WorktreeInfo {
  const projectRoot = resolveProjectRoot(options);
  const workspaceRoot = join(projectRoot, '.babel', 'worktrees', name);
  const branch = options?.branch ?? `${WORKTREE_PREFIX}${name}`;
  const baseRef = options?.baseRef ?? 'HEAD';
  const detach = options?.detach ?? false;

  mkdirSync(dirname(workspaceRoot), { recursive: true });
  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }

  const args = ['worktree', 'add'];
  if (detach) {
    args.push('--detach');
  }
  if (!detach) {
    // Create a new branch for this worktree (options BEFORE path)
    args.push('-b', branch);
  }

  args.push(workspaceRoot);
  args.push(baseRef);

  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    const errMsg = (result.stderr || result.stdout || '').trim();
    throw new Error(`git worktree add failed: ${errMsg}`);
  }

  return {
    name,
    path: workspaceRoot,
    branch: detach ? 'detached' : branch,
    detached: detach,
    active: true,
  };
}

/**
 * Enter a worktree by setting BABEL_WORKTREE_ROOT.
 *
 * CAUTION: BABEL_WORKTREE_ROOT is a process-level environment variable.
 * It does NOT persist across shell invocations or child processes that
 * are spawned without inheriting the environment. Each new shell or
 * subprocess must be explicitly passed the current environment to see
 * this value.
 */
export function enterWorktree(name: string, projectRoot?: string): void {
  const root = projectRoot ?? process.cwd();
  const workspaceRoot = join(root, '.babel', 'worktrees', name);
  if (!existsSync(workspaceRoot)) {
    throw new Error(
      `Worktree "${name}" does not exist at ${workspaceRoot}. Use "babel worktree create ${name}" first.`,
    );
  }
  process.env['BABEL_WORKTREE_ROOT'] = workspaceRoot;
}

/**
 * Exit the current worktree by deleting BABEL_WORKTREE_ROOT.
 *
 * CAUTION: BABEL_WORKTREE_ROOT is a process-level environment variable.
 * It does NOT persist across shell invocations. This deletion only
 * affects the current process's environment.
 */
export function exitWorktree(): void {
  delete process.env['BABEL_WORKTREE_ROOT'];
}

export function getActiveWorktreeRoot(): string | undefined {
  return process.env['BABEL_WORKTREE_ROOT'];
}

/**
 * Check if a worktree is currently active (BABEL_WORKTREE_ROOT is set).
 * @internal
 */
export function isWorktreeActive(): boolean {
  return process.env['BABEL_WORKTREE_ROOT'] !== undefined;
}

export function removeWorktree(
  name: string,
  options?: { projectRoot?: string; force?: boolean },
): void {
  const root = options?.projectRoot ?? process.cwd();
  const workspaceRoot = join(root, '.babel', 'worktrees', name);

  if (!existsSync(workspaceRoot)) {
    throw new Error(`Worktree "${name}" does not exist at ${workspaceRoot}.`);
  }

  // Remove the git worktree registration
  const removeArgs = ['worktree', 'remove'];
  if (options?.force) {
    removeArgs.push('--force');
  }
  removeArgs.push(workspaceRoot);

  const removeResult = spawnSync('git', removeArgs, {
    cwd: root,
    encoding: 'utf-8',
  });

  if (removeResult.status !== 0) {
    const errMsg = (removeResult.stderr || removeResult.stdout || '').trim();
    throw new Error(`git worktree remove failed: ${errMsg}`);
  }

  // Clean up the directory if still present
  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }

  // Remove the branch using the stored branch name from worktree metadata
  const worktrees = listWorktrees(root);
  const worktree = worktrees.find((w) => w.name === name || w.path === workspaceRoot);
  const branchName =
    worktree?.branch && worktree.branch !== 'detached'
      ? worktree.branch
      : `${WORKTREE_PREFIX}${name}`;
  const branchCheck = spawnSync('git', ['branch', '--list', branchName], {
    cwd: root,
    encoding: 'utf-8',
  });
  if (branchCheck.stdout.trim()) {
    spawnSync('git', ['branch', '-D', branchName], {
      cwd: root,
      encoding: 'utf-8',
    });
  }

  // Clear BABEL_WORKTREE_ROOT if we just removed the active worktree
  if (getActiveWorktreeRoot() === workspaceRoot) {
    exitWorktree();
  }
}

export function listWorktrees(projectRoot?: string): WorktreeInfo[] {
  const root = projectRoot ?? process.cwd();
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    return [];
  }

  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  const activeWorktree = getActiveWorktreeRoot();

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('HEAD ')) {
      current.branch = line.slice('HEAD '.length).trim();
      current.detached = current.branch.length === 40; // SHA hash = detached
    } else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
      current.detached = false;
    } else if (line === '') {
      if (current.path) {
        const pathBase = current.path.split(/[\\/]/).pop() ?? current.path;
        const name = pathBase.startsWith(WORKTREE_PREFIX)
          ? pathBase.slice(WORKTREE_PREFIX.length)
          : pathBase;
        entries.push({
          name,
          path: current.path,
          branch: current.branch ?? 'unknown',
          detached: current.detached ?? false,
          active: activeWorktree === current.path,
        });
        current = {};
      }
    }
  }

  return entries;
}

// ─── Path resolution helper ────────────────────────────────────────────────

/**
 * Resolve a target path within the active worktree root.
 * @internal
 */
export function resolveWorktreePath(targetPath: string): string {
  const worktreeRoot = getActiveWorktreeRoot();
  if (!worktreeRoot) {
    return targetPath;
  }
  // If path is already inside a worktree, return as-is
  if (targetPath.startsWith(worktreeRoot)) {
    return targetPath;
  }
  // Resolve relative paths against the worktree root
  return resolve(worktreeRoot, targetPath);
}
