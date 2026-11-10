/**
 * Legacy slug collision families (for tests and operator diagnostics only).
 * Migration does not infer ownership from absence of on-disk siblings.
 */

import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve as resolveAbsolute } from 'node:path';

import { sanitizeGitRoot } from './memoryStoreLayout.js';

/** True when distinct paths fold to the same legacy v0 slug (case, punctuation, etc.). */
export function legacySlugSanitizeCollides(paths: readonly string[]): boolean {
  if (paths.length < 2) return false;
  const folded = paths.map((p) => sanitizeGitRoot(resolveAbsolute(p)));
  const uniqueAbs = new Set(paths.map((p) => resolveAbsolute(p)));
  if (uniqueAbs.size < 2) return false;
  return new Set(folded).size < paths.length;
}

/** @deprecated Alias for legacySlugSanitizeCollides — case fold is one collision family. */
export function legacySlugCaseCollides(paths: readonly string[]): boolean {
  return legacySlugSanitizeCollides(paths);
}

/**
 * Optional on-disk case sibling hint (diagnostics only; not used for import attribution).
 * Uses join+resolve to avoid parent-relative resolve patterns flagged by CANON001.
 */
export function detectOnDiskCaseCollision(absolute: string): boolean {
  const resolved = resolveAbsolute(absolute);
  const parent = dirname(resolved);
  const base = basename(resolved);
  const folded = base.toLowerCase();
  try {
    const siblings = readdirSync(parent);
    return siblings.some((entry) => {
      if (entry === base || entry.toLowerCase() !== folded) return false;
      const other = resolveAbsolute(join(parent, entry));
      return other !== resolved && sanitizeGitRoot(other) === sanitizeGitRoot(resolved);
    });
  } catch {
    return false;
  }
}
