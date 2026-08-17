/**
 * Authorization handle for remote thread.create project_root.
 * This is NOT a sandbox — subprocesses can still escape. It only stops
 * the API from accepting arbitrary client-supplied filesystem paths.
 */

import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class WorkspaceBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBoundError';
  }
}

function splitComponents(abs: string): string[] {
  return abs.split(/[\\/]+/).filter((p) => p.length > 0);
}

/** Canonicalize through the last existing ancestor, then append remaining parts. */
export function canonicalizeContained(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ''));
    cursor = parent;
  }
  if (!existsSync(cursor)) {
    throw new WorkspaceBoundError('path cannot be canonicalized');
  }
  const real = realpathSync(cursor);
  return missing.length === 0 ? real : resolve(real, ...missing);
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = canonicalizeContained(root);
    realCandidate = canonicalizeContained(candidate);
  } catch {
    return false;
  }
  if (process.platform === 'win32') {
    realRoot = realRoot.toLowerCase();
    realCandidate = realCandidate.toLowerCase();
  }
  const rootParts = splitComponents(realRoot);
  const candParts = splitComponents(realCandidate);
  if (candParts.length < rootParts.length) return false;
  return rootParts.every((part, i) => part === candParts[i]);
}

export function assertAllowedProjectRoot(projectRoot: string, allowedRoot: string): string {
  const resolvedRoot = resolve(allowedRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new WorkspaceBoundError('authorized workspace root is missing or not a directory');
  }
  const resolved = resolve(projectRoot);
  if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
    throw new WorkspaceBoundError('project_root must exist and be a directory');
  }
  const canonical = canonicalizeContained(resolved);
  if (!isPathInsideRoot(resolvedRoot, canonical)) {
    throw new WorkspaceBoundError(
      `project_root is outside the registered workspace. Remote API accepts workspace-relative paths only.`,
    );
  }
  return canonical;
}
