/**
 * Resolve agent-supplied file paths against ChatEngine projectRoot.
 * Relative paths must not depend on process.cwd() (SWE harness cwd is babel-cli).
 */

import { isAbsolute, resolve } from 'node:path';

/**
 * True for POSIX absolute paths, Windows drive paths, and UNC paths —
 * even when the host Node is running on Linux (SWE harness / CI).
 */
function isAbsPath(p: string): boolean {
  if (isAbsolute(p)) return true;
  // Windows drive: C:\... or C:/...
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  // UNC: \\server\share or //server/share
  if (p.startsWith('\\\\') || p.startsWith('//')) return true;
  return false;
}

/**
 * Strip optional file:// and join relative paths to projectRoot.
 * Absolute paths (including Windows drive letters) are returned as-is.
 */
export function resolveProjectPath(projectRoot: string, filePath: string): string {
  let p = filePath.trim();
  if (!p) return projectRoot;

  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
    // file:///C:/... → /C:/... on some emitters
    if (/^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1);
    }
  }

  if (isAbsPath(p)) {
    return p;
  }
  return resolve(projectRoot, p);
}
