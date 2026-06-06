import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface WorkspaceLock {
  agent_id: string;
  run_id: string;
  acquired_at: string;
  expires_at: string;
  scope: 'file' | 'directory' | 'project';
  reason: string;
}

export function getWorkspaceLockPath(targetPath: string, babelRoot: string): string {
  const absolutePath = resolve(babelRoot, targetPath);
  const hash = createHash('sha256').update(absolutePath).digest('hex');
  return join(babelRoot, '.babel', 'locks', `${hash}.lock`);
}

export function readLock(lockPath: string): WorkspaceLock | null {
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8'));
    return data as WorkspaceLock;
  } catch {
    return null; // Corrupt lock
  }
}

export function isLockActive(lock: WorkspaceLock): boolean {
  const expiresAt = new Date(lock.expires_at).getTime();
  return Date.now() < expiresAt;
}

function tryCreateLockFile(lockPath: string, lock: WorkspaceLock): boolean {
  try {
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

export function acquireLock(
  targetPath: string,
  babelRoot: string,
  agentId: string,
  runId: string,
  reason: string,
  ttlSec: number = 300
): { success: boolean; message: string } {
  const lockDir = join(babelRoot, '.babel', 'locks');
  if (!existsSync(lockDir)) {
    mkdirSync(lockDir, { recursive: true });
  }

  const lockPath = getWorkspaceLockPath(targetPath, babelRoot);
  const existing = readLock(lockPath);

  if (existing && isLockActive(existing)) {
    if (existing.run_id === runId && existing.agent_id === agentId) {
       // Extend lease
    } else {
      return { 
        success: false, 
        message: `Resource is already locked by ${existing.agent_id} (Run: ${existing.run_id}) until ${existing.expires_at}.` 
      };
    }
  }

  const lock: WorkspaceLock = {
    agent_id: agentId,
    run_id: runId,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    scope: 'file',
    reason
  };

  if (existing && isLockActive(existing) && existing.run_id === runId && existing.agent_id === agentId) {
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf8');
    return { success: true, message: `Lock extended for ${targetPath}. Expires at ${lock.expires_at}.` };
  }

  if (existing && !isLockActive(existing)) {
    rmSync(lockPath, { force: true });
  }

  if (!tryCreateLockFile(lockPath, lock)) {
    const winner = readLock(lockPath);
    if (winner && isLockActive(winner)) {
      return {
        success: false,
        message: `Resource is already locked by ${winner.agent_id} (Run: ${winner.run_id}) until ${winner.expires_at}.`
      };
    }
    return { success: false, message: "Race condition detected: Lock acquisition lost to another writer." };
  }

  return { success: true, message: `Lock acquired for ${targetPath}. Expires at ${lock.expires_at}.` };
}

export function releaseLock(targetPath: string, babelRoot: string, runId: string): { success: boolean; message: string } {
  const lockPath = getWorkspaceLockPath(targetPath, babelRoot);
  const existing = readLock(lockPath);

  if (!existing) {
    return { success: true, message: "No lock existed for this path." };
  }

  if (existing.run_id !== runId) {
    return { success: false, message: `Refusing to release lock owned by Run: ${existing.run_id}.` };
  }

  rmSync(lockPath, { force: true });
  return { success: true, message: `Lock released for ${targetPath}.` };
}
