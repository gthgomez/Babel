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
  /** P0-E: would have zero-write hard-stopped; session continued. */
  | 'zero_write_shadow'
  | 'stall_intervention'
  | 'stall_shadow_kill'
  /** P0-E: force-mutate would have hard-restricted tools. */
  | 'force_mutate_shadow'
  /** P0-E: read-thrash would have hard-restricted tools. */
  | 'read_thrash_shadow'
  /** P0-E: exploration fuse would have exhausted/restricted. */
  | 'exploration_shadow'
  /** P0-E: session-end rollup — shadow count + later_succeeded. */
  | 'policy_shadow_summary'
  | 'phase_gate_block'
  | 'plan_gate_block'
  | 'shell_soft_budget'
  | 'investigate_budget'
  | 'token_explosion'
  | 'budget_kill'
  /** W0: provider spend blocked until a signed readiness receipt verifies. */
  | 'readiness_block'
  | 'progress_policy'
  | 'progress_terminal'
  | 'failover'
  // ── Slice 2 harness-boundary taxonomy (stable kinds for causal thrash diagnosis)
  /** Model emitted a mutation-class tool intent. */
  | 'mutation_intent'
  /** Tool call failed schema/parse; may include repair. */
  | 'tool_parse_reject'
  | 'tool_parse_repair'
  /** Tool name alias normalization applied. */
  | 'tool_alias_normalize'
  /** Argument validation failed before dispatch. */
  | 'arg_validation_fail'
  /** Policy/approval denied a tool (distinct from phase_gate when authority is policy). */
  | 'policy_deny'
  /** Tool dispatch started/finished (detail may carry start|end). */
  | 'tool_dispatch'
  /** Filesystem apply of an edit/patch. */
  | 'write_apply'
  /** Write receipt recorded (pre-image / success). */
  | 'write_receipt'
  /** Git patch non-empty observation after writes. */
  | 'git_patch'
  /** Verifier authority accept/reject (detail carries reason). */
  | 'verifier_authority'
  /** Progress-controller intervention (nudge/restrict/lease). */
  | 'progress_controller'
  /** Budget/terminal arbitration (turn/cost/wall). */
  | 'budget_arbitration';

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
