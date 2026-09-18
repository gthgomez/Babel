import { spawnSync, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

import { getSafeEnv } from './utils/safeEnv.js'

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
    try {
      spawnSync(taskkillPath, ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        env: getSafeEnv(),
        timeout: 1_500,
      })
    } catch {
      // Fall through to direct child termination.
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
