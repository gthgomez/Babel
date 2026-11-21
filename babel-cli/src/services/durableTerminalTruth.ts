/**
 * One durable terminal truth for recovered/read-only surfaces.
 *
 * Recovery, `inspect outcome`, `session latest` and the TUI hydration path all
 * read the same artifacts but each used to classify them independently. This
 * module selects the current turn from durable evidence only (no filesystem
 * mutation, no model inference) and derives one outcome/user-status pair so
 * those surfaces cannot report a verified terminal as three different
 * classifications (RT-10, BL-14).
 *
 * Selection rules:
 * - Turns are identified by the shared `turn_id` written to both journals.
 * - Admission order is the thread journal's append order (the engine admits a
 *   turn with `turn_started`); a generation number, when present, must not
 *   move backwards. Session submissions are matched by the same id.
 * - A newer turn with no matching terminal makes the run unfinished. An older
 *   terminal — summary, telemetry or journal — is never grafted onto it.
 * - Terminal records for the selected turn are compared. A success cannot
 *   override a non-success for the same turn, and a disagreement is reported.
 * - A journal that exists but cannot be validated makes the result corrupt and
 *   fail-closed: a success claim from the surviving journal is downgraded.
 * - Summary-only legacy runs keep their established behavior.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectSessionEventLogFromDir } from '../agent/sessionEvents.js';
import type { SessionEvent } from '../agent/sessionEvents.js';
import { loadThreadEventLogFromDir } from '../agent/threadEventLog.js';
import type { ThreadEvent } from '../agent/threadEventLog.js';
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

/** State of the currently selected turn, independent of its terminal result. */
export type DurableTurnState =
  | 'none'
  | 'submitted'
  | 'active'
  | 'terminal'
  | 'unknown';

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
  /** The selected turn reached a terminal record (success or failure). */
  finished: boolean;
  reason_code: string | null;
  changed_files: string[];
  /** Stable id of the newest admitted/submitted turn, when one exists. */
  turn_id: string | null;
  turn_state: DurableTurnState;
  /**
   * True when the durable records disagree, a journal is corrupt, or a newer
   * unadmitted submission exists. The projection always chooses the
   * conservative reading; this flag tells callers the evidence is not clean.
   */
  disagreement: boolean;
  /** True when a journal file exists but could not be validated. */
  corrupt: boolean;
  corrupt_sources: DurableTerminalSource[];
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

interface SummaryTerminal {
  outcome: TerminalOutcome | null;
  status: string | null;
  reason_code: string | null;
  changed_files: string[];
  /** Present only in newer summaries; legacy summaries are unbound. */
  turn_id: string | null;
}

function fromTerminalSummary(runDir: string): SummaryTerminal | null {
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
    changed_files: stringArray(summary['changed_files']),
    turn_id: typeof summary['turn_id'] === 'string' ? summary['turn_id'] : null,
  };
}

interface JournalTerminal {
  outcome: TerminalOutcome | null;
  status: string | null;
  reason_code: string | null;
  source: 'session_events' | 'thread_events';
}

interface TurnRecord {
  turnId: string;
  admitted: boolean;
  admissionSeq: number | null;
  admissionGeneration: number | null;
  sessionSubmittedSeq: number | null;
  threadEnd: JournalTerminal | null;
  threadEndSeq: number | null;
  sessionEnd: JournalTerminal | null;
  sessionEndSeq: number | null;
}

interface LoadedJournals {
  turns: Map<string, TurnRecord>;
  corruptSources: DurableTerminalSource[];
}

function turnFor(turns: Map<string, TurnRecord>, turnId: string): TurnRecord {
  const existing = turns.get(turnId);
  if (existing) return existing;
  const created: TurnRecord = {
    turnId,
    admitted: false,
    admissionSeq: null,
    admissionGeneration: null,
    sessionSubmittedSeq: null,
    threadEnd: null,
    threadEndSeq: null,
    sessionEnd: null,
    sessionEndSeq: null,
  };
  turns.set(turnId, created);
  return created;
}

function ordered(events: readonly { seq: number }[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if ((events[index]?.seq ?? -1) <= (events[index - 1]?.seq ?? -1)) return false;
  }
  return true;
}

function loadJournals(runDir: string, expectedSessionId?: string): LoadedJournals {
  const turns = new Map<string, TurnRecord>();
  const corruptSources: DurableTerminalSource[] = [];

  const session = inspectSessionEventLogFromDir(runDir, expectedSessionId);
  if (session.kind === 'invalid') corruptSources.push('session_events');
  if (session.kind === 'valid') {
    if (!ordered(session.log.events)) corruptSources.push('session_events');
    const events = [...session.log.events].sort((left, right) => left.seq - right.seq);
    for (const event of events) {
      const turnId = event.turn_id;
      if (typeof turnId !== 'string' || turnId.length === 0) continue;
      const turn = turnFor(turns, turnId);
      if (event.kind === 'user_submitted') {
        turn.sessionSubmittedSeq = Math.max(turn.sessionSubmittedSeq ?? -1, event.seq);
      }
      if (event.kind === 'turn_ended') {
        if (turn.sessionEndSeq === null || event.seq > turn.sessionEndSeq) {
          turn.sessionEnd = sessionTerminal(event);
          turn.sessionEndSeq = event.seq;
        }
      }
    }
  }

  try {
    const thread = loadThreadEventLogFromDir(runDir);
    if (thread) {
      if (!ordered(thread.events)) corruptSources.push('thread_events');
      const events = [...thread.events].sort((left, right) => left.seq - right.seq);
      let previousGeneration = -1;
      for (const event of events) {
        const turn = turnFor(turns, event.turn_id);
        if (event.kind === 'turn_started') {
          const generation =
            typeof event.ownership_generation === 'number' ? event.ownership_generation : null;
          if (
            generation !== null &&
            previousGeneration !== -1 &&
            generation < previousGeneration
          ) {
            corruptSources.push('thread_events');
          }
          if (generation !== null) previousGeneration = Math.max(previousGeneration, generation);
          turn.admitted = true;
          if (turn.admissionSeq === null || event.seq > turn.admissionSeq) {
            turn.admissionSeq = event.seq;
          }
          turn.admissionGeneration = generation ?? turn.admissionGeneration;
        }
        if (event.kind === 'turn_ended') {
          if (turn.threadEndSeq === null || event.seq > turn.threadEndSeq) {
            turn.threadEnd = threadTerminal(event);
            turn.threadEndSeq = event.seq;
          }
        }
      }
    }
  } catch {
    corruptSources.push('thread_events');
  }

  return {
    turns,
    corruptSources: [...new Set(corruptSources)],
  };
}

function sessionTerminal(event: Extract<SessionEvent, { kind: 'turn_ended' }>): JournalTerminal {
  return {
    outcome: isTerminalOutcome(event.outcome) ? event.outcome : null,
    status: typeof event.status === 'string' ? event.status : null,
    reason_code: typeof event.reason_code === 'string' ? event.reason_code : null,
    source: 'session_events',
  };
}

function threadTerminal(event: Extract<ThreadEvent, { kind: 'turn_ended' }>): JournalTerminal {
  return {
    outcome: isTerminalOutcome(event.outcome) ? event.outcome : null,
    status: typeof event.status === 'string' ? event.status : null,
    reason_code: typeof event.reason_code === 'string' ? event.reason_code : null,
    source: 'thread_events',
  };
}

function outcomeOf(terminal: JournalTerminal | SummaryTerminal | null): TerminalOutcome | null {
  if (!terminal) return null;
  return (
    terminal.outcome ??
    terminalOutcomeFromLegacyStatus(terminal.status, 'changed_files' in terminal ? terminal.changed_files : [])
  );
}

function isSuccessOutcome(outcome: TerminalOutcome | null): boolean {
  return outcome === 'VERIFIED_COMPLETE' || outcome === 'NO_CHANGE_REQUIRED';
}

type SelectedTurn = {
  turn: TurnRecord | null;
  /** A session submission that was never admitted and is newer than admission. */
  unadmittedNewer: boolean;
};

function selectTurn(journals: LoadedJournals): SelectedTurn {
  const all = [...journals.turns.values()];
  const admitted = all
    .filter((turn) => turn.admitted)
    .sort((left, right) => (left.admissionSeq ?? 0) - (right.admissionSeq ?? 0));
  const newestAdmitted = admitted.at(-1);
  if (newestAdmitted) {
    const admittedSubmissions = admitted
      .map((turn) => turn.sessionSubmittedSeq)
      .filter((seq): seq is number => seq !== null);
    const newestAdmittedSubmission =
      admittedSubmissions.length > 0 ? Math.max(...admittedSubmissions) : null;
    const unadmitted = all
      .filter(
        (turn) =>
          !turn.admitted &&
          turn.sessionSubmittedSeq !== null &&
          newestAdmittedSubmission !== null &&
          turn.sessionSubmittedSeq > newestAdmittedSubmission,
      )
      .sort((left, right) => (left.sessionSubmittedSeq ?? 0) - (right.sessionSubmittedSeq ?? 0));
    const newerUnadmitted = unadmitted.at(-1);
    if (newerUnadmitted) return { turn: newerUnadmitted, unadmittedNewer: true };
    return { turn: newestAdmitted, unadmittedNewer: false };
  }
  const submitted = all
    .filter((turn) => turn.sessionSubmittedSeq !== null)
    .sort((left, right) => (left.sessionSubmittedSeq ?? 0) - (right.sessionSubmittedSeq ?? 0));
  const sessionOnly = submitted.at(-1);
  if (sessionOnly) return { turn: sessionOnly, unadmittedNewer: false };
  // Thread activity without a start record (e.g. a truncated prefix) is still
  // a turn; report it as unknown rather than borrowing an older terminal.
  const anyThread = all.sort(
    (left, right) => (left.threadEndSeq ?? -1) - (right.threadEndSeq ?? -1),
  ).at(-1);
  return { turn: anyThread ?? null, unadmittedNewer: false };
}

function settledTerminal(turn: TurnRecord): {
  terminal: JournalTerminal | null;
  disagreement: boolean;
  source: DurableTerminalSource;
} {
  const thread = turn.threadEnd;
  const session = turn.sessionEnd;
  if (thread && session) {
    const threadOutcome = outcomeOf(thread);
    const sessionOutcome = outcomeOf(session);
    const threadSuccess = isSuccessOutcome(threadOutcome);
    const sessionSuccess = isSuccessOutcome(sessionOutcome);
    let chosen = thread;
    let disagreement = false;
    if (threadSuccess && !sessionSuccess) {
      chosen = session;
      disagreement = true;
    } else if (!threadSuccess && sessionSuccess) {
      chosen = thread;
      disagreement = true;
    } else if (
      threadOutcome === null ||
      sessionOutcome === null ||
      threadOutcome !== sessionOutcome
    ) {
      // An unclassifiable terminal is still a terminal. It must not be
      // treated as absent evidence that restores the other journal's success.
      disagreement = true;
    }
    return { terminal: chosen, disagreement, source: chosen.source };
  }
  if (thread) return { terminal: thread, disagreement: false, source: 'thread_events' };
  if (session) return { terminal: session, disagreement: false, source: 'session_events' };
  return { terminal: null, disagreement: false, source: 'none' };
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
  if (/PARTIAL|UNVERIFIED|INTERRUPTED|SUBMITTED|UNREADABLE/.test(status)) return 'not_verified';
  if (/COMPLETE|ANSWER_READY|READ_ONLY/.test(status)) return 'not_verified';
  return 'ready';
}

function unresolvedTruth(
  source: DurableTerminalSource,
  turnId: string | null,
  turnState: DurableTurnState,
  status: string,
  disagreement: boolean,
  corruptSources: DurableTerminalSource[],
): DurableTerminalTruth {
  return {
    outcome: null,
    status,
    source,
    user_status: classifiedUserStatus({ outcome: null, status }),
    exit_code: null,
    success: false,
    finished: false,
    reason_code: null,
    changed_files: [],
    turn_id: turnId,
    turn_state: turnState,
    disagreement: disagreement || corruptSources.length > 0,
    corrupt: corruptSources.length > 0,
    corrupt_sources: corruptSources,
  };
}

/** Derive one terminal truth from the durable run artifacts. */
export function readDurableTerminalTruth(
  runDir: string,
  expectedSessionId?: string,
): DurableTerminalTruth {
  const summary = fromTerminalSummary(runDir);
  const journals = loadJournals(runDir, expectedSessionId);
  const { turn: selected, unadmittedNewer } = selectTurn(journals);
  const turnCount = journals.turns.size;

  if (!selected) {
    if (journals.corruptSources.length > 0) {
      return unresolvedTruth(
        'none',
        null,
        'unknown',
        'UNREADABLE_STATE',
        true,
        journals.corruptSources,
      );
    }
    if (!summary) {
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
        turn_id: null,
        turn_state: 'none',
        disagreement: false,
        corrupt: false,
        corrupt_sources: [],
      };
    }
    // Legacy run: a terminal summary with no event journal is still the only
    // durable record. Keep the established projection (no newer turn exists).
    const outcome = outcomeOf(summary);
    const userStatus = classifiedUserStatus({ outcome, status: summary.status });
    return {
      outcome,
      status: summary.status,
      source: 'terminal_status_summary',
      user_status: userStatus,
      exit_code: outcome ? terminalOutcomeExitCode(outcome) : userStatus === 'ready' ? null : 1,
      success: isSuccessOutcome(outcome),
      finished: true,
      reason_code: summary.reason_code,
      changed_files: summary.changed_files,
      turn_id: summary.turn_id,
      turn_state: 'none',
      disagreement: journals.corruptSources.length > 0,
      corrupt: journals.corruptSources.length > 0,
      corrupt_sources: journals.corruptSources,
    };
  }

  const settled = settledTerminal(selected);
  let resolved: (JournalTerminal | SummaryTerminal) | null = settled.terminal;
  let disagreement = settled.disagreement || unadmittedNewer;
  let source: DurableTerminalSource = settled.terminal ? settled.source : 'none';

  const summaryOutcome = summary ? outcomeOf(summary) : null;
  const selectedOutcome = settled.terminal ? outcomeOf(settled.terminal) : null;
  // An unbound summary may only contribute to the turn it demonstrably agrees
  // with. A count heuristic alone can graft an older turn's paths onto a newer
  // failure (BL-14 review F2).
  const summaryBound = summary !== null && (
    summary.turn_id !== null
      ? summary.turn_id === selected.turnId
      : turnCount <= 1 &&
        settled.terminal !== null &&
        summaryOutcome !== null &&
        selectedOutcome !== null &&
        summaryOutcome === selectedOutcome
  );

  const summaryConflicts = summary !== null && !summaryBound && (
    (summaryOutcome !== null && selectedOutcome !== null && summaryOutcome !== selectedOutcome) ||
    (summaryOutcome !== null && settled.terminal === null)
  );

  if (resolved && summary && summaryBound) {
    const resolvedOutcome = outcomeOf(resolved);
    const summaryOutcome = outcomeOf(summary);
    if (isSuccessOutcome(resolvedOutcome) && !isSuccessOutcome(summaryOutcome)) {
      // A durable summary recording a non-success is conservative evidence.
      resolved = summary;
      source = 'terminal_status_summary';
      disagreement = true;
    } else if (!isSuccessOutcome(resolvedOutcome) && isSuccessOutcome(summaryOutcome)) {
      disagreement = true;
    } else if (
      resolvedOutcome !== null &&
      summaryOutcome !== null &&
      resolvedOutcome !== summaryOutcome
    ) {
      disagreement = true;
    } else if (!disagreement) {
      // Agreeing records keep the summary source and its changed-file record,
      // matching the established projection for a normally settled run.
      resolved = summary;
      source = 'terminal_status_summary';
    }
  } else if (!resolved && summary && summary.turn_id !== null && summary.turn_id === selected.turnId) {
    resolved = summary;
    source = 'terminal_status_summary';
  } else if (!resolved && summary && isSuccessOutcome(outcomeOf(summary)) && turnCount > 1) {
    // An unbound success summary cannot be attached to a newer multi-turn
    // state; record the conflict but do not project it.
    disagreement = true;
  }

  if (journals.corruptSources.length > 0) {
    // A journal that could not be validated may hide a newer failure. The
    // conservative reading is never a success claim.
    const resolvedOutcome = outcomeOf(resolved);
    if (resolved && isSuccessOutcome(resolvedOutcome)) {
      return {
        ...unresolvedTruth(
          source,
          selected.turnId,
          'unknown',
          'UNREADABLE_STATE',
          true,
          journals.corruptSources,
        ),
        changed_files: summaryBound ? (summary?.changed_files ?? []) : [],
      };
    }
  }

  if (!resolved) {
    const state: DurableTurnState = selected.admitted ? 'active' : 'submitted';
    return unresolvedTruth(
      selected.admitted ? 'thread_events' : 'session_events',
      selected.turnId,
      state,
      selected.admitted ? 'INTERRUPTED' : 'SUBMITTED',
      disagreement,
      journals.corruptSources,
    );
  }

  const outcome = outcomeOf(resolved);
  let userStatus = classifiedUserStatus({ outcome, status: resolved.status });
  if (userStatus === 'ready') {
    // A terminal record whose status is unclassifiable is not "ready".
    userStatus = 'not_verified';
  }
  const changedFiles =
    resolved === summary
      ? summary.changed_files
      : summaryBound
        ? (summary?.changed_files ?? [])
        : [];
  return {
    outcome,
    status: resolved.status,
    source,
    user_status: userStatus,
    exit_code: outcome ? terminalOutcomeExitCode(outcome) : 1,
    success: isSuccessOutcome(outcome),
    finished: true,
    reason_code: resolved.reason_code,
    changed_files: changedFiles,
    turn_id: selected.turnId,
    turn_state: 'terminal',
    disagreement: disagreement || summaryConflicts || journals.corruptSources.length > 0,
    corrupt: journals.corruptSources.length > 0,
    corrupt_sources: journals.corruptSources,
  };
}
