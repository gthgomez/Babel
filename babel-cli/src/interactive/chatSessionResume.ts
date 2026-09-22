// ─── Chat Session Resume ────────────────────────────────────────────────────
// Shared resume path for /resume, startup SessionPicker, and tests.
// Dual-read: thread-store cells are authoritative when present; transcript.jsonl
// is the legacy fallback when no cells exist.

import { existsSync } from 'node:fs';

import { ChatEngine } from '../agent/chatEngine.js';
import { chatSessionDir, openSessionAdmissionStore, transcriptPath } from '../cli/runsLayout.js';
import {
  hydrateResumedThreadToScreen,
  loadThreadCells,
  threadStoreExists,
} from '../services/threadStore/index.js';
import {
  createEngineFromThreadCells,
  createEngineFromEventLog,
  applyEventLogToChatEngine,
} from '../services/threadStore/conversationSync.js';
import { loadThreadEventLogFromDir, validateRepoIdentityOnResume } from '../agent/threadEventLog.js';
import { SessionEventLogRestoreError } from '../agent/sessionEvents.js';
import { inspectSessionEventLogFromDir } from '../agent/sessionEvents.js';
import type { SessionEventLog } from '../agent/sessionEvents.js';
import type { ReplContext } from './context.js';
import {
  hydrateReplTurnsFromCells,
  hydrateReplTurnsFromChatTranscript,
  parseChatTranscriptFile,
} from './chatTranscriptHydration.js';

export interface ResumeChatSessionResult {
  ok: true;
  sessionId: string;
  turnCount: number;
  exchangeCount: number;
  source: 'thread_store' | 'transcript';
  /**
   * D04: set when the session's physical repository identity could not be
   * verified (no durable identity, or neither root resolvable). The session is
   * still resumed as inert history, but callers should surface a confirmation
   * notice rather than presenting it as safely resumed.
   */
  degraded?: boolean;
  /** D04: why the resume is degraded (present iff `degraded`). */
  degradedReason?: string;
}

export interface ResumeChatSessionFailure {
  ok: false;
  sessionId: string;
  reason: 'missing' | 'error' | 'repo_identity_mismatch' | 'repo_identity_unknown';
  message: string;
}

/** R0-3: explicit rebind when a session's durable repository identity is unknown. */
export interface ResumeChatSessionOptions {
  confirmUnknownIdentity?: boolean;
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

export type ResumeChatSessionOutcome = ResumeChatSessionResult | ResumeChatSessionFailure;

export async function resumeChatSession(
  ctx: ReplContext,
  sessionId: string,
  options: ResumeChatSessionOptions = {},
): Promise<ResumeChatSessionOutcome> {
  const hasThreadStore = threadStoreExists(sessionId);
  const txPath = transcriptPath(sessionId);
  const hasTranscript = existsSync(txPath);

  if (!hasThreadStore && !hasTranscript) {
    return {
      ok: false,
      sessionId,
      reason: 'missing',
      message: `Session "${sessionId}" not found (no thread store or transcript at ${txPath})`,
    };
  }

  // P05/P11: the resume store reference below is adopted by the REPL engine
  // lifecycle ONLY when one of the `ctx.chatEngine = …` assignments completes
  // (`resumeAdmissionAdopted`). Any throw between open and assignment (e.g.
  // `ChatEngine.restore` rethrowing a non-SESSION_EVENT_LOG_MISSING error, or
  // a construction failure inside a branch) must release the reference here,
  // or it would leak for process lifetime. Hoisted so the outer catch can see it.
  let resumeAdmission: ReturnType<typeof openSessionAdmissionStore> | null = null;
  let resumeAdmissionAdopted = false;

  try {
    const target = ctx.resolveCurrentTarget();
    const engineOptions = {
      task: `Resumed session ${sessionId}`,
      projectRoot: target.targetRoot,
      ...(ctx.state.model !== undefined ? { model: ctx.state.model } : {}),
      workspaceRoot: target.workspaceRoot ?? null,
      runtimeMode: 'tui' as const,
    };

    // Prefer durable thread event log (preserves tool call/result IDs)
    const sessionDir = chatSessionDir(sessionId);
    const sessionEvents = inspectSessionEventLogFromDir(sessionDir, sessionId);
    if (sessionEvents.kind === 'invalid') {
      throw new SessionEventLogRestoreError(
        'SESSION_EVENT_LOG_INVALID',
        `Cannot resume ${sessionId}: session-events.jsonl is invalid (${sessionEvents.error.message})`,
        { cause: sessionEvents.error },
      );
    }
    const eventLog = loadThreadEventLogFromDir(sessionDir);

    // D04: verify physical repository identity BEFORE any engine or execution
    // context is admitted (event-log branch) or history is hydrated as safely
    // resumed. The saved root comes from the durable thread event log first;
    // cells-only and legacy transcript sessions fall back to the session-events
    // `user_submitted.project_root`.
    const identity = validateRepoIdentityOnResume(
      eventLog,
      target.targetRoot,
      savedRepoRootFromSessionEvents(sessionEvents.kind === 'valid' ? sessionEvents.log : null),
    );
    if (!identity.ok && identity.status === 'mismatch') {
      // Fail closed: a durable identity exists and provably points elsewhere.
      return {
        ok: false,
        sessionId,
        reason: 'repo_identity_mismatch',
        message:
          `Cannot resume ${sessionId}: ${identity.reason} ` +
          `(saved repository root: ${identity.savedRoot}; current root: ${target.targetRoot})`,
      };
    }
    // status 'unknown' is not proof of identity: legacy sessions with no durable
    // repo identity (or an unresolvable current root) resume as history, but the
    // outcome is marked degraded so callers never claim verified identity.
    const degraded = !identity.ok
      ? { degraded: true as const, degradedReason: identity.reason }
      : {};

    // R0-3: unknown identity may not admit execution. Admitting the engine here
    // would let the next user message execute against a repository whose
    // historical identity is unproven. Require an explicit rebind/confirmation.
    if (!identity.ok && options.confirmUnknownIdentity !== true) {
      return {
        ok: false,
        sessionId,
        reason: 'repo_identity_unknown',
        message:
          `Cannot resume ${sessionId}: ${identity.reason}. ` +
          `Execution requires an explicit rebind — re-run ` +
          `/resume ${sessionId} --confirm-repo-identity to bind this session to ${target.targetRoot}.`,
      };
    }

    // P05/P11: reopen the durable admission store for this session — AFTER
    // the identity gates, so a refused resume never touches the store. This
    // single seam covers /resume, the in-command SessionPicker, the startup
    // picker, and BABEL_RESUME_SESSION (all converge here). Hydration inside
    // the construction paths below validates any existing checkpoint against
    // the durable owner of record BEFORE a new admission can mint a newer
    // generation. On `!admission.ok` degrade fail-closed: no store → no owner
    // → checkpoints stay inert. Owner of close: the ReplContext engine
    // lifecycle — each assignment below releases the previous engine's
    // reference first.
    const admission = openSessionAdmissionStore(sessionId);
    resumeAdmission = admission;
    const resumeOptions = {
      ...engineOptions,
      ...(admission.ok ? { admissionStore: admission.store } : {}),
    };

    if (eventLog && eventLog.events.length > 0) {
      ctx.chatEngine?.closeAdmissionStore?.();
      ctx.chatEngine = createEngineFromEventLog(resumeOptions, eventLog);
      resumeAdmissionAdopted = true;
      ctx.chatEngine.assignRunId(sessionId);
      // W2.2: session-events settle after run id assignment (same session dir).
      ctx.chatEngine.restoreSessionEventsFromDir(sessionDir);
      if (hasThreadStore) {
        hydrateResumedThreadToScreen(ctx, sessionId);
        const cells = loadThreadCells(sessionId);
        const { turnCount, exchangeCount } = hydrateReplTurnsFromCells(ctx, cells, {
          targetRoot: target.targetRoot,
          workspaceRoot: target.workspaceRoot ?? null,
        });
        ctx.saveSessionState();
        return {
          ok: true,
          sessionId,
          turnCount,
          exchangeCount,
          source: 'thread_store',
          ...degraded,
        };
      }
      const { turnCount, exchangeCount } = hydrateReplTurnsFromChatTranscript(ctx, {
        sessionId,
        transcriptPath: txPath,
        targetRoot: target.targetRoot,
        workspaceRoot: target.workspaceRoot ?? null,
      });
      ctx.saveSessionState();
      return {
        ok: true,
        sessionId,
        turnCount,
        exchangeCount,
        source: hasTranscript ? 'transcript' : 'thread_store',
        ...degraded,
      };
    }

    if (hasThreadStore) {
      const cells = loadThreadCells(sessionId);
      ctx.chatEngine?.closeAdmissionStore?.();
      ctx.chatEngine = createEngineFromThreadCells(sessionId, resumeOptions, cells);
      resumeAdmissionAdopted = true;
      // If an event log appears mid-session, keep cells as UI; still prefer empty event log path above
      hydrateResumedThreadToScreen(ctx, sessionId);
      const { turnCount, exchangeCount } = hydrateReplTurnsFromCells(ctx, cells, {
        targetRoot: target.targetRoot,
        workspaceRoot: target.workspaceRoot ?? null,
      });
      ctx.saveSessionState();
      return {
        ok: true,
        sessionId,
        turnCount,
        exchangeCount,
        source: 'thread_store',
        ...degraded,
      };
    }

    let engine: ChatEngine;
    try {
      engine = await ChatEngine.restore(sessionId, resumeOptions);
    } catch (err) {
      // Legacy transcript-only sessions may predate session-events.jsonl.
      // They remain resumable as conversation history; the durable event log
      // is rebuilt by subsequent turns rather than invented during resume.
      if (
        !hasTranscript ||
        !(err instanceof SessionEventLogRestoreError) ||
        err.code !== 'SESSION_EVENT_LOG_MISSING'
      ) {
        throw err;
      }
      engine = new ChatEngine({ ...resumeOptions, runId: sessionId });
      engine.replaceConversation(parseChatTranscriptFile(txPath));
    }
    // Attach event log if it lands after transcript restore
    const lateLog = loadThreadEventLogFromDir(chatSessionDir(sessionId));
    if (lateLog && lateLog.events.length > 0) {
      applyEventLogToChatEngine(engine, lateLog);
    }
    ctx.chatEngine?.closeAdmissionStore?.();
    ctx.chatEngine = engine;
    resumeAdmissionAdopted = true;
    const { turnCount, exchangeCount } = hydrateReplTurnsFromChatTranscript(ctx, {
      sessionId,
      transcriptPath: txPath,
      targetRoot: target.targetRoot,
      workspaceRoot: target.workspaceRoot ?? null,
    });
    if (threadStoreExists(sessionId)) {
      hydrateResumedThreadToScreen(ctx, sessionId);
    } else {
      const viewport = ctx.screenManager?.getHistoryCellViewport();
      viewport?.setCells([]);
    }
    ctx.saveSessionState();
    return {
      ok: true,
      sessionId,
      turnCount,
      exchangeCount,
      source: 'transcript',
      ...degraded,
    };
  } catch (err) {
    // I2: a throw before any assignment never handed the store to the REPL
    // lifecycle — release the reference, then surface the failure as before.
    if (resumeAdmission?.ok === true && !resumeAdmissionAdopted) {
      resumeAdmission.store.close();
    }
    return {
      ok: false,
      sessionId,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
