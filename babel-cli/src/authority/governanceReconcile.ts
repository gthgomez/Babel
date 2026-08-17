/**
 * governanceReconcile.ts — post-command restore of governance objects.
 *
 * Direct write_file/apply_patch already deny governance paths. Subprocess
 * interpreters can still overwrite those files. After an allowed shell
 * effect we compare the pre-command object-type snapshot, restore any
 * unauthorized change without following occupant objects, and invalidate
 * the authority session regardless of restore success.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { buildBaseline, isAuthorityStatePath, isGovernancePath } from './integrity.js';
import { markSessionInvalidated, type AuthoritySessionContext } from './sessionContext.js';

export type ProtectedSnapshot =
  | { kind: 'file'; key: string; abs: string; bytes: Buffer; mode?: number }
  | { kind: 'symlink'; key: string; abs: string; target: string }
  | { kind: 'directory'; key: string; abs: string; mode?: number }
  | { kind: 'missing'; key: string; abs: string };

/** @deprecated Use ProtectedSnapshot. Kept as an alias for existing imports. */
export type GovernanceFileSnapshot = ProtectedSnapshot;

export interface RestoreFailure {
  path: string;
  reason: string;
}

export interface RestoreResult {
  changed: string[];
  restored: string[];
  verified: string[];
  failed: RestoreFailure[];
}

export interface ReconcileFs {
  lstatSync(path: string): {
    isFile(): boolean;
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    mode?: number;
  };
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, data: Buffer, opts?: { mode?: number }): void;
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  rmSync(path: string, opts: { recursive?: boolean; force?: boolean }): void;
  readlinkSync(path: string): string;
  symlinkSync(target: string, path: string): void;
}

const defaultFs: ReconcileFs = {
  lstatSync,
  readFileSync: (p) => readFileSync(p),
  writeFileSync: (p, data, opts) => writeFileSync(p, data, opts),
  mkdirSync,
  rmSync,
  readlinkSync: (p) => readlinkSync(p, 'utf8'),
  symlinkSync,
};

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT');
}

export function inspectProtectedPath(abs: string, key: string, fs: ReconcileFs = defaultFs): ProtectedSnapshot {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      return { kind: 'symlink', key, abs, target: fs.readlinkSync(abs) };
    }
    if (st.isDirectory()) {
      return { kind: 'directory', key, abs, ...(st.mode !== undefined ? { mode: st.mode } : {}) };
    }
    if (st.isFile()) {
      return {
        kind: 'file',
        key,
        abs,
        bytes: fs.readFileSync(abs),
        ...(st.mode !== undefined ? { mode: st.mode } : {}),
      };
    }
    return { kind: 'missing', key, abs };
  } catch (err) {
    if (isNotFound(err)) return { kind: 'missing', key, abs };
    return { kind: 'missing', key, abs };
  }
}

function snapshotsEqual(expected: ProtectedSnapshot, current: ProtectedSnapshot): boolean {
  if (expected.kind !== current.kind) return false;
  if (expected.kind === 'file' && current.kind === 'file') return expected.bytes.equals(current.bytes);
  if (expected.kind === 'symlink' && current.kind === 'symlink') return expected.target === current.target;
  if (expected.kind === 'directory' && current.kind === 'directory') return true;
  return expected.kind === 'missing' && current.kind === 'missing';
}

export function snapshotGovernanceBytes(
  repoRoot: string,
  extraAbsPaths: readonly string[] = [],
  fs: ReconcileFs = defaultFs,
): ProtectedSnapshot[] {
  const out: ProtectedSnapshot[] = [];
  const seen = new Set<string>();

  const addAbs = (abs: string, key: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(inspectProtectedPath(abs, key, fs));
  };

  try {
    const manifest = buildBaseline(repoRoot);
    for (const entry of manifest.entries) {
      if (entry.kind !== 'file' && entry.kind !== 'missing' && entry.kind !== 'symlink') continue;
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

function removeWithoutFollowing(abs: string, fs: ReconcileFs): void {
  try {
    const st = fs.lstatSync(abs);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      fs.rmSync(abs, { recursive: true, force: true });
      return;
    }
    fs.rmSync(abs, { force: true });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function pathAbsent(abs: string, fs: ReconcileFs): boolean {
  try {
    fs.lstatSync(abs);
    return false;
  } catch (err) {
    return isNotFound(err);
  }
}

function recreateExpected(expected: ProtectedSnapshot, fs: ReconcileFs): void {
  if (expected.kind === 'missing') return;
  fs.mkdirSync(dirname(expected.abs), { recursive: true });
  if (expected.kind === 'file') {
    fs.writeFileSync(expected.abs, expected.bytes, expected.mode !== undefined ? { mode: expected.mode } : undefined);
    return;
  }
  if (expected.kind === 'symlink') {
    fs.symlinkSync(expected.target, expected.abs);
    return;
  }
  fs.mkdirSync(expected.abs, { recursive: true });
}

function verifyExpected(expected: ProtectedSnapshot, fs: ReconcileFs): string | null {
  const current = inspectProtectedPath(expected.abs, expected.key, fs);
  if (expected.kind === 'missing') {
    return current.kind === 'missing' ? null : 'expected_missing_still_present';
  }
  if (current.kind !== expected.kind) return `kind_mismatch:${current.kind}`;
  if (expected.kind === 'file' && current.kind === 'file' && !expected.bytes.equals(current.bytes)) {
    return 'byte_mismatch';
  }
  if (expected.kind === 'symlink' && current.kind === 'symlink' && expected.target !== current.target) {
    return 'symlink_target_mismatch';
  }
  return null;
}

export function restoreOne(
  expected: ProtectedSnapshot,
  fs: ReconcileFs = defaultFs,
): { restored: boolean; verified: boolean; reason?: string } {
  const current = inspectProtectedPath(expected.abs, expected.key, fs);
  if (snapshotsEqual(expected, current)) {
    return { restored: false, verified: true };
  }
  try {
    removeWithoutFollowing(expected.abs, fs);
    recreateExpected(expected, fs);
    const verifyReason = verifyExpected(expected, fs);
    if (verifyReason) return { restored: true, verified: false, reason: verifyReason };
    return { restored: true, verified: true };
  } catch (err) {
    return {
      restored: false,
      verified: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function governanceBytesChanged(
  before: readonly ProtectedSnapshot[],
  fs: ReconcileFs = defaultFs,
): string[] {
  const changed: string[] = [];
  for (const snap of before) {
    const current = inspectProtectedPath(snap.abs, snap.key, fs);
    if (!snapshotsEqual(snap, current)) changed.push(snap.key);
  }
  return changed;
}

export function restoreGovernanceBytes(
  before: readonly ProtectedSnapshot[],
  fs: ReconcileFs = defaultFs,
): RestoreResult {
  const result: RestoreResult = { changed: [], restored: [], verified: [], failed: [] };
  for (const snap of before) {
    const current = inspectProtectedPath(snap.abs, snap.key, fs);
    if (snapshotsEqual(snap, current)) {
      result.verified.push(snap.key);
      continue;
    }
    result.changed.push(snap.key);
    const one = restoreOne(snap, fs);
    if (one.restored) result.restored.push(snap.key);
    if (one.verified) result.verified.push(snap.key);
    else result.failed.push({ path: snap.key, reason: one.reason ?? 'restore_failed' });
  }
  return result;
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
  before: readonly ProtectedSnapshot[];
  session?: AuthoritySessionContext;
  fs?: ReconcileFs;
}): RestoreResult & { mutated: boolean } {
  const fs = input.fs ?? defaultFs;
  const restore = restoreGovernanceBytes(input.before, fs);
  if (restore.changed.length === 0 && restore.failed.length === 0) {
    return { mutated: false, ...restore };
  }
  if (input.session) markSessionInvalidated(input.session);
  return { mutated: true, ...restore };
}
