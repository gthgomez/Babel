/**
 * sessionContext.ts — immutable authority context for one trusted session.
 *
 * Baseline capture belongs here, not at decide-time. A caller must not be
 * able to recapture a matching snapshot immediately before authorization.
 */

import { realpathSync } from 'node:fs';
import { loadLeaseFromEnv, type AutonomyLease } from './lease.js';
import { buildBaseline, type BaselineManifest } from './integrity.js';

export interface AuthoritySessionContext {
  lease: AutonomyLease | null;
  repoRoot: string;
  baseline: BaselineManifest | null;
}

export function canonicalizeRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot);
  } catch {
    return repoRoot;
  }
}

/** Capture lease + baseline once at a trusted session boundary. */
export function establishAuthoritySession(input: {
  repoRoot: string;
  lease?: AutonomyLease | null;
}): AuthoritySessionContext {
  const repoRoot = canonicalizeRepoRoot(input.repoRoot);
  const lease = input.lease !== undefined ? input.lease : loadLeaseFromEnv();
  let baseline: BaselineManifest | null = null;
  try {
    baseline = buildBaseline(repoRoot);
  } catch {
    baseline = null;
  }
  return { lease, repoRoot, baseline };
}
