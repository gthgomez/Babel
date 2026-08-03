/**
 * Clean verifier overlay for benchmark acceptance.
 *
 * The agent works in the primary checkout. The verifier receives a detached
 * worktree at the committed baseline plus only the agent's non-protected
 * production diff. This keeps agent edits to test files and the primary
 * workspace out of the authoritative fail-to-pass attempt.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export interface VerifierOverlayResult {
  ok: boolean;
  root: string | null;
  excludedPaths: string[];
  appliedFiles: string[];
  reason: string | null;
}

function runGit(args: string[], cwd: string, timeoutMs = 120_000) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function changedPathsFromHead(repoRoot: string): string[] {
  const result = runGit(['show', '--format=', '--name-only', 'HEAD'], repoRoot);
  if (result.status !== 0) return [];
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map(normalizeRelativePath)
    .filter(Boolean);
}

function changedPathsFromDiff(repoRoot: string, excludedPaths: string[]): { patch: string; files: string[] } {
  const pathspecs = ['.'];
  for (const path of excludedPaths) {
    pathspecs.push(`:(exclude)${path}`);
  }
  const result = runGit(['diff', '--binary', 'HEAD', '--', ...pathspecs], repoRoot);
  if (result.status !== 0) return { patch: '', files: [] };
  const patch = result.stdout ?? '';
  const files = [...new Set(
    (patch.match(/^\+\+\+ b\/(.+)$/gm) ?? []).map((line: string) => normalizeRelativePath(line.slice(6))),
  )];
  return { patch, files };
}

/**
 * Create a detached verifier worktree and apply the agent-only production
 * diff. No provider output or file contents are included in the result.
 */
export function createVerifierOverlay(input: {
  agentRoot: string;
  overlayRoot: string;
  protectedPaths?: string[];
}): VerifierOverlayResult {
  const agentRoot = resolve(input.agentRoot);
  const overlayRoot = resolve(input.overlayRoot);
  const excludedPaths = [...new Set(
    (input.protectedPaths ?? [])
      .map(normalizeRelativePath)
      .filter(Boolean),
  )];

  if (!existsSync(agentRoot)) {
    return { ok: false, root: null, excludedPaths, appliedFiles: [], reason: 'agent_root_missing' };
  }
  if (pathIsInside(agentRoot, overlayRoot) || pathIsInside(overlayRoot, agentRoot)) {
    return { ok: false, root: null, excludedPaths, appliedFiles: [], reason: 'overlay_root_overlaps_agent_root' };
  }

  const head = runGit(['rev-parse', 'HEAD'], agentRoot);
  if (head.status !== 0 || !(head.stdout ?? '').trim()) {
    return { ok: false, root: null, excludedPaths, appliedFiles: [], reason: 'agent_head_unavailable' };
  }

  const diff = changedPathsFromDiff(agentRoot, excludedPaths);
  if (diff.patch.trim().length === 0 && diff.files.length > 0) {
    return { ok: false, root: null, excludedPaths, appliedFiles: [], reason: 'agent_diff_unreadable' };
  }

  try {
    rmSync(overlayRoot, { recursive: true, force: true });
    mkdirSync(dirname(overlayRoot), { recursive: true });
  } catch {
    return { ok: false, root: null, excludedPaths, appliedFiles: [], reason: 'overlay_prepare_failed' };
  }

  const worktree = runGit(['worktree', 'add', '--detach', overlayRoot, 'HEAD'], agentRoot, 180_000);
  if (worktree.status !== 0) {
    return { ok: false, root: null, excludedPaths, appliedFiles: [], reason: 'overlay_worktree_failed' };
  }

  if (diff.patch.trim().length > 0) {
    const patchPath = `${overlayRoot}.agent-production.patch`;
    try {
      writeFileSync(patchPath, diff.patch, 'utf8');
      const applied = runGit(['apply', '--binary', '--whitespace=nowarn', patchPath], overlayRoot, 120_000);
      if (applied.status !== 0) {
        return {
          ok: false,
          root: overlayRoot,
          excludedPaths,
          appliedFiles: [],
          reason: 'overlay_agent_diff_apply_failed',
        };
      }
    } finally {
      rmSync(patchPath, { force: true });
    }
  }

  return {
    ok: true,
    root: overlayRoot,
    excludedPaths,
    appliedFiles: diff.files,
    reason: null,
  };
}

/** Remove a verifier worktree created by createVerifierOverlay. */
export function removeVerifierOverlay(agentRoot: string, overlayRoot: string | null): void {
  if (!overlayRoot) return;
  const resolvedRoot = resolve(overlayRoot);
  if (pathIsInside(agentRoot, resolvedRoot) || pathIsInside(resolvedRoot, agentRoot)) return;
  const removed = runGit(['worktree', 'remove', '--force', resolvedRoot], resolve(agentRoot), 120_000);
  if (removed.status !== 0 && existsSync(resolvedRoot)) {
    rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

/** Return files changed by the current HEAD commit (used for test_patch protection). */
export function getHeadCommitChangedPaths(repoRoot: string): string[] {
  return changedPathsFromHead(resolve(repoRoot));
}

