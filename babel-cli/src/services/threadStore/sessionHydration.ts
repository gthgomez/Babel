/**
 * Session hydration — inspect durable thread state and rebuild a ChatEngine
 * conversation from it.
 *
 * This is the single hydration seam shared by protocol resume and ordinary
 * submission so a resumed thread never runs on an empty engine. Durable typed
 * events are preferred (they preserve tool call/result pairing); history cells
 * are the secondary source. The typed event log stores string turn ids, so the
 * numeric turn count is taken from history cells when present.
 *
 * D04/R0-4: the seam also owns canonical repository-root continuity validation.
 * Identity is established before any engine is materialized/admitted, from the
 * durable thread event log first, then the session-events
 * `user_submitted.project_root`, then a PERSISTED descriptor root (never a
 * synthesized one — R0-2). A provable mismatch fails closed; an absent or
 * unresolvable identity is degraded, never claimed verified. Roots are compared
 * by canonical realpath (plus an advisory filesystem fingerprint when present),
 * never lexically. `verified` means canonical-root continuity, not proven
 * physical-repository identity.
 */

import type { ChatEngine } from '../../agent/chatEngine.js';
import {
  inspectSessionEventLogFromDir,
  type SessionEventLog,
} from '../../agent/sessionEvents.js';
import {
  loadThreadEventLogFromDir,
  validateRepoIdentityOnResume,
  type RepoIdentityResumeResult,
  type ThreadEvent,
  type ThreadEventLog,
} from '../../agent/threadEventLog.js';
import { chatSessionDir } from '../../cli/runsLayout.js';
import type { BabelMode } from '../../executor/contracts.js';
import type { RestoreReport, RestoreRepoIdentity } from '../../executor/modeAdapters.js';
import { recoverCheckpointArtifacts } from '../../agent/liveSessionBridge.js';
import { applyCellsToChatEngine, applyEventLogToChatEngine } from './conversationSync.js';
import { loadThreadCells } from './threadStore.js';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Number of distinct turns recorded in a typed event log. */
function distinctTurnCount(events: readonly ThreadEvent[]): number {
  const ids = new Set<string>();
  for (const event of events) {
    if (typeof event.turn_id === 'string' && event.turn_id.length > 0) ids.add(event.turn_id);
  }
  return ids.size;
}

/** D04: last durable project_root recorded in session-events.jsonl, if any. */
function savedRepoRootFromSessionEvents(log: SessionEventLog | null): string | null {
  if (!log) return null;
  for (let i = log.events.length - 1; i >= 0; i--) {
    const event = log.events[i];
    if (event && event.kind === 'user_submitted' && event.project_root) {
      return event.project_root;
    }
  }
  return null;
}

/** Load the durable thread event log, treating an unreadable log as absent. */
function loadThreadEventLogSafely(sessionDir: string): ThreadEventLog | null {
  try {
    return loadThreadEventLogFromDir(sessionDir);
  } catch {
    return null;
  }
}

/**
 * D04 context for identity validation at the hydration seam.
 *
 * `currentRoot` is the root the caller is about to run in (descriptor or
 * requested root). `fallbackSavedRoot` supplies the durable root for
 * cells-only / legacy sessions with no event log; it is only consulted when
 * neither the event log nor session-events recorded an identity.
 */
export interface SessionRestoreIdentityContext {
  currentRoot: string;
  fallbackSavedRoot?: string | null;
}

/**
 * D04: validate physical repository identity for a thread about to hydrate.
 *
 * Single shared seam: protocol resume and ordinary submission both call this
 * before an engine is materialized. The durable thread event log is the primary
 * identity source; cells-only / legacy transcripts fall back to the
 * session-events `user_submitted.project_root`, then to the caller-registered
 * descriptor root. Never compares roots lexically.
 */
export function inspectThreadRepoIdentityOnHydration(
  threadId: string,
  currentRoot: string,
  fallbackSavedRoot: string | null = null,
): RepoIdentityResumeResult {
  const sessionDir = chatSessionDir(threadId);
  const eventLog = loadThreadEventLogSafely(sessionDir);
  const sessionEvents = inspectSessionEventLogFromDir(sessionDir, threadId);
  const savedFromSessionEvents =
    sessionEvents.kind === 'valid' ? savedRepoRootFromSessionEvents(sessionEvents.log) : null;
  return validateRepoIdentityOnResume(
    eventLog,
    currentRoot,
    savedFromSessionEvents ?? fallbackSavedRoot,
  );
}

/** D04: serializable identity subset carried on a `RestoreReport`. */
function toRestoreRepoIdentity(identity: RepoIdentityResumeResult): RestoreRepoIdentity {
  if (identity.ok) return { status: 'verified', savedRoot: null };
  return { status: identity.status, reason: identity.reason, savedRoot: identity.savedRoot };
}

/**
 * Inspect what durable state exists for a thread and whether execution may
 * resume. Never invents state: an invalid log yields `resumable:false` with a
 * precise reason rather than an empty conversation.
 *
 * When `identityContext` is supplied, physical repository identity is
 * established and carried on the report so callers can fail closed on a
 * mismatch before admitting an engine.
 */
export function inspectSessionRestoreState(
  threadId: string,
  mode: BabelMode,
  identityContext?: SessionRestoreIdentityContext,
): RestoreReport {
  const sessionDir = chatSessionDir(threadId);
  const cells = loadThreadCells(threadId);
  const cellsTurnCount = cells.length > 0 ? (cells[cells.length - 1]?.turn_id ?? 0) : 0;

  const sessionEvents = inspectSessionEventLogFromDir(sessionDir, threadId);

  // D04: establish identity before declaring any source resumable. A corrupt
  // event log is treated as absent for identity (identity is unproven, not
  // silently matched) while the source check below still fails closed on it.
  const repoIdentity = identityContext
    ? toRestoreRepoIdentity(
        inspectThreadRepoIdentityOnHydration(
          threadId,
          identityContext.currentRoot,
          identityContext.fallbackSavedRoot ?? null,
        ),
      )
    : undefined;
  const identityField = repoIdentity ? { repoIdentity } : {};

  if (sessionEvents.kind === 'invalid') {
    return {
      threadId,
      mode,
      resumable: false,
      source: 'none',
      turnCount: cellsTurnCount,
      missing: ['session_events'],
      reason: `SESSION_EVENT_LOG_INVALID: ${message(sessionEvents.error)}`,
      ...identityField,
    };
  }

  let eventLog: ThreadEventLog | null = null;
  let eventLogError: string | null = null;
  try {
    eventLog = loadThreadEventLogFromDir(sessionDir);
  } catch (err) {
    eventLogError = message(err);
  }

  if (eventLogError !== null) {
    return {
      threadId,
      mode,
      resumable: false,
      source: 'none',
      turnCount: cellsTurnCount,
      missing: ['thread_event_log'],
      reason: eventLogError,
      ...identityField,
    };
  }

  if (eventLog && eventLog.events.length > 0) {
    return {
      threadId,
      mode,
      resumable: true,
      source: 'thread_event_log',
      turnCount: cellsTurnCount > 0 ? cellsTurnCount : distinctTurnCount(eventLog.events),
      missing: [],
      ...identityField,
    };
  }

  if (cells.length > 0) {
    return {
      threadId,
      mode,
      resumable: true,
      source: 'history_cells',
      turnCount: cellsTurnCount,
      // Cells carry conversation text but not native tool call/result pairing.
      missing: ['native_tool_metadata'],
      ...identityField,
    };
  }

  // A thread with no durable conversation state is a fresh thread, not a
  // failed restore.
  return { threadId, mode, resumable: true, source: 'none', turnCount: 0, missing: [], ...identityField };
}

/**
 * D04: a provable durable repository-identity mismatch, surfaced so callers can
 * map it to their own fail-closed error without re-deriving the reason.
 */
export class RepoIdentityMismatchError extends Error {
  readonly code = 'repo_identity_mismatch';
  readonly savedRoot: string | null;

  constructor(threadId: string, reason: string, savedRoot: string | null) {
    super(
      `Cannot hydrate thread ${threadId}: repo_identity_mismatch: ${reason} ` +
        `(saved repository root: ${savedRoot ?? 'unknown'})`,
    );
    this.name = 'RepoIdentityMismatchError';
    this.savedRoot = savedRoot;
  }
}

/**
 * Rebuild the engine conversation from the source named by the report.
 *
 * Callers must only invoke this for `resumable` reports. D04: identity is
 * re-checked (fresh `identityContext`, else the report's identity) and a
 * provable mismatch throws before any history is applied, so the seam cannot be
 * bypassed by a caller that skipped the host-level check. An unknown identity
 * hydrates as degraded history rather than being claimed verified.
 */
export function hydrateEngineFromRestore(
  engine: ChatEngine,
  report: RestoreReport,
  identityContext?: SessionRestoreIdentityContext,
): void {
  const mismatch = identityContext
    ? (() => {
        const identity = inspectThreadRepoIdentityOnHydration(
          report.threadId,
          identityContext.currentRoot,
          identityContext.fallbackSavedRoot ?? null,
        );
        return !identity.ok && identity.status === 'mismatch'
          ? { reason: identity.reason, savedRoot: identity.savedRoot }
          : null;
      })()
    : report.repoIdentity?.status === 'mismatch'
      ? {
          reason: report.repoIdentity.reason ?? 'Repository root changed since last turn',
          savedRoot: report.repoIdentity.savedRoot,
        }
      : null;
  if (mismatch) {
    throw new RepoIdentityMismatchError(report.threadId, mismatch.reason, mismatch.savedRoot);
  }

  if (!report.resumable) return;
  const sessionDir = chatSessionDir(report.threadId);

  // R1 durability (6b-1): recover an interrupted checkpoint batch BEFORE any
  // durable artifact is read here. A merely staged/abandoned artifact is NEVER
  // current authority — without this, the thread event log could be loaded
  // pre-recovery and an uncommitted capsule would feed both the rebuilt
  // conversation and the installed-lineage validation below. Idempotent no-op
  // without a journal; a malformed journal fails closed (CHECKPOINT_JOURNAL_INVALID)
  // before any read, and the host never caches an engine that throws here.
  recoverCheckpointArtifacts(sessionDir);

  if (report.source === 'thread_event_log') {
    const log = loadThreadEventLogFromDir(sessionDir);
    if (!log || log.events.length === 0) {
      throw new Error(`Thread event log for ${report.threadId} is no longer available`);
    }
    applyEventLogToChatEngine(engine, log);
  } else if (report.source === 'history_cells') {
    const cells = loadThreadCells(report.threadId);
    if (cells.length === 0) {
      throw new Error(`History cells for ${report.threadId} are no longer available`);
    }
    applyCellsToChatEngine(engine, cells);
  }

  // R1 (6b-2): the protocol materialization path reconstructs the same session
  // lifecycle state as the primary resume entrypoint
  // (`createEngineFromEventLog`, conversationSync.ts) in the SAME repaired
  // ordering — durable observation membership FIRST (session-event restore
  // re-projects and persists the snapshot from it, so loading it afterwards
  // would erase the durable membership), then session-event restore (seq
  // continuity: without it `nextSeq` restarts at 0 and the next flush writes
  // duplicate seqs, bricking the durable log), then installed context
  // authority validated against the durable owner the host attached (owner
  // missing/stale owner fail closed to an inert checkpoint — no second
  // authority source). typeof guards keep injected stub engines on their
  // pre-fix fail-closed behavior: no seam → no restored state → no authority.
  if (typeof engine.loadObservationMembership === 'function') {
    engine.loadObservationMembership(sessionDir);
  }
  if (typeof engine.restoreSessionEventsFromDir === 'function') {
    engine.restoreSessionEventsFromDir(sessionDir);
  }
  if (typeof engine.hydrateInstalledContextAuthority === 'function') {
    engine.hydrateInstalledContextAuthority(sessionDir);
  }
}
