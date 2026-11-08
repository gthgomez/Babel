import { spawnSync, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
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

/** Poll until `pid` is no longer alive or the timeout elapses. */
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, 10) })
  }
  return !isProcessAlive(pid)
}

/**
 * Whether runnable work remains in the supervised group. POSIX normally uses
 * `kill(-pgid, 0)` so a dead leader with a live descendant stays visible. On
 * Linux, zombie-only groups count as settled because zombies cannot execute and
 * container PID 1 may retain their exit records indefinitely.
 */
export function isProcessGroupAlive(groupLeaderPid: number): boolean {
  if (process.platform === 'win32') {
    return isProcessAlive(groupLeaderPid)
  }
  if (process.platform === 'linux') {
    // kill(-pgid, 0) also succeeds when the group contains only zombies.
    // Zombies cannot run code or hold resources beyond their kernel exit
    // record, and in containers PID 1 may leave that record unreaped. Treat
    // them as terminated while continuing to fail closed for any runnable
    // process in the group.
    try {
      process.kill(-groupLeaderPid, 0)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ESRCH') return false
      return true
    }
    try {
      const pids = readdirSync('/proc')
      let inspectionUncertain = false
      for (const entry of pids) {
        if (!/^\d+$/.test(entry)) continue
        let stat: string
        try {
          stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
        } catch (error) {
          // A process may exit between listing /proc and reading its stat.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inspectionUncertain = true
          continue
        }
        const closeParen = stat.lastIndexOf(')')
        if (closeParen < 0) {
          inspectionUncertain = true
          continue
        }
        const fields = stat.slice(closeParen + 2).trim().split(/\s+/)
        const state = fields[0]
        const processGroup = Number(fields[2])
        if (processGroup !== groupLeaderPid) continue
        if (state !== 'Z' && state !== 'X' && state !== 'x') return true
      }
      if (inspectionUncertain) return true
      return false
    } catch {
      // Procfs may be unavailable or restricted. We already proved that the
      // kernel still sees the group, so retain the conservative live result.
      return true
    }
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
