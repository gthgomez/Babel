/**
 * Babel app-server protocol — core identifiers, enums, and stream event shapes.
 *
 * Phase D1 sketch only. See ADR-010 and `src/protocol/messages.ts` for the
 * full request/response catalog.
 */

import type { HistoryCellRecord } from '../ui/historyCells/types.js';
import type { BabelMode } from '../executor/contracts.js';

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
  | 'history.lookup'
  | 'approval.decide'
  | 'workspace.changes'
  | 'verification.lookup';

/** Server-initiated JSON-RPC notifications (no response `id`). */
export type BabelProtocolNotification =
  | 'turn.event'
  | 'cell.committed'
  | 'permission.request'
  | 'permission.respond'
  | 'gate.rejected'
  | 'env_blocked';

export const BABEL_PROTOCOL_METHODS: readonly BabelProtocolMethod[] = [
  'thread.create',
  'thread.resume',
  'turn.submit',
  'turn.cancel',
  'history.lookup',
  'approval.decide',
  'workspace.changes',
  'verification.lookup',
] as const;

export const BABEL_PROTOCOL_NOTIFICATIONS: readonly BabelProtocolNotification[] = [
  'turn.event',
  'cell.committed',
  'permission.request',
  'permission.respond',
  'gate.rejected',
  'env_blocked',
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
  | { type: 'cancelled' }
  | {
      type: 'progress_recovery';
      intervention: import('../agent/progressController.js').ProgressInterventionLevel;
      source: string;
      score: number;
      message?: string;
    }
  | { type: 'permission.request'; permission: string; reason?: string }
  | { type: 'permission.respond'; permission: string; granted: boolean }
  | { type: 'gate.rejected'; gate: string; reason: string }
  | { type: 'env_blocked'; category: string; evidence: string };

// ─── Request params ───────────────────────────────────────────────────────────

export interface ThreadCreateParams {
  project_root: string;
  task?: string;
  model?: string;
  provider?: string;
  mode?: BabelMode;
  policy_profile?: string;
}

export interface ThreadResumeParams {
  thread_id: ThreadId;
  project_root?: string;
}

export interface TurnSubmitParams {
  thread_id: ThreadId;
  message: string;
  /** Optional client idempotency key. Same id + same message hash replays the prior result. */
  command_id?: string;
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

export interface ApprovalDecideParams {
  approval_id: string;
  decision: string;
  thread_id: ThreadId;
  turn_id: string;
  operation_digest?: string;
}

export interface WorkspaceChangesParams {
  thread_id: ThreadId;
}

export interface VerificationLookupParams {
  thread_id: ThreadId;
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

export interface ApprovalDecideResult {
  approval_id: string;
  decision: 'allow_once' | 'deny';
  consumed: boolean;
}

export interface WorkspaceFileChange {
  path: string;
  status: string;
}

export interface WorkspaceChangesResult {
  available: boolean;
  files: WorkspaceFileChange[];
  diff: string;
  reason?: string;
}

export interface VerificationLookupResult {
  status: string;
  reason: string;
  has_machine_evidence: boolean;
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

export interface PermissionRequestParams {
  thread_id: ThreadId;
  permission: string;
  reason?: string;
  approval_id?: string;
  turn_id?: string;
  action_type?: string;
  command?: string;
  cwd?: string;
  target_path?: string;
  operation_digest?: string;
  allowed_decisions?: readonly ('allow_once' | 'deny')[];
  expires_at?: string;
}

export interface PermissionRespondParams {
  thread_id: ThreadId;
  permission: string;
  granted: boolean;
}

export interface GateRejectedParams {
  thread_id: ThreadId;
  gate: string;
  reason: string;
}

export interface EnvBlockedParams {
  thread_id: ThreadId;
  category: string;
  evidence: string;
}
