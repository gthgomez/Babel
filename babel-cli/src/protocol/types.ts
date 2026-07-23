/**
 * Babel app-server protocol — core identifiers, enums, and stream event shapes.
 *
 * Phase D1 sketch only. See ADR-010 and `src/protocol/messages.ts` for the
 * full request/response catalog.
 */

import type { HistoryCellRecord } from '../ui/historyCells/types.js';

/** Wire protocol version — bump on breaking catalog changes. */
export const BABEL_PROTOCOL_VERSION = '1.0.0' as const;

export type ThreadId = string;
export type CellId = string;

/** JSON-RPC methods invoked by clients (expect a response). */
export type BabelProtocolMethod =
  | 'thread.create'
  | 'thread.resume'
  | 'turn.submit'
  | 'turn.cancel'
  | 'history.lookup';

/** Server-initiated JSON-RPC notifications (no response `id`). */
export type BabelProtocolNotification = 'turn.event' | 'cell.committed';

export const BABEL_PROTOCOL_METHODS: readonly BabelProtocolMethod[] = [
  'thread.create',
  'thread.resume',
  'turn.submit',
  'turn.cancel',
  'history.lookup',
] as const;

export const BABEL_PROTOCOL_NOTIFICATIONS: readonly BabelProtocolNotification[] = [
  'turn.event',
  'cell.committed',
] as const;

/**
 * Application error codes (-32000 … -32099).
 * Standard JSON-RPC codes (-32700 … -32603) are also valid on the wire.
 */
export enum BabelProtocolErrorCode {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,

  THREAD_NOT_FOUND = -32000,
  TURN_IN_PROGRESS = -32001,
  TURN_NOT_IN_PROGRESS = -32002,
  THREAD_EXISTS = -32003,
  PROJECT_ROOT_MISMATCH = -32004,
  CELL_NOT_FOUND = -32005,
}

/** Token/cost summary on turn completion — mirrors `SessionUsageSummary`. */
export interface TurnUsageSummary {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  modelBreakdown: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      costUSD: number;
    }
  >;
}

/**
 * Normalized turn stream events — 1:1 with `ChatEvent` from `chatEngine.ts`.
 * D2 clients can dispatch these like `consumeChatStream` does today.
 */
export type TurnStreamEvent =
  | { type: 'thinking' }
  | { type: 'answer_chunk'; text: string }
  | { type: 'tool_start'; tool: string; target: string }
  | { type: 'tool_complete'; tool: string; target: string; detail?: string }
  | { type: 'thought'; text: string }
  | { type: 'sub_agent_start'; id: string; label: string; model?: string }
  | { type: 'sub_agent_complete'; id: string; summary: string; tokens?: number }
  | { type: 'sub_agent_failed'; id: string; error: string }
  | {
      type: 'file_changed';
      path: string;
      additions: number;
      deletions: number;
      content?: string;
    }
  | { type: 'done'; answer: string; usage: TurnUsageSummary }
  | { type: 'failed'; error: string }
  | { type: 'cancelled' };

// ─── Request params ───────────────────────────────────────────────────────────

export interface ThreadCreateParams {
  project_root: string;
  task?: string;
  model?: string;
}

export interface ThreadResumeParams {
  thread_id: ThreadId;
  project_root?: string;
}

export interface TurnSubmitParams {
  thread_id: ThreadId;
  message: string;
}

export interface TurnCancelParams {
  thread_id: ThreadId;
}

export interface HistoryLookupParams {
  thread_id: ThreadId;
  cell_id?: CellId;
  turn_id?: number;
  limit?: number;
  cursor?: string;
}

// ─── Request results ──────────────────────────────────────────────────────────

export interface ThreadCreateResult {
  thread_id: ThreadId;
}

export interface ThreadResumeResult {
  thread_id: ThreadId;
  /** Highest committed turn index, or 0 for an empty thread. */
  turn_count: number;
}

export interface TurnSubmitResult {
  thread_id: ThreadId;
  turn_id: number;
}

export interface TurnCancelResult {
  thread_id: ThreadId;
  /** Active turn when cancel was requested, or null if none. */
  turn_id: number | null;
  cancelled: boolean;
}

export interface HistoryLookupResult {
  cells: HistoryCellRecord[];
  cursor?: string;
  has_more?: boolean;
}

// ─── Notification payloads ────────────────────────────────────────────────────

export interface TurnEventParams {
  thread_id: ThreadId;
  turn_id: number;
  /** Monotonic sequence number per turn for client reorder detection. */
  seq: number;
  event: TurnStreamEvent;
}

export interface CellCommittedParams {
  thread_id: ThreadId;
  turn_id: number;
  cells: HistoryCellRecord[];
}