/**
 * Blocked-attempt ledger — append-only record of every blocked/failed mutation
 * attempt during a chat session. Pure in-memory; persistence is handled by the
 * caller (ChatEngine).
 *
 * Reason codes align with A2 policy event kinds where possible:
 *   phase-gate — blocked by phase-tool gate (evaluatePhaseToolGate)
 *   plan-gate  — blocked by plan-then-execute gate (evaluatePlanThenExecuteGate)
 *   policy     — blocked by executeActionWithPolicy (restrict_tools / force_mutate only)
 *   str_replace_miss — old_str not found or ambiguous in target file
 *   path       — file/target path error (not found, out of range, etc.)
 *   other      — any other blocked/failed mutation not covered above
 */

export type BlockedAttemptReason =
  | 'phase-gate'
  | 'plan-gate'
  | 'policy'
  | 'str_replace_miss'
  | 'path'
  | 'other';

export interface BlockedAttempt {
  /** The turn number (0-based) when this attempt was blocked. */
  turn: number;
  /** Tool name that was attempted (e.g. "str_replace", "write_file"). */
  tool: string;
  /** Target path or command that the tool was acting on. */
  target: string;
  /** Reason the attempt was blocked. */
  reason: BlockedAttemptReason;
  /** Optional human-readable detail (e.g. "no write tools in investigate phase"). */
  detail?: string;
}

export interface BlockedAttemptCounts {
  total: number;
  byReason: Record<BlockedAttemptReason, number>;
}

export class BlockedAttemptLedger {
  private attempts: BlockedAttempt[] = [];

  /** Record a blocked attempt. */
  record(entry: BlockedAttempt): void {
    this.attempts.push(entry);
  }

  /** Record multiple blocked attempts at once. */
  recordAll(entries: BlockedAttempt[]): void {
    this.attempts.push(...entries);
  }

  /** All blocked attempts in order. */
  all(): ReadonlyArray<BlockedAttempt> {
    return this.attempts;
  }

  /** Count attempts by reason. */
  countsByReason(): BlockedAttemptCounts {
    const byReason: Record<string, number> = {};
    for (const a of this.attempts) {
      byReason[a.reason] = (byReason[a.reason] ?? 0) + 1;
    }
    return {
      total: this.attempts.length,
      byReason: byReason as Record<BlockedAttemptReason, number>,
    };
  }

  /**
   * Top-N blocked reasons for surface on failure card / gate messages.
   * Returns sorted descending by count.
   */
  topReasons(n: number = 5): Array<{ reason: string; count: number }> {
    const counts = this.countsByReason();
    return Object.entries(counts.byReason)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
      .map(([reason, count]) => ({ reason, count }));
  }

  /**
   * Human-readable gate summary line, e.g.
   * "3 phase-gate blocks on str_replace, 1 policy block on write_file"
   */
  summaryForGate(): string | null {
    if (this.attempts.length === 0) return null;
    const top = this.topReasons(3);
    const parts = top.map((r) => `${r.reason}×${r.count}`);
    return `Blocked attempts: ${parts.join(', ')}`;
  }

  /** Serialize to JSON array. */
  toJSON(): BlockedAttempt[] {
    return [...this.attempts];
  }

  /** Number of blocked attempts. */
  get length(): number {
    return this.attempts.length;
  }

  /** Clear all attempts (for session reset). */
  clear(): void {
    this.attempts = [];
  }
}

export default BlockedAttemptLedger;
