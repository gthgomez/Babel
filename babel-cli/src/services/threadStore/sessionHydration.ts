/**
 * Session hydration — inspect durable thread state and rebuild a ChatEngine
 * conversation from it.
 *
 * This is the single hydration seam shared by protocol resume and ordinary
 * submission so a resumed thread never runs on an empty engine. Durable typed
 * events are preferred (they preserve tool call/result pairing); history cells
 * are the secondary source.
 */

import type { ChatEngine } from '../../agent/chatEngine.js';
import { inspectSessionEventLogFromDir } from '../../agent/sessionEvents.js';
import { loadThreadEventLogFromDir, type ThreadEvent } from '../../agent/threadEventLog.js';
import { chatSessionDir } from '../../cli/runsLayout.js';
import type { BabelMode } from '../../executor/contracts.js';
import type { RestoreReport } from '../../executor/modeAdapters.js';
import { applyCellsToChatEngine, applyEventLogToChatEngine } from './conversationSync.js';
import { loadThreadCells } from './threadStore.js';

function maxTurnId(events: readonly ThreadEvent[]): number {
  let max = 0;
  for (const event of events) {
    if (typeof event.turn_id === 'number' && event.turn_id > max) max = event.turn_id;
  }
  return max;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Inspect what durable state exists for a thread and whether execution may
 * resume. Never invents state: an invalid log yields `resumable:false` with a
 * precise reason rather than an empty conversation.
 */
export function inspectSessionRestoreState(threadId: string, mode: BabelMode): RestoreReport {
  const sessionDir = chatSessionDir(threadId);

  const sessionEvents = inspectSessionEventLogFromDir(sessionDir, threadId);
  if (sessionEvents.kind === 'invalid') {
    return {
      threadId,
      mode,
      resumable: false,
      source: 'none',
      turnCount: 0,
      missing: ['session_events'],
      reason: `SESSION_EVENT_LOG_INVALID: ${message(sessionEvents.error)}`,
    };
  }

  try {
    const eventLog = loadThreadEventLogFromDir(sessionDir);
    if (eventLog && eventLog.events.length > 0) {
      return {
        threadId,
        mode,
        resumable: true,
        source: 'thread_event_log',
        turnCount: maxTurnId(eventLog.events),
        missing: [],
      };
    }
  } catch (err) {
    return {
      threadId,
      mode,
      resumable: false,
      source: 'none',
      turnCount: 0,
      missing: ['thread_event_log'],
      reason: message(err),
    };
  }

  const cells = loadThreadCells(threadId);
  if (cells.length > 0) {
    return {
      threadId,
      mode,
      resumable: true,
      source: 'history_cells',
      turnCount: cells[cells.length - 1]?.turn_id ?? 0,
      // Cells carry conversation text but not native tool call/result pairing.
      missing: ['native_tool_metadata'],
    };
  }

  // A thread with no durable conversation state is a fresh thread, not a
  // failed restore.
  return { threadId, mode, resumable: true, source: 'none', turnCount: 0, missing: [] };
}

/**
 * Rebuild the engine conversation from the source named by the report.
 * Callers must only invoke this for `resumable` reports.
 */
export function hydrateEngineFromRestore(engine: ChatEngine, report: RestoreReport): void {
  if (!report.resumable) return;
  const sessionDir = chatSessionDir(report.threadId);

  if (report.source === 'thread_event_log') {
    const log = loadThreadEventLogFromDir(sessionDir);
    if (log && log.events.length > 0) {
      applyEventLogToChatEngine(engine, log);
      return;
    }
  }

  const cells = loadThreadCells(report.threadId);
  if (cells.length > 0) {
    applyCellsToChatEngine(engine, cells);
  }
}
