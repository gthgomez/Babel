import { spawnSync, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

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
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(-groupLeaderPid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH') return true
    }
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 10) })
  }
  return !isProcessAlive(groupLeaderPid)
}

/**
 * Kill a spawned process and its descendants.
 *
 * Windows uses the existing synchronous taskkill tree fallback. POSIX callers
 * must spawn the child detached so its PID is also the process-group ID.
 */
export function terminateChildTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
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
        if (result.status === 0 && !result.error) break
      } catch {
        // One bounded retry precedes the existing direct-child fallback.
      }
    }
    try {
      child.kill()
    } catch {
      // Best effort: the child may already have exited.
    }
    return
  }

  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // Fall through when the process group has already exited.
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Group may already be gone after SIGTERM.
    }
    try {
      child.kill('SIGKILL')
    } catch {
      // Best effort.
    }
    return
  }

  try {
    child.kill()
  } catch {
    // Best effort: the child may already have exited.
  }
}
