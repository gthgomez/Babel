/**
 * Policy event log — append-only record of every policy decision during a chat session.
 * Pure in-memory; persistence is handled by the caller (ChatEngine).
 */

export type PolicyEventKind =
  | 'force_mutate'
  | 'restrict_tools'
  | 'phase_change'
  | 'read_thrash_fuse'
  | 'exploration_nudge'
  | 'exploration_escalation'
  | 'exploration_exhausted'
  | 'zero_write_hard_stop'
  | 'stall_intervention'
  | 'stall_shadow_kill'
  | 'phase_gate_block'
  | 'plan_gate_block'
  | 'shell_soft_budget'
  | 'investigate_budget'
  | 'token_explosion'
  | 'budget_kill'
  | 'progress_policy'
  | 'progress_terminal'
  | 'failover';

export interface PolicyEvent {
  /** The turn number (0-based) when this event fired. */
  at_turn: number;
  kind: PolicyEventKind;
  /** Human-readable detail, e.g. "mode=mutate_only", "phase=investigate→mutate". */
  detail?: string;
  /** For gate blocks, the tool that was blocked. */
  tool?: string;
}

export interface PolicyEventCounts {
  total: number;
  byKind: Partial<Record<PolicyEventKind, number>>;
}

export class PolicyEventLog {
  private events: PolicyEvent[] = [];

  /** Record a policy event. */
  record(event: PolicyEvent): void {
    this.events.push(event);
  }

  /** Record multiple events at once (e.g. from a fuse burst). */
  recordAll(events: PolicyEvent[]): void {
    this.events.push(...events);
  }

  /** All events in order. */
  all(): ReadonlyArray<PolicyEvent> {
    return this.events;
  }

  /** Last N events for payload embedding (plan says last 50). */
  last(n: number): PolicyEvent[] {
    return this.events.slice(-n);
  }

  /** Count events by kind. */
  countsByKind(): PolicyEventCounts {
    const byKind: Record<string, number> = {};
    for (const e of this.events) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    }
    return { total: this.events.length, byKind };
  }

  /** Serialize to JSON array. */
  toJSON(): PolicyEvent[] {
    return [...this.events];
  }

  /** Serialize to JSONL (one object per line) for disk persistence. */
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length > 0 ? '\n' : '');
  }

  /** Number of events. */
  get length(): number {
    return this.events.length;
  }

  /** Clear all events (for session reset). */
  clear(): void {
    this.events = [];
  }
}

export default PolicyEventLog;
