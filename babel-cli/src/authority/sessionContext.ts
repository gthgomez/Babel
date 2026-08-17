/**
 * sessionContext.ts — immutable authority context for one trusted session.
 *
 * Baseline capture belongs at a trusted start boundary. Resume restores the
 * persisted snapshot and invalidation flag; it never recaptures a matching
 * baseline over a drifted tree.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { loadLeaseFromEnv, type AutonomyLease } from './lease.js';
import { buildBaseline, type BaselineManifest } from './integrity.js';

export const AUTHORITY_SESSION_FILENAME = 'authority-session.json';

export interface AuthoritySessionContext {
  lease: AutonomyLease | null;
  repoRoot: string;
  baseline: BaselineManifest | null;
  invalidated: boolean;
  persistPath?: string;
}

interface PersistedAuthoritySession {
  schemaVersion: 1;
  leaseId: string | null;
  repoRoot: string;
  baseline: BaselineManifest | null;
  invalidated: boolean;
}

export function canonicalizeRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return repoRoot;
  }
}

export function persistAuthoritySession(ctx: AuthoritySessionContext): void {
  if (!ctx.persistPath) return;
  const body: PersistedAuthoritySession = {
    schemaVersion: 1,
    leaseId: ctx.lease?.leaseId ?? null,
    repoRoot: ctx.repoRoot,
    baseline: ctx.baseline,
    invalidated: ctx.invalidated,
  };
  writeFileSync(ctx.persistPath, JSON.stringify(body), 'utf8');
}

export function loadPersistedAuthoritySession(
  persistPath: string,
  lease: AutonomyLease | null,
): AuthoritySessionContext | null {
  if (!existsSync(persistPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(persistPath, 'utf8')) as PersistedAuthoritySession;
    if (parsed.schemaVersion !== 1) return null;
    return {
      lease,
      repoRoot: parsed.repoRoot,
      baseline: parsed.baseline ?? null,
      invalidated: parsed.invalidated === true,
      persistPath,
    };
  } catch {
    return null;
  }
}

export function markSessionInvalidated(ctx: AuthoritySessionContext): void {
  ctx.invalidated = true;
  persistAuthoritySession(ctx);
}

/** Capture lease + baseline once at a trusted session start (not resume). */
export function establishAuthoritySession(input: {
  repoRoot: string;
  lease?: AutonomyLease | null;
  persistPath?: string;
}): AuthoritySessionContext {
  const repoRoot = canonicalizeRepoRoot(input.repoRoot);
  const lease = input.lease !== undefined ? input.lease : loadLeaseFromEnv();
  let baseline: BaselineManifest | null = null;
  try {
    baseline = buildBaseline(repoRoot);
  } catch {
    baseline = null;
  }
  const ctx: AuthoritySessionContext = {
    lease,
    repoRoot,
    baseline,
    invalidated: false,
    ...(input.persistPath ? { persistPath: input.persistPath } : {}),
  };
  persistAuthoritySession(ctx);
  return ctx;
}

/**
 * Resume: restore the original snapshot. Never recapture.
 * Missing persist + active lease → incomplete context (fail closed at decide).
 */
export function restoreAuthoritySession(input: {
  repoRoot: string;
  persistPath: string;
  lease?: AutonomyLease | null;
}): AuthoritySessionContext {
  const lease = input.lease !== undefined ? input.lease : loadLeaseFromEnv();
  const loaded = loadPersistedAuthoritySession(input.persistPath, lease);
  if (loaded) return loaded;
  return {
    lease,
    repoRoot: canonicalizeRepoRoot(input.repoRoot),
    baseline: null,
    invalidated: false,
    persistPath: input.persistPath,
  };
}
