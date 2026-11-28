/**
 * Resolve agent-supplied file paths against ChatEngine projectRoot.
 * Relative paths must not depend on process.cwd() (SWE harness cwd is babel-cli).
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

/** Resolve the lexical part of a model-facing workspace mount alias. */
export function workspaceMountPath(inputPath: string, includeApp = false): string | undefined {
  const normalized = inputPath.trim().replace(/\\/g, '/');
  const match = (includeApp ? /^\/(?:project|app)(?:\/|$)/i : /^\/project(?:\/|$)/i).exec(normalized);
  return match ? normalized.slice(match[0].length).replace(/^\/+/, '') : undefined;
}

/**
 * Sanitize a path component so it is safe to use as a filesystem name segment.
 * Strips Windows drive-letter prefixes (C:, D:, etc.), replaces characters
 * that are invalid in Windows/NTFS filenames (< > : " | ? *), and normalizes
 * backslashes to forward slashes. Does NOT strip path separators — callers
 * should split on separators before passing individual segments.
 */
export function sanitizePathComponent(segment: string): string {
  return segment
    .replace(/^[A-Za-z]:(?=\\|$)/, '') // Strip Windows drive letter (e.g. "C:\" → "\")
    .replace(/[<>:"|?*]/g, '-') // Replace NTFS-invalid filename chars
    .replace(/\\/g, '/'); // Normalize to POSIX separators
}

/**
 * Sanitize a full path string by applying sanitizePathComponent to each
 * segment. Preserves the directory structure while cleaning each component.
 */
export function sanitizePath(fullPath: string): string {
  const segments = fullPath.split(/[/\\]+/).filter(Boolean);
  return segments.map(sanitizePathComponent).join('/');
}

/** The lexical path accepted by a sandbox file tool or command cwd. */
export function resolveSandboxProjectPath(projectRoot: string, inputPath: string, includeApp = false): string {
  const trimmed = inputPath.trim();
  const mounted = workspaceMountPath(trimmed, includeApp);
  if (mounted !== undefined) return resolve(projectRoot, sanitizePath(mounted));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, sanitizePath(trimmed));
}

/** Resolve existing directory entries in the order a child process sees them. */
export function physicalWorkspacePath(base: string, path: string): string {
  const raw = isAbsolute(path) ? path : `${base}${sep}${path}`;
  const tail: string[] = [];
  let cursor = raw;
  for (;;) {
    try { return resolve(realpathSync.native(cursor), ...tail); }
    catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(raw);
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

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
