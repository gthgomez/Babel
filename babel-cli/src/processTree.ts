import { spawnSync, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { getSafeEnv } from './utils/safeEnv.js'

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ESRCH') return false
    return true
  }
}

/** Poll until `pid` is no longer alive or the timeout elapses. */
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 10) })
  }
  return !isProcessAlive(pid)
}

type LinuxGroupSnapshot = { fingerprint: string; observedAt: number };
const linuxGroupSnapshots = new Map<number, LinuxGroupSnapshot>();

function processStatFields(path: string): { state: string; processGroup: number } | null {
  try {
    const stat = readFileSync(path, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const processGroup = Number(fields[2]);
    if (!fields[0] || !Number.isSafeInteger(processGroup)) return null;
    return { state: fields[0], processGroup };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'gone', processGroup: -1 };
    return null;
  }
}

export function isLinuxProcessGroupAliveInProc(groupLeaderPid: number, procRoot = '/proc'): boolean {
  let processIds: string[];
  try {
    processIds = readdirSync(procRoot).filter(entry => /^\d+$/.test(entry));
  } catch {
    linuxGroupSnapshots.delete(groupLeaderPid);
    return true;
  }

  const members: string[] = [];
  let uncertain = false;
  for (const pid of processIds) {
    const processStat = processStatFields(join(procRoot, pid, 'stat'));
    if (!processStat) {
      uncertain = true;
      continue;
    }
    if (processStat.state === 'gone') {
      // The pid was present in the directory snapshot but disappeared before
      // stat was read. Treat the observation as incomplete, not an empty slot.
      uncertain = true;
      continue;
    }
    if (processStat.processGroup !== groupLeaderPid) continue;
    let threadIds: string[];
    try {
      threadIds = readdirSync(join(procRoot, pid, 'task')).filter(entry => /^\d+$/.test(entry));
    } catch (error) {
      // A disappearing task group is a race; rescan before treating it as dead.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') uncertain = true;
      else uncertain = true;
      continue;
    }
    if (threadIds.length === 0) {
      uncertain = true;
      continue;
    }
    for (const tid of threadIds) {
      const threadStat = processStatFields(join(procRoot, pid, 'task', tid, 'stat'));
      if (!threadStat || threadStat.state === 'gone' || threadStat.processGroup !== groupLeaderPid) {
        // In particular, do not certify exit from a partial snapshot that
        // lost a thread between readdir and stat.
        uncertain = true;
        continue;
      }
      members.push(`${pid}:${tid}`);
      if (threadStat.state !== 'Z' && threadStat.state !== 'X' && threadStat.state !== 'x') {
        linuxGroupSnapshots.delete(groupLeaderPid);
        return true;
      }
    }
  }

  if (uncertain) {
    linuxGroupSnapshots.delete(groupLeaderPid);
    return true;
  }

  const fingerprint = members.sort().join('|');
  // A single /proc enumeration is not an atomic process-group snapshot. Require
  // the exact same all-dead thread set on a later poll before settling. The
  // wait loop polls at 10ms; a small stability window catches a fork racing the
  // previous directory enumeration. Any live/unreadable thread stays fail-closed.
  const previous = linuxGroupSnapshots.get(groupLeaderPid);
  const now = Date.now();
  if (previous?.fingerprint === fingerprint && now - previous.observedAt >= 20) {
    linuxGroupSnapshots.delete(groupLeaderPid);
    return false;
  }
  // Keep the start of this unchanged observation window. Replacing it at each
  // poll would make a 20ms threshold unreachable when polling every 10ms.
  linuxGroupSnapshots.set(groupLeaderPid, {
    fingerprint,
    observedAt: previous?.fingerprint === fingerprint ? previous.observedAt : now,
  });
  return true;
}

/**
 * Whether runnable work remains in the supervised group. POSIX normally uses
 * `kill(-pgid, 0)` so a dead leader with a live descendant stays visible. Linux
 * additionally inspects every thread because a thread-group leader can be a
 * zombie while workers remain runnable; settlement requires stable complete
 * procfs observations and fails closed when the snapshot is incomplete.
 */
export function isProcessGroupAlive(groupLeaderPid: number): boolean {
  if (process.platform === 'win32') {
    return isProcessAlive(groupLeaderPid)
  }
  if (process.platform === 'linux') {
    return isLinuxProcessGroupAliveInProc(groupLeaderPid)
  }
  try {
    process.kill(-groupLeaderPid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ESRCH') return false
    return true
  }
}

export async function waitForProcessGroupExit(groupLeaderPid: number, timeoutMs: number): Promise<boolean> {
  // Windows has no process-group signal semantics: libuv rejects negative PIDs
  // with EINVAL rather than ESRCH, so group probing would spin the full
  // timeout before the leader-only fallback ever fired. Probe the leader
  // directly there; POSIX keeps the group-wide ESRCH check.
  if (process.platform === 'win32') {
    const windowsDeadline = Date.now() + timeoutMs
    while (Date.now() < windowsDeadline) {
      if (!isProcessAlive(groupLeaderPid)) return true
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 10) })
    }
    return !isProcessAlive(groupLeaderPid)
  }
  if (process.platform === 'linux') {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!isProcessGroupAlive(groupLeaderPid)) return true
      await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 10) })
    }
    return !isProcessGroupAlive(groupLeaderPid)
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(-groupLeaderPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return true
    }
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 10) })
  }
  return !isProcessGroupAlive(groupLeaderPid)
}

/**
 * Kill a spawned process and its descendants.
 *
 * Windows uses the existing synchronous taskkill tree fallback. POSIX callers
 * must spawn the child detached so its PID is also the process-group ID.
 * treeKillAccepted reports a successful helper/signal attempt; it is not proof
 * that every process has physically exited.
 */
export function terminateChildTree(child: ChildProcess): { treeKillAccepted: boolean } {
  if (process.platform === 'win32' && child.pid) {
    let treeKillAccepted = false
    const windowsRoot = process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows'
    const taskkillPath = resolve(windowsRoot, 'System32', 'taskkill.exe')
    // A failed helper must not immediately sever the root ancestry: another
    // tree-kill attempt still needs that root to locate its descendants.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (child.exitCode != null || child.signalCode != null) break
      try {
        const result = spawnSync(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          env: getSafeEnv(),
          timeout: 1_500,
        })
        if (result.status === 0 && !result.error) { treeKillAccepted = true; break }
      } catch {
        // One bounded retry precedes the existing direct-child fallback.
      }
    }
    try {
      child.kill()
    } catch {
      // Best effort: the child may already have exited.
    }
    return { treeKillAccepted }
  }

  if (process.platform !== 'win32' && child.pid) {
    let treeKillAccepted = false
    try {
      process.kill(-child.pid, 'SIGTERM')
      treeKillAccepted = true
    } catch {
      // Fall through when the process group has already exited.
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
      treeKillAccepted = true
    } catch {
      // Group may already be gone after SIGTERM.
    }
    try {
      child.kill('SIGKILL')
    } catch {
      // Best effort.
    }
    return { treeKillAccepted }
  }

  try {
    child.kill()
  } catch {
    // Best effort: the child may already have exited.
  }
  // Without a pid there is no helper-confirmed tree to settle. Windows callers
  // treat the direct-child kill as the whole contract here; synthetic or
  // failed-to-spawn children must not be reported as an unconfirmed tree kill.
  return { treeKillAccepted: process.platform === 'win32' }
}
