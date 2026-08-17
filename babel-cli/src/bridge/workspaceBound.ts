/**
 * Authorization handle for remote thread.create project_root.
 * This is NOT a sandbox — subprocesses can still escape. It only stops
 * the API from accepting arbitrary client-supplied filesystem paths.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export class WorkspaceBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceBoundError';
  }
}

function normalize(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = normalize(root);
  const resolvedCandidate = normalize(candidate);
  if (process.platform === 'win32') {
    const rootNorm = resolvedRoot.toLowerCase();
    const candidateNorm = resolvedCandidate.toLowerCase();
    return candidateNorm === rootNorm || candidateNorm.startsWith(`${rootNorm}${sep}`);
  }
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

export function assertAllowedProjectRoot(projectRoot: string, allowedRoot: string): string {
  const resolved = normalize(projectRoot);
  if (!isPathInsideRoot(allowedRoot, resolved)) {
    throw new WorkspaceBoundError(
      `project_root is outside the registered workspace. Remote API accepts workspace-relative paths only.`,
    );
  }
  return resolved;
}
