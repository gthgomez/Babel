/**
 * One durable terminal truth for recovered/read-only surfaces.
 *
 * Recovery, `inspect outcome`, `session latest` and the TUI hydration path all
 * read the same artifacts but each used to classify them independently. This
 * module derives a single outcome/user-status pair from durable evidence only
 * (no filesystem mutation, no model inference) so those surfaces cannot report
 * a verified terminal as three different classifications (RT-10).
 *
 * A summary that claims success loses to a later durable `turn_ended` that
 * records a non-success terminal: the event log is append-only and carries
 * the newest turn, so a stale success summary must not project success/exit 0
 * (the dangerous direction). The arbitration exposes `disagreement` and is
 * otherwise one-directional by design.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectSessionEventLogFromDir } from '../agent/sessionEvents.js';
import { loadThreadEventLogFromDir } from '../agent/threadEventLog.js';
import {
  terminalOutcomeExitCode,
  type TerminalOutcome,
} from '../schemas/agentContracts.js';
import {
  userFacingStatusFromOutcome,
  type UserFacingStatus,
} from '../cli/userFacingStatus.js';

export type DurableTerminalSource =
  | 'terminal_status_summary'
  | 'session_events'
  | 'thread_events'
  | 'none';

export interface DurableTerminalTruth {
  /** Canonical outcome when the durable record establishes one. */
  outcome: TerminalOutcome | null;
  /** Legacy free-form status when no terminal outcome was recorded. */
  status: string | null;
  source: DurableTerminalSource;
  user_status: UserFacingStatus | 'ready';
  exit_code: number | null;
  /** True only for `VERIFIED_COMPLETE` / `NO_CHANGE_REQUIRED`. */
  success: boolean;
  /** The run reached a terminal record (success or failure). */
  finished: boolean;
  reason_code: string | null;
  changed_files: string[];
  /**
   * True when a stale success summary was overridden by a later durable
   * `turn_ended` event recording a non-success terminal. The projection
   * prefers the failure in that one direction; every other disagreement
   * keeps the summary's conservative classification.
   */
  disagreement: boolean;
}

// W02 canonical-guard handoff debt: this local membership list mirrors the
// canonical `TerminalOutcome` union in schemas/agentContracts.ts (a pure TS
// type cannot be enumerated at runtime). W02 owns that file; when they land a
// canonical runtime guard (e.g. a zod `TerminalOutcomeSchema`), import it
// here and delete this copy so the two definitions cannot drift.
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set([
  'VERIFIED_COMPLETE',
  'UNVERIFIED_PATCH',
  'BLOCKED_EXTERNAL',
  'BLOCKED_POLICY',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
  'INFRA_FAILURE',
  'AGENT_FAILURE',
  'NO_CHANGE_REQUIRED',
  'INVALID_TASK',
  'NEEDS_HUMAN_DECISION',
]);

/** `true` when the string is a canonical TerminalOutcome. */
export function isTerminalOutcome(value: unknown): value is TerminalOutcome {
  return typeof value === 'string' && TERMINAL_OUTCOMES.has(value);
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

interface FoundTerminal {
  outcome: TerminalOutcome | null;
  status: string | null;
  reason_code: string | null;
  source: DurableTerminalSource;
  changed_files: string[];
}

function fromTerminalSummary(runDir: string): FoundTerminal | null {
  const summary = readJson(join(runDir, 'terminal_status_summary.json'));
  if (!summary) return null;
  const explicitOutcome = isTerminalOutcome(summary['terminal_outcome'])
    ? summary['terminal_outcome']
    : isTerminalOutcome(summary['outcome'])
      ? summary['outcome']
      : null;
  const status = typeof summary['status'] === 'string' ? summary['status'] : null;
  if (!explicitOutcome && !status) return null;
  return {
    outcome: explicitOutcome,
    status,
    reason_code:
      typeof summary['reason_code'] === 'string'
        ? summary['reason_code']
        : typeof summary['reason_category'] === 'string'
          ? summary['reason_category']
          : null,
    source: 'terminal_status_summary',
    changed_files: stringArray(summary['changed_files']),
  };
}

function fromSessionEvents(runDir: string, expectedSessionId?: string): FoundTerminal | null {
  const result = inspectSessionEventLogFromDir(runDir, expectedSessionId);
  if (result.kind !== 'valid') return null;
  const ended = [...result.log.events]
    .reverse()
    .find((event) => event.kind === 'turn_ended');
  if (!ended || ended.kind !== 'turn_ended') return null;
  return {
    outcome: isTerminalOutcome(ended.outcome) ? ended.outcome : null,
    status: typeof ended.status === 'string' ? ended.status : null,
    reason_code: typeof ended.reason_code === 'string' ? ended.reason_code : null,
    source: 'session_events',
    changed_files: [],
  };
}

function fromThreadEvents(runDir: string): FoundTerminal | null {
  let log: ReturnType<typeof loadThreadEventLogFromDir>;
  try {
    log = loadThreadEventLogFromDir(runDir);
  } catch {
    return null;
  }
  if (!log) return null;
  const ended = [...log.events].reverse().find((event) => event.kind === 'turn_ended');
  if (!ended || ended.kind !== 'turn_ended') return null;
  return {
    outcome: isTerminalOutcome(ended.outcome) ? ended.outcome : null,
    status: typeof ended.status === 'string' ? ended.status : null,
    reason_code: typeof ended.reason_code === 'string' ? ended.reason_code : null,
    source: 'thread_events',
    changed_files: [],
  };
}

/**
 * Map a legacy status to a terminal outcome. Returns null when the status does
 * not establish an outcome (callers fall back to the legacy status text).
 */
export function terminalOutcomeFromLegacyStatus(
  status: string | null | undefined,
  changedFiles: readonly string[] = [],
): TerminalOutcome | null {
  if (isTerminalOutcome(status)) return status;
  if (!status) return null;
  const changed = changedFiles.length > 0;
  switch (status) {
    case 'COMPLETE':
    case 'COMPLETE_NO_MODIFICATION':
    case 'READ_ONLY_NO_MODIFICATION':
    case 'READ_ONLY_MODE_NO_EXECUTOR':
    case 'SWARM_NO_EXECUTOR_BOUND':
    case 'ANSWER_READY':
    case 'DO_COMPLETE':
    case 'FIX_COMPLETE':
    case 'SMALL_FIX_COMPLETE':
      // A completion status records "no further work", not that verification
      // passed. The only success outcomes are verified completion and an
      // explicit no-change result.
      return changed ? 'UNVERIFIED_PATCH' : 'NO_CHANGE_REQUIRED';
    case 'VERIFIER_FAILED':
    case 'VERIFIER_NOT_FOUND':
    case 'REQUIRED_VERIFIER_MISSING':
    case 'REQUIRED_VERIFIER_SKIPPED':
    case 'REQUIRED_VERIFIER_FAILED':
    case 'VERIFIER_CONTRACT_UNSATISFIED':
    case 'REPAIR_REPEATED_FAILURE':
    case 'REPAIR_MAX_ATTEMPTS_REACHED':
    case 'QA_REJECTED_MAX_LOOPS':
    case 'PARTIAL':
      return 'UNVERIFIED_PATCH';
    case 'EXACT_INSTRUCTION_DRIFT':
    case 'AMBIGUOUS_LITERAL_BINDING':
    case 'SHELL_COMMAND_DENIED':
    case 'WORKTREE_DIRTY_UNSAFE':
      return 'BLOCKED_POLICY';
    case 'MANUAL_BRIDGE_REQUIRED':
    case 'MANUAL_PLAN_INVALID':
      return 'NEEDS_HUMAN_DECISION';
    case 'EXECUTOR_HALTED':
    case 'SHELL_COMMAND_FAILED':
    case 'ROLLBACK_FAILED':
    case 'FATAL_ERROR':
    case 'EVIDENCE_LOOP_EXCEEDED':
    case 'SMALL_FIX_FAILED':
    case 'ASK_FAILED':
    case 'FAILED':
      return 'AGENT_FAILURE';
    default:
      return null;
  }
}

function classifiedUserStatus(truth: {
  outcome: TerminalOutcome | null;
  status: string | null;
}): UserFacingStatus | 'ready' {
  if (truth.outcome) return userFacingStatusFromOutcome(truth.outcome);
  const status = (truth.status ?? '').toUpperCase();
  if (!status) return 'ready';
  if (/FAILED|FAIL|HALTED|REJECTED|DENIED|DRIFT|UNSAFE|ROLLBACK_FAILED|BUDGET/.test(status)) {
    return 'failed';
  }
  if (/APPROVAL_REQUIRED|BLOCKED|MANUAL_BRIDGE_REQUIRED|NEEDS_MORE_CONTEXT|AMBIGUOUS/.test(status)) {
    return 'blocked';
  }
  if (/PARTIAL|UNVERIFIED/.test(status)) return 'not_verified';
  if (/COMPLETE|ANSWER_READY|READ_ONLY/.test(status)) return 'not_verified';
  return 'ready';
}

function isSuccessOutcome(outcome: TerminalOutcome | null): boolean {
  return outcome === 'VERIFIED_COMPLETE' || outcome === 'NO_CHANGE_REQUIRED';
}

/** Derive one terminal truth from the durable run artifacts. */
export function readDurableTerminalTruth(
  runDir: string,
  expectedSessionId?: string,
): DurableTerminalTruth {
  const summary = fromTerminalSummary(runDir);
  const found =
    summary ?? fromSessionEvents(runDir, expectedSessionId) ?? fromThreadEvents(runDir);
  if (!found) {
    return {
      outcome: null,
      status: null,
      source: 'none',
      user_status: 'ready',
      exit_code: null,
      success: false,
      finished: false,
      reason_code: null,
      changed_files: [],
      disagreement: false,
    };
  }
  let resolved = found;
  let disagreement = false;
  // A SUCCESS summary must not win wholesale over a later durable
  // `turn_ended` that records a non-success terminal: the summary is a
  // derived artifact, while the append-only event log carries the newest
  // durable turn. Arbitration is deliberately one-directional — a stale
  // success claim is the dangerous direction; a stale failure claim keeps
  // the summary's conservative classification. Absent event evidence
  // (invalid/missing log) leaves the summary unchanged, matching the
  // fail-closed absent-source behavior.
  const summaryOutcome =
    summary?.outcome ?? terminalOutcomeFromLegacyStatus(summary?.status ?? null, summary?.changed_files ?? []);
  if (summary !== null && isSuccessOutcome(summaryOutcome)) {
    const eventTerminal =
      fromSessionEvents(runDir, expectedSessionId) ?? fromThreadEvents(runDir);
    if (eventTerminal !== null) {
      const eventOutcome =
        eventTerminal.outcome ??
        terminalOutcomeFromLegacyStatus(eventTerminal.status, eventTerminal.changed_files);
      if (eventOutcome !== null && !isSuccessOutcome(eventOutcome)) {
        resolved = { ...eventTerminal, changed_files: summary.changed_files };
        disagreement = true;
      }
    }
  }
  const outcome =
    resolved.outcome ?? terminalOutcomeFromLegacyStatus(resolved.status, resolved.changed_files);
  const userStatus = classifiedUserStatus({ outcome, status: resolved.status });
  return {
    outcome,
    status: resolved.status,
    source: resolved.source,
    user_status: userStatus,
    exit_code: outcome ? terminalOutcomeExitCode(outcome) : userStatus === 'ready' ? null : 1,
    success: outcome === 'VERIFIED_COMPLETE' || outcome === 'NO_CHANGE_REQUIRED',
    finished: outcome !== null,
    reason_code: resolved.reason_code,
    changed_files: resolved.changed_files,
    disagreement,
  };
}
