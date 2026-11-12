import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatSessionDir, chatSessionsDir } from '../cli/runsLayout.js';

export interface SessionPolicyLease { readonly sessionId: string; release(): void }
const quarantinedLeases = new Map<string, SessionPolicyLease>();

/** Retain a lease when an owned effect has not physically settled. */
export function quarantineSessionPolicyLease(sessionId: string, lease: SessionPolicyLease): void {
  if (quarantinedLeases.has(sessionId)) throw new Error('Session ownership is already quarantined.');
  quarantinedLeases.set(sessionId, lease);
}

/**
 * Cooperative cross-process ownership for session policy and task admission.
 * All writers must hold this lease for their entire active session lifetime.
 * It does not fence older binaries which do not implement this contract.
 */
export function acquireSessionPolicyLease(sessionId: string, options: { create?: boolean } = {}): SessionPolicyLease {
  if (!/^[\w-]{1,120}$/.test(sessionId)) throw new Error('Invalid session identity.');
  const root = chatSessionsDir();
  const directory = chatSessionDir(sessionId);
  if (options.create) mkdirSync(directory, { recursive: true });
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Unsafe session directory.');
  const realRoot = realpathSync(root);
  const realDirectory = realpathSync(directory);
  const child = relative(realRoot, realDirectory);
  if (!child || child.startsWith('..') || isAbsolute(child) || /[\\/]/.test(child)) throw new Error('Unsafe session directory.');
  const lockPath = join(realDirectory, 'session-policy-owner.sqlite');
  try { const fd = openSync(lockPath, 'wx', 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const lockInfo = lstatSync(lockPath);
  if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new Error('Unsafe session ownership file.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(lockPath);
    db.exec('PRAGMA busy_timeout=0');
    db.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)');
    db.exec('BEGIN IMMEDIATE');
  } catch {
    try { db?.close(); } catch { /* Preserve the acquisition failure. */ }
    throw new Error('This session is already owned or its ownership record is unavailable.');
  }
  let released = false;
  const owned = db;
  return Object.freeze({ sessionId, release() {
    if (released) return;
    released = true;
    try { owned.exec('ROLLBACK'); } finally { owned.close(); }
  } });
}
