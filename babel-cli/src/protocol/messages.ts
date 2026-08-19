/**
 * Discriminated unions for Babel app-server wire messages.
 *
 * Each request method maps to a typed params/result pair. Notifications carry
 * streaming turn events and committed history cells.
 */

import type { JsonRpcNotification, JsonRpcRequest, JsonRpcSuccessResponse } from './jsonRpc.js';
import type {
  BabelProtocolMethod,
  BabelProtocolNotification,
  CellCommittedParams,
  HistoryLookupParams,
  HistoryLookupResult,
  ApprovalDecideParams,
  ApprovalDecideResult,
  WorkspaceChangesParams,
  WorkspaceChangesResult,
  VerificationLookupParams,
  VerificationLookupResult,
  ThreadCreateParams,
  ThreadCreateResult,
  ThreadResumeParams,
  ThreadResumeResult,
  TurnCancelParams,
  TurnCancelResult,
  TurnEventParams,
  TurnSubmitParams,
  TurnSubmitResult,
  PermissionRequestParams,
  PermissionRespondParams,
  GateRejectedParams,
  EnvBlockedParams,
} from './types.js';

// ─── Per-method request/response pairs ───────────────────────────────────────

export interface ThreadCreateRequest extends JsonRpcRequest<'thread.create', ThreadCreateParams> {}

export interface ThreadCreateResponse extends JsonRpcSuccessResponse<ThreadCreateResult> {}

export interface ThreadResumeRequest extends JsonRpcRequest<'thread.resume', ThreadResumeParams> {}

export interface ThreadResumeResponse extends JsonRpcSuccessResponse<ThreadResumeResult> {}

export interface TurnSubmitRequest extends JsonRpcRequest<'turn.submit', TurnSubmitParams> {}

export interface TurnSubmitResponse extends JsonRpcSuccessResponse<TurnSubmitResult> {}

export interface TurnCancelRequest extends JsonRpcRequest<'turn.cancel', TurnCancelParams> {}

export interface TurnCancelResponse extends JsonRpcSuccessResponse<TurnCancelResult> {}

export interface HistoryLookupRequest
  extends JsonRpcRequest<'history.lookup', HistoryLookupParams> {}

export interface HistoryLookupResponse extends JsonRpcSuccessResponse<HistoryLookupResult> {}

export interface ApprovalDecideRequest
  extends JsonRpcRequest<'approval.decide', ApprovalDecideParams> {}

export interface ApprovalDecideResponse extends JsonRpcSuccessResponse<ApprovalDecideResult> {}

export interface WorkspaceChangesRequest
  extends JsonRpcRequest<'workspace.changes', WorkspaceChangesParams> {}

export interface WorkspaceChangesResponse
  extends JsonRpcSuccessResponse<WorkspaceChangesResult> {}

export interface VerificationLookupRequest
  extends JsonRpcRequest<'verification.lookup', VerificationLookupParams> {}

export interface VerificationLookupResponse
  extends JsonRpcSuccessResponse<VerificationLookupResult> {}

/** Any client-originated JSON-RPC request in the catalog. */
export type BabelProtocolRequest =
  | ThreadCreateRequest
  | ThreadResumeRequest
  | TurnSubmitRequest
  | TurnCancelRequest
  | HistoryLookupRequest
  | ApprovalDecideRequest
  | WorkspaceChangesRequest
  | VerificationLookupRequest;

/** Success response for any catalog method (error responses use JsonRpcErrorResponse). */
export type BabelProtocolSuccessResponse =
  | ThreadCreateResponse
  | ThreadResumeResponse
  | TurnSubmitResponse
  | TurnCancelResponse
  | HistoryLookupResponse
  | ApprovalDecideResponse
  | WorkspaceChangesResponse
  | VerificationLookupResponse;

// ─── Notifications ────────────────────────────────────────────────────────────

export interface TurnEventNotification extends JsonRpcNotification<'turn.event', TurnEventParams> {}

export interface CellCommittedNotification
  extends JsonRpcNotification<'cell.committed', CellCommittedParams> {}

export interface PermissionRequestNotification
  extends JsonRpcNotification<'permission.request', PermissionRequestParams> {}

export interface PermissionRespondNotification
  extends JsonRpcNotification<'permission.respond', PermissionRespondParams> {}

export interface GateRejectedNotification
  extends JsonRpcNotification<'gate.rejected', GateRejectedParams> {}

export interface EnvBlockedNotification
  extends JsonRpcNotification<'env_blocked', EnvBlockedParams> {}

export type BabelProtocolServerNotification =
  | TurnEventNotification
  | CellCommittedNotification
  | PermissionRequestNotification
  | PermissionRespondNotification
  | GateRejectedNotification
  | EnvBlockedNotification;

// ─── Method → params/result maps (for handler typing in D2) ─────────────────

export interface BabelProtocolMethodMap {
  'thread.create': { params: ThreadCreateParams; result: ThreadCreateResult };
  'thread.resume': { params: ThreadResumeParams; result: ThreadResumeResult };
  'turn.submit': { params: TurnSubmitParams; result: TurnSubmitResult };
  'turn.cancel': { params: TurnCancelParams; result: TurnCancelResult };
  'history.lookup': { params: HistoryLookupParams; result: HistoryLookupResult };
  'approval.decide': { params: ApprovalDecideParams; result: ApprovalDecideResult };
  'workspace.changes': { params: WorkspaceChangesParams; result: WorkspaceChangesResult };
  'verification.lookup': { params: VerificationLookupParams; result: VerificationLookupResult };
}

export interface BabelProtocolNotificationMap {
  'turn.event': TurnEventParams;
  'cell.committed': CellCommittedParams;
  'permission.request': PermissionRequestParams;
  'permission.respond': PermissionRespondParams;
  'gate.rejected': GateRejectedParams;
  'env_blocked': EnvBlockedParams;
}

/** Extract params for a catalog method. */
export type BabelProtocolParams<M extends BabelProtocolMethod> = BabelProtocolMethodMap[M]['params'];

/** Extract result for a catalog method. */
export type BabelProtocolResult<M extends BabelProtocolMethod> = BabelProtocolMethodMap[M]['result'];

// ═══════════════════════════════════════════════════════════════════════════════
// Bridge / Remote Transport Extensions (Phase 1 — Gap 3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Session state machine transitions for the bridge.
 *
 * A session progresses through these states:
 *   created → ready → running → completed | failed | cancelled
 *
 * Crashed and reconnecting are transient states that (with recovery)
 * return to running.
 */
export type BridgeSessionState =
  | 'created'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'crashed'
  | 'reconnecting';

/** NDJSON message from bridge server → child process. */
export interface BridgeChildCommand {
  type: 'bridge_command';
  command: 'submit_prompt' | 'cancel_turn' | 'shutdown';
  session_id: string;
  payload?: Record<string, unknown>;
}

/** NDJSON message from child process → bridge server. */
export interface BridgeChildEvent {
  type: 'bridge_event';
  event: 'turn_start' | 'turn_complete' | 'turn_failed' | 'heartbeat' | 'error';
  session_id: string;
  payload?: Record<string, unknown>;
}

/**
 * Transport wrapper around Babel protocol messages for the bridge.
 *
 * When a bridge server relays a protocol request/response/notification
 * over WebSocket or NDJSON, it wraps it in this envelope so the recipient
 * can route it to the correct session and correlate responses.
 */
export interface BridgeProtocolEnvelope {
  /** The wrapped message type. */
  envelope_type: 'request' | 'response' | 'notification' | 'event';
  /** Session ID for routing. */
  session_id: string;
  /** Monotonic sequence number for reorder detection. */
  seq: number;
  /** The underlying payload (any Babel protocol message type). */
  payload: unknown;
}