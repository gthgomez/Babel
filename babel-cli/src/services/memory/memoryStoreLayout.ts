/**
 * Memory store directory layout: legacy and canonical (digest) slugs, path helpers.
 */

import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { resolveRuntimeUserStateRoot } from '../../config/runtimePaths.js';

export const MEMORY_PROVENANCE_FILE = '.babel-memory-provenance.json';
export const MEMORY_MIGRATION_FILE = '.babel-memory-migration.json';
export const MEMORY_RECONCILIATION_FILE = '.babel-memory-reconciliation.json';

export type MemorySlugFormat = 'legacy-v0' | 'digest-v1';

export interface MemoryProvenance {
  schemaVersion: 1;
  slugFormat: MemorySlugFormat;
  /** Case-sensitive absolute project root this store serves. */
  projectRoot: string;
  establishedAt: string;
}

export interface MemoryMigrationConflict {
  file: string;
  contentSha256Legacy: string;
  contentSha256Canonical: string;
}

export interface MemoryMigrationRecord {
  schemaVersion: 1;
  status: 'partial' | 'complete' | 'blocked_conflict';
  sourceLegacySlug: string;
  sourceLegacyMemoryRoot: string;
  projectRoot: string;
  migratedFiles: string[];
  conflicts?: MemoryMigrationConflict[];
  preservedOriginal: true;
  updatedAt: string;
}

/** Operator-attested manual canonical store (does not infer legacy ownership). */
export interface MemoryReconciliation {
  schemaVersion: 1;
  projectRoot: string;
  kind: 'explicit_operator';
  establishedAt: string;
  memoryFiles: Array<{ name: string; contentSha256: string }>;
  note?: string;
}

/**
 * Sanitize a git root path to a filesystem-safe slug (legacy v0 layout).
 */
export function sanitizeGitRoot(gitRoot: string): string {
  return gitRoot
    .replace(/^[A-Za-z]:(?=\/|\\)/, '') // Strip Windows drive letter (e.g., "C:" → "")
    .replace(/[/\\:<>"|?*]+/g, '-') // Replace invalid/special chars with hyphens
    .replace(/^[-.]+|[-.]+$/g, '') // Strip leading/trailing hyphens and dots
    .replace(/-+/g, '-') // Collapse consecutive hyphens
    .toLowerCase();
}

export function legacyMemoryProjectSlug(projectRoot: string): string {
  return sanitizeGitRoot(resolve(projectRoot));
}

export function deriveMemoryProjectSlug(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  const sanitized = sanitizeGitRoot(absolute);
  const digest = createHash('sha256').update(absolute, 'utf8').digest('hex').slice(0, 16);
  const base = sanitized.length > 0 ? sanitized : 'root';
  return `${base}--${digest}`;
}

export function memoryProjectDir(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveRuntimeUserStateRoot(env), 'projects', slug);
}

export function memoryRootForSlug(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(memoryProjectDir(slug, env), 'memory');
}

export function pathsForProject(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  absolute: string;
  canonicalSlug: string;
  legacySlug: string;
  canonicalProjectDir: string;
  legacyProjectDir: string;
  canonicalMemoryRoot: string;
  legacyMemoryRoot: string;
} {
  const absolute = resolve(projectRoot);
  const canonicalSlug = deriveMemoryProjectSlug(absolute);
  const legacySlug = legacyMemoryProjectSlug(absolute);
  return {
    absolute,
    canonicalSlug,
    legacySlug,
    canonicalProjectDir: memoryProjectDir(canonicalSlug, env),
    legacyProjectDir: memoryProjectDir(legacySlug, env),
    canonicalMemoryRoot: memoryRootForSlug(canonicalSlug, env),
    legacyMemoryRoot: memoryRootForSlug(legacySlug, env),
  };
}
