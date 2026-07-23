import type { SwePlan } from '../schemas/agentContracts.js';
import { getWorkspaceLockPath, isLockActive, readLock } from '../utils/locking.js';

/**
 * Checks if any planned mutating actions conflict with existing workspace locks.
 */
export async function checkWorkspaceLocks(
  plan: SwePlan,
  babelRoot: string,
): Promise<{ halted: boolean; reason?: string }> {
  for (const step of plan.minimal_action_set) {
    // Only check locks for file-mutating operations.
    if (step.tool === 'file_write' || step.tool === 'shell_exec') {
      const lockPath = getWorkspaceLockPath(step.target, babelRoot);
      const lock = readLock(lockPath);

      if (lock && isLockActive(lock)) {
        return {
          halted: true,
          reason: `Workspace lock conflict: "${step.target}" is locked by ${lock.agent_id} (Run: ${lock.run_id}) until ${lock.expires_at}.`,
        };
      }
    }
  }

  return { halted: false };
}
