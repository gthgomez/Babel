/**
 * governanceReconcile.ts — post-command restore of governance bytes.
 *
 * Direct write_file/apply_patch already deny governance paths. Subprocess
 * interpreters can still overwrite those files. After an allowed shell
 * effect we compare bytes to the pre-command snapshot, restore any
 * unauthorized change, and invalidate the authority session.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { buildBaseline, isAuthorityStatePath, isGovernancePath } from './integrity.js';
import { markSessionInvalidated, type AuthoritySessionContext } from './sessionContext.js';

export interface GovernanceFileSnapshot {
  /** Repo-relative path (forward slashes) or absolute persist path. */
  key: string;
  abs: string;
  bytes: Buffer | null;
}

export function snapshotGovernanceBytes(
  repoRoot: string,
  extraAbsPaths: readonly string[] = [],
): GovernanceFileSnapshot[] {
  const out: GovernanceFileSnapshot[] = [];
  const seen = new Set<string>();

  const addAbs = (abs: string, key: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    let bytes: Buffer | null = null;
    try {
      bytes = existsSync(abs) ? readFileSync(abs) : null;
    } catch {
      bytes = null;
    }
    out.push({ key, abs, bytes });
  };

  try {
    const manifest = buildBaseline(repoRoot);
    for (const entry of manifest.entries) {
      if (entry.kind !== 'file' && entry.kind !== 'missing') continue;
      addAbs(join(repoRoot, entry.path), entry.path);
    }
  } catch {
    /* baseline walk can fail on a temp tree — still snapshot extras */
  }

  for (const extra of extraAbsPaths) {
    addAbs(extra, extra);
  }

  return out;
}

function restoreOne(snap: GovernanceFileSnapshot): boolean {
  try {
    if (snap.bytes === null) {
      if (existsSync(snap.abs)) {
        rmSync(snap.abs, { force: true });
        return true;
      }
      return false;
    }
    mkdirSync(dirname(snap.abs), { recursive: true });
    const current = existsSync(snap.abs) ? readFileSync(snap.abs) : null;
    if (current && current.equals(snap.bytes)) return false;
    writeFileSync(snap.abs, snap.bytes);
    return true;
  } catch {
    return false;
  }
}

export function governanceBytesChanged(before: readonly GovernanceFileSnapshot[]): string[] {
  const changed: string[] = [];
  for (const snap of before) {
    let current: Buffer | null = null;
    try {
      current = existsSync(snap.abs) ? readFileSync(snap.abs) : null;
    } catch {
      current = null;
    }
    const same =
      (snap.bytes === null && current === null) ||
      (snap.bytes !== null && current !== null && snap.bytes.equals(current));
    if (!same) changed.push(snap.key);
  }
  return changed;
}

export function restoreGovernanceBytes(before: readonly GovernanceFileSnapshot[]): string[] {
  const restored: string[] = [];
  for (const snap of before) {
    if (restoreOne(snap)) restored.push(snap.key);
  }
  return restored;
}

export function repoRelativeOrName(repoRoot: string, absPath: string): string {
  if (!isAbsolute(absPath)) return absPath.replace(/\\/g, '/');
  const rel = relative(repoRoot, absPath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  return absPath;
}

export function isProtectedEffectPath(repoRoot: string, absOrRel: string): boolean {
  const rel = repoRelativeOrName(repoRoot, absOrRel);
  return isGovernancePath(rel) || isAuthorityStatePath(rel);
}

export function reconcileGovernanceAfterEffect(input: {
  repoRoot: string;
  before: readonly GovernanceFileSnapshot[];
  session?: AuthoritySessionContext;
}): { mutated: boolean; restored: string[]; changed: string[] } {
  const changed = governanceBytesChanged(input.before);
  if (changed.length === 0) {
    return { mutated: false, restored: [], changed: [] };
  }
  const restored = restoreGovernanceBytes(input.before);
  if (input.session) markSessionInvalidated(input.session);
  return { mutated: true, restored, changed };
}
