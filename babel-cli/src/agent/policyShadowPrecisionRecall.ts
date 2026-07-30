/**
 * Offline precision/recall report for P0-E policy shadow interventions.
 *
 * Consumes `*_shadow` events and session-end `policy_shadow_summary` records
 * (from live sessions or fixtures) and reports would-kill vs later_succeeded /
 * later_progressed rates so operators can decide whether to re-enforce heuristics.
 *
 * Definitions (session-scoped; a session is closed by policy_shadow_summary):
 * - **would-kill session**: recorded ≥1 shadow intervention and a summary
 * - **later_succeeded**: coding-task gate pass (not mere mutation)
 * - **later_progressed**: any successful mutation
 * - **kill_precision**: fraction of would-kill sessions that did NOT later succeed
 *   (kill would have been justified re: coding gate)
 * - **false_kill_rate**: fraction of would-kill sessions that later succeeded
 *   (enforcing would have stopped a recoverable success)
 *
 * Pure offline — no live LLM. See plan P0-E acceptance: measured report before
 * re-enforce.
 */

import {
  SHADOW_INTERVENTION_KINDS,
  type ShadowKillPolicy,
} from './policyShadow.js';
import type { PolicyEvent, PolicyEventKind } from './policyEventLog.js';

export const SHADOW_PR_SCHEMA_VERSION = 1 as const;
export const SHADOW_PR_KIND = 'babel_policy_shadow_precision_recall' as const;

/** Map summary-friendly policy names for by-kind rollups. */
const KIND_TO_POLICY: Partial<Record<PolicyEventKind, ShadowKillPolicy | 'unknown'>> = {
  zero_write_shadow: 'zero_write',
  force_mutate_shadow: 'force_mutate',
  read_thrash_shadow: 'read_thrash',
  exploration_shadow: 'exploration_fuse',
  stall_shadow_kill: 'stall_kill',
};

export interface ShadowSessionRecord {
  /** Stable id for fixtures / reports (optional for live logs). */
  id?: string;
  /** Shadow intervention kinds in this session (order preserved). */
  intervention_kinds: PolicyEventKind[];
  later_succeeded: boolean;
  later_progressed: boolean;
  shadow_count: number;
  terminal_outcome?: string;
}

export interface KindPrecisionRecallStats {
  /** Sessions that included this intervention kind. */
  sessions: number;
  /** Total intervention events of this kind across sessions. */
  interventions: number;
  later_succeeded: number;
  later_failed: number;
  later_progressed: number;
  /** later_failed / sessions (null if sessions === 0). */
  kill_precision: number | null;
  /** later_succeeded / sessions (null if sessions === 0). */
  false_kill_rate: number | null;
  later_progressed_rate: number | null;
  policy?: ShadowKillPolicy | 'unknown';
}

export interface ShadowPrecisionRecallReport {
  schema_version: typeof SHADOW_PR_SCHEMA_VERSION;
  kind: typeof SHADOW_PR_KIND;
  generated_at: string;
  /** Whether input was synthetic fixtures (scorecard demo) vs caller-supplied. */
  source: 'fixtures' | 'sessions' | 'events';
  sessions_total: number;
  would_kill_sessions: number;
  later_succeeded: number;
  later_failed: number;
  later_progressed: number;
  /** later_succeeded / would_kill_sessions */
  later_succeeded_rate: number | null;
  /** later_progressed / would_kill_sessions */
  later_progressed_rate: number | null;
  /** later_failed / would_kill_sessions — justified would-kill vs coding gate */
  kill_precision: number | null;
  /** later_succeeded / would_kill_sessions — false kill if enforced */
  false_kill_rate: number | null;
  /** Sessions that progressed but did not pass coding gate. */
  progressed_not_succeeded: number;
  progressed_not_succeeded_rate: number | null;
  by_kind: Partial<Record<PolicyEventKind, KindPrecisionRecallStats>>;
  sessions: ShadowSessionRecord[];
  summary_lines: string[];
  /**
   * Advisory only: never auto-flip enforce. True when enough would-kill
   * sessions exist and false_kill_rate is at or below the soft threshold.
   */
  advisory_enforce_ready: boolean;
  advisory_notes: string[];
}

/** Soft default for advisory_enforce_ready (operators may choose stricter). */
export const ADVISORY_MAX_FALSE_KILL_RATE = 0.25;
/** Minimum would-kill sample size before advisory is meaningful. */
export const ADVISORY_MIN_WOULD_KILL_SESSIONS = 20;

function rate(num: number, den: number): number | null {
  if (den <= 0) return null;
  return num / den;
}

function formatRate(r: number | null): string {
  if (r == null) return 'n/a';
  return `${(r * 100).toFixed(1)}%`;
}

/**
 * Parse `policy_shadow_summary` detail line fields.
 * Detail format (from recordPolicyShadowSessionOutcome):
 *   shadow_count=N later_succeeded=0|1 later_progressed=0|1 mutation=… coding_pass=… outcome=…
 */
export function parsePolicyShadowSummaryDetail(detail: string | undefined): {
  shadow_count: number;
  later_succeeded: boolean;
  later_progressed: boolean;
  terminal_outcome?: string;
} {
  const d = detail ?? '';
  const countMatch = /\bshadow_count=(\d+)\b/.exec(d);
  const outcomeMatch = /\boutcome=(\S+)/.exec(d);
  return {
    shadow_count: countMatch ? Number(countMatch[1]) : 0,
    later_succeeded: /\blater_succeeded=1\b/.test(d),
    later_progressed: /\blater_progressed=1\b/.test(d),
    ...(outcomeMatch ? { terminal_outcome: outcomeMatch[1] } : {}),
  };
}

/**
 * Group a flat (or multi-session concatenated) policy event stream into
 * session records. Each `policy_shadow_summary` closes a session; shadow
 * interventions since the previous summary belong to that session.
 *
 * Orphan shadow events without a summary are dropped (incomplete sessions).
 */
export function groupSessionsFromPolicyEvents(
  events: readonly PolicyEvent[],
): ShadowSessionRecord[] {
  const sessions: ShadowSessionRecord[] = [];
  let buffer: PolicyEventKind[] = [];

  for (const e of events) {
    if (SHADOW_INTERVENTION_KINDS.has(e.kind)) {
      buffer.push(e.kind);
      continue;
    }
    if (e.kind === 'policy_shadow_summary') {
      const parsed = parsePolicyShadowSummaryDetail(e.detail);
      const intervention_kinds =
        buffer.length > 0
          ? [...buffer]
          : // Fallback when only summary is present: expand shadow_count as unknown kinds
            Array.from({ length: Math.max(parsed.shadow_count, 0) }, () => 'zero_write_shadow' as PolicyEventKind);
      sessions.push({
        intervention_kinds,
        later_succeeded: parsed.later_succeeded,
        later_progressed: parsed.later_progressed,
        shadow_count: parsed.shadow_count > 0 ? parsed.shadow_count : intervention_kinds.length,
        ...(parsed.terminal_outcome ? { terminal_outcome: parsed.terminal_outcome } : {}),
      });
      buffer = [];
    }
  }
  return sessions;
}

function emptyKindStats(kind: PolicyEventKind): KindPrecisionRecallStats {
  return {
    sessions: 0,
    interventions: 0,
    later_succeeded: 0,
    later_failed: 0,
    later_progressed: 0,
    kill_precision: null,
    false_kill_rate: null,
    later_progressed_rate: null,
    policy: KIND_TO_POLICY[kind] ?? 'unknown',
  };
}

function finalizeKindStats(s: KindPrecisionRecallStats): KindPrecisionRecallStats {
  return {
    ...s,
    kill_precision: rate(s.later_failed, s.sessions),
    false_kill_rate: rate(s.later_succeeded, s.sessions),
    later_progressed_rate: rate(s.later_progressed, s.sessions),
  };
}

/**
 * Core rollup: precision/recall-style metrics for would-kill sessions.
 */
export function buildShadowPrecisionRecallReport(input: {
  sessions?: readonly ShadowSessionRecord[];
  events?: readonly PolicyEvent[];
  /** Use built-in demo fixtures when no sessions/events provided. */
  useFixtures?: boolean;
  now?: Date;
  advisoryMaxFalseKillRate?: number;
  advisoryMinWouldKillSessions?: number;
}): ShadowPrecisionRecallReport {
  const generated_at = (input.now ?? new Date()).toISOString();
  const maxFk = input.advisoryMaxFalseKillRate ?? ADVISORY_MAX_FALSE_KILL_RATE;
  const minN = input.advisoryMinWouldKillSessions ?? ADVISORY_MIN_WOULD_KILL_SESSIONS;

  let source: ShadowPrecisionRecallReport['source'];
  let sessions: ShadowSessionRecord[];

  if (input.sessions && input.sessions.length > 0) {
    source = 'sessions';
    sessions = input.sessions.map((s) => ({ ...s, intervention_kinds: [...s.intervention_kinds] }));
  } else if (input.events && input.events.length > 0) {
    source = 'events';
    sessions = groupSessionsFromPolicyEvents(input.events);
  } else if (input.useFixtures !== false && (!input.sessions || input.sessions.length === 0) && !input.events) {
    // Default offline demo when nothing supplied (scorecard / empty CLI).
    source = 'fixtures';
    sessions = fixtureShadowPrecisionRecallSessions();
  } else {
    source = input.events ? 'events' : 'sessions';
    sessions = [];
  }

  let later_succeeded = 0;
  let later_failed = 0;
  let later_progressed = 0;
  let progressed_not_succeeded = 0;
  const by_kind: Partial<Record<PolicyEventKind, KindPrecisionRecallStats>> = {};

  for (const session of sessions) {
    if (session.later_succeeded) later_succeeded += 1;
    else later_failed += 1;
    if (session.later_progressed) later_progressed += 1;
    if (session.later_progressed && !session.later_succeeded) progressed_not_succeeded += 1;

    const kindsInSession = new Set(session.intervention_kinds);
    for (const kind of session.intervention_kinds) {
      const slot = by_kind[kind] ?? emptyKindStats(kind);
      slot.interventions += 1;
      by_kind[kind] = slot;
    }
    for (const kind of kindsInSession) {
      const slot = by_kind[kind] ?? emptyKindStats(kind);
      slot.sessions += 1;
      if (session.later_succeeded) slot.later_succeeded += 1;
      else slot.later_failed += 1;
      if (session.later_progressed) slot.later_progressed += 1;
      by_kind[kind] = slot;
    }
  }

  for (const kind of Object.keys(by_kind) as PolicyEventKind[]) {
    by_kind[kind] = finalizeKindStats(by_kind[kind]!);
  }

  const would_kill_sessions = sessions.length;
  const kill_precision = rate(later_failed, would_kill_sessions);
  const false_kill_rate = rate(later_succeeded, would_kill_sessions);
  const later_succeeded_rate = false_kill_rate;
  const later_progressed_rate = rate(later_progressed, would_kill_sessions);
  const progressed_not_succeeded_rate = rate(progressed_not_succeeded, would_kill_sessions);

  const advisory_notes: string[] = [];
  if (source === 'fixtures') {
    advisory_notes.push(
      'Source is offline fixtures — not live campaign data. Do not re-enforce from this alone.',
    );
  }
  if (would_kill_sessions < minN) {
    advisory_notes.push(
      `Sample size ${would_kill_sessions} < advisory minimum ${minN}; collect more shadow sessions before enforce.`,
    );
  }
  if (false_kill_rate != null && false_kill_rate > maxFk) {
    advisory_notes.push(
      `false_kill_rate ${formatRate(false_kill_rate)} exceeds advisory max ${formatRate(maxFk)}.`,
    );
  }
  if (would_kill_sessions === 0) {
    advisory_notes.push('No would-kill sessions in input; nothing to measure.');
  }

  const advisory_enforce_ready =
    source !== 'fixtures' &&
    would_kill_sessions >= minN &&
    false_kill_rate != null &&
    false_kill_rate <= maxFk;

  if (advisory_enforce_ready) {
    advisory_notes.push(
      'Advisory only: sample size and false_kill_rate meet soft gates — still require operator review before enforce.',
    );
  }

  const summary_lines = [
    `Policy shadow precision/recall: would_kill_sessions=${would_kill_sessions} source=${source}`,
    `kill_precision=${formatRate(kill_precision)} false_kill_rate=${formatRate(false_kill_rate)} ` +
      `later_progressed_rate=${formatRate(later_progressed_rate)}`,
    `later_succeeded=${later_succeeded} later_failed=${later_failed} later_progressed=${later_progressed} ` +
      `progressed_not_succeeded=${progressed_not_succeeded}`,
    `advisory_enforce_ready=${advisory_enforce_ready}`,
  ];

  return {
    schema_version: SHADOW_PR_SCHEMA_VERSION,
    kind: SHADOW_PR_KIND,
    generated_at,
    source,
    sessions_total: would_kill_sessions,
    would_kill_sessions,
    later_succeeded,
    later_failed,
    later_progressed,
    later_succeeded_rate,
    later_progressed_rate,
    kill_precision,
    false_kill_rate,
    progressed_not_succeeded,
    progressed_not_succeeded_rate,
    by_kind,
    sessions,
    summary_lines,
    advisory_enforce_ready,
    advisory_notes,
  };
}

/**
 * Deterministic offline fixtures for scorecard / unit tests.
 * Mix of justified kills, false kills, and progressed-but-unverified.
 */
export function fixtureShadowPrecisionRecallSessions(): ShadowSessionRecord[] {
  return [
    {
      id: 'fixture-justified-zero-write',
      intervention_kinds: ['zero_write_shadow'],
      later_succeeded: false,
      later_progressed: false,
      shadow_count: 1,
      terminal_outcome: 'BUDGET_EXHAUSTED',
    },
    {
      id: 'fixture-justified-stall',
      intervention_kinds: ['stall_shadow_kill', 'zero_write_shadow'],
      later_succeeded: false,
      later_progressed: false,
      shadow_count: 2,
      terminal_outcome: 'BLOCKED_POLICY',
    },
    {
      id: 'fixture-false-kill-coding-pass',
      intervention_kinds: ['zero_write_shadow'],
      later_succeeded: true,
      later_progressed: true,
      shadow_count: 1,
      terminal_outcome: 'VERIFIED_COMPLETE',
    },
    {
      id: 'fixture-progressed-not-succeeded',
      intervention_kinds: ['force_mutate_shadow', 'read_thrash_shadow'],
      later_succeeded: false,
      later_progressed: true,
      shadow_count: 2,
      terminal_outcome: 'UNVERIFIED_PATCH',
    },
    {
      id: 'fixture-justified-exploration',
      intervention_kinds: ['exploration_shadow'],
      later_succeeded: false,
      later_progressed: false,
      shadow_count: 1,
      terminal_outcome: 'INCOMPLETE',
    },
  ];
}

/** Human-readable report for CLI / status notes. */
export function formatShadowPrecisionRecallHuman(report: ShadowPrecisionRecallReport): string {
  const lines = [
    'Babel Policy Shadow Precision/Recall (P0-E)',
    `Generated: ${report.generated_at}`,
    `Source: ${report.source}`,
    '',
    '## Headline rates (would-kill sessions)',
    `- would_kill_sessions: ${report.would_kill_sessions}`,
    `- kill_precision: ${formatRate(report.kill_precision)} (did not later succeed)`,
    `- false_kill_rate: ${formatRate(report.false_kill_rate)} (later succeeded — bad if enforced)`,
    `- later_progressed_rate: ${formatRate(report.later_progressed_rate)}`,
    `- progressed_not_succeeded: ${report.progressed_not_succeeded} (${formatRate(report.progressed_not_succeeded_rate)})`,
    '',
    '## Counts',
    `- later_succeeded: ${report.later_succeeded}`,
    `- later_failed: ${report.later_failed}`,
    `- later_progressed: ${report.later_progressed}`,
    '',
    '## By intervention kind',
  ];

  const kinds = Object.keys(report.by_kind) as PolicyEventKind[];
  if (kinds.length === 0) {
    lines.push('- (none)');
  } else {
    for (const kind of kinds.sort()) {
      const k = report.by_kind[kind]!;
      lines.push(
        `- \`${kind}\` sessions=${k.sessions} interventions=${k.interventions} ` +
          `kill_precision=${formatRate(k.kill_precision)} false_kill_rate=${formatRate(k.false_kill_rate)} ` +
          `progressed=${formatRate(k.later_progressed_rate)}`,
      );
    }
  }

  lines.push('', '## Advisory');
  lines.push(`- enforce_ready: ${report.advisory_enforce_ready}`);
  for (const n of report.advisory_notes) {
    lines.push(`- ${n}`);
  }

  lines.push(
    '',
    '---',
    '_P0-E: measure before re-enforce. later_succeeded = coding-task gate; later_progressed = mutation._',
  );
  return lines.join('\n');
}

/**
 * Load events from a JSON array file or JSONL file contents (string).
 * Accepts PolicyEvent[] JSON or newline-delimited JSON objects.
 */
export function parsePolicyEventsFromText(text: string): PolicyEvent[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array of policy events');
    }
    return parsed as PolicyEvent[];
  }
  const events: PolicyEvent[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    events.push(JSON.parse(t) as PolicyEvent);
  }
  return events;
}
