/**
 * Crash-safe patch persistence.
 *
 * Write-through recovery log so patched work survives CLI crashes
 * (A06-class null-payload failures). Written synchronously via
 * `appendFileSync` so every mutation is durable before the next turn.
 */

import { appendFileSync } from 'node:fs';

/**
 * Append a mutation record to the recovery log at `logPath`.
 * Best-effort — never throws; callers treat this as fire-and-forget.
 */
export function appendPatchRecovery(
  logPath: string,
  action: string,
  target: string,
  content: string,
): void {
  try {
    const entry = [
      `--- ${new Date().toISOString()} ${action} ${target} ---`,
      content,
      '',
    ].join('\n');
    appendFileSync(logPath, entry, 'utf-8');
  } catch {
    // Best-effort; never fail the mutation for recovery logging
  }
}
