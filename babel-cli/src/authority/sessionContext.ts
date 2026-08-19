/**
 * sessionContext.ts — immutable authority context for one trusted session.
 *
 * Baseline capture belongs at a trusted start boundary. Resume restores the
 * persisted snapshot and invalidation flag; it never recaptures a matching
 * baseline over a drifted tree. Resume binds persisted lease identity and
 * canonical repository identity; mismatches fail closed.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLeaseFromEnv, type AutonomyLease } from './lease.js';
import { buildBaseline, type BaselineManifest } from './integrity.js';

export const AUTHORITY_SESSION_FILENAME = 'authority-session.json';

export type AuthorityResumeFailure =
  | 'lease_mismatch'
  | 'repo_mismatch'
  | 'persisted_lease_missing'
  | 'active_lease_missing'
  | 'malformed'
  | 'schema';

export interface AuthoritySessionContext {
  lease: AutonomyLease | null;
  repoRoot: string;
  baseline: BaselineManifest | null;
  invalidated: boolean;
  persistPath?: string;
  resumeFailure?: AuthorityResumeFailure;
}

interface PersistedAuthoritySession {
  schemaVersion: 1;
  leaseId: string | null;
  repoRoot: string;
  baseline: BaselineManifest | null;
  invalidated: boolean;
}

export function canonicalizeRepoRoot(repoRoot: string): string {
  const resolved = resolve(repoRoot);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function failClosedResume(
  persistPath: string,
  repoRoot: string,
  lease: AutonomyLease | null,
  reason: AuthorityResumeFailure,
): AuthoritySessionContext {
  return {
    lease,
    repoRoot: canonicalizeRepoRoot(repoRoot),
    baseline: null,
    invalidated: true,
    persistPath,
    resumeFailure: reason,
  };
}

function isUsableBaseline(baseline: unknown): baseline is BaselineManifest {
  if (baseline === null || baseline === undefined) return true;
  if (typeof baseline !== 'object') return false;
  const rec = baseline as { entries?: unknown };
  return Array.isArray(rec.entries);
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

/**
 * Load persisted authority state. Callers MUST validate identity via
 * `restoreAuthoritySession` — this helper does not bind lease/repo identity.
 */
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
 * Mismatched lease or repository identity → invalidated + no baseline.
 */
export function restoreAuthoritySession(input: {
  repoRoot: string;
  persistPath: string;
  lease?: AutonomyLease | null;
}): AuthoritySessionContext {
  const lease = input.lease !== undefined ? input.lease : loadLeaseFromEnv();
  const requestedRoot = canonicalizeRepoRoot(input.repoRoot);
  if (!existsSync(input.persistPath)) {
    return {
      lease,
      repoRoot: requestedRoot,
      baseline: null,
      invalidated: false,
      persistPath: input.persistPath,
    };
  }
  let parsed: PersistedAuthoritySession;
  try {
    parsed = JSON.parse(readFileSync(input.persistPath, 'utf8')) as PersistedAuthoritySession;
  } catch {
    return failClosedResume(input.persistPath, requestedRoot, lease, 'malformed');
  }
  if (parsed.schemaVersion !== 1) {
    return failClosedResume(input.persistPath, requestedRoot, lease, 'schema');
  }
  if (!isUsableBaseline(parsed.baseline)) {
    return failClosedResume(input.persistPath, requestedRoot, lease, 'malformed');
  }
  const persistedRoot = typeof parsed.repoRoot === 'string' ? canonicalizeRepoRoot(parsed.repoRoot) : '';
  if (!persistedRoot || persistedRoot !== requestedRoot) {
    return failClosedResume(input.persistPath, requestedRoot, lease, 'repo_mismatch');
  }
  const persistedLeaseId = parsed.leaseId ?? null;
  const activeLeaseId = lease?.leaseId ?? null;
  if (persistedLeaseId && !activeLeaseId) {
    return failClosedResume(input.persistPath, requestedRoot, lease, 'active_lease_missing');
  }
  if (!persistedLeaseId && activeLeaseId) {
    return failClosedResume(input.persistPath, requestedRoot, lease, 'persisted_lease_missing');
  }
  if (persistedLeaseId !== activeLeaseId) {
    return failClosedResume(input.persistPath, requestedRoot, lease, 'lease_mismatch');
  }
  return {
    lease,
    repoRoot: persistedRoot,
    baseline: parsed.baseline ?? null,
    invalidated: parsed.invalidated === true,
    persistPath: input.persistPath,
  };
}
