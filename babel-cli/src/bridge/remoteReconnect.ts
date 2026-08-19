/**
 * Explicit reconnect / idempotency policy for Babel Remote V1.
 * Network exceptions never auto-resubmit a turn.
 */

export type HostConnectionState =
  | 'UNKNOWN'
  | 'CONNECTING'
  | 'ONLINE'
  | 'OFFLINE'
  | 'RECONNECTING';

export type SubmitAmbiguity =
  | 'accepted'
  | 'rejected'
  | 'ambiguous_network'
  | 'host_unavailable';

export interface SubmitReconcileInput {
  /** True when the client received a JSON-RPC result or error. */
  responseSettled: boolean;
  acceptedTurnId?: number;
  commandId?: string;
  hostReachable: boolean;
}

export interface SubmitReconcileResult {
  host: HostConnectionState;
  ambiguity: SubmitAmbiguity;
  shouldResubmit: false;
  next: 'history.lookup' | 'thread.resume' | 'wait' | 'show_unavailable';
  reason: string;
}

export function reconcileAfterSubmitFailure(input: SubmitReconcileInput): SubmitReconcileResult {
  if (!input.hostReachable) {
    return {
      host: 'OFFLINE',
      ambiguity: 'host_unavailable',
      shouldResubmit: false,
      next: 'show_unavailable',
      reason: 'Host is unreachable; do not treat the turn as succeeded or resubmit',
    };
  }
  if (input.responseSettled && input.acceptedTurnId !== undefined) {
    return {
      host: 'ONLINE',
      ambiguity: 'accepted',
      shouldResubmit: false,
      next: 'history.lookup',
      reason: 'Server accepted the turn; recover via history / events, not resubmit',
    };
  }
  if (input.responseSettled) {
    return {
      host: 'ONLINE',
      ambiguity: 'rejected',
      shouldResubmit: false,
      next: 'wait',
      reason: 'Server rejected the submit; operator must send a new command_id to retry',
    };
  }
  return {
    host: 'UNKNOWN',
    ambiguity: 'ambiguous_network',
    shouldResubmit: false,
    next: input.commandId ? 'thread.resume' : 'show_unavailable',
    reason: 'Submit response was lost; state is UNKNOWN and must not auto-resubmit',
  };
}

export function hostStateAfterTransportEvent(
  current: HostConnectionState,
  event: 'open' | 'close' | 'error' | 'health_ok' | 'health_fail' | 'start',
): HostConnectionState {
  switch (event) {
    case 'start':
      return 'CONNECTING';
    case 'open':
    case 'health_ok':
      return 'ONLINE';
    case 'health_fail':
      return current === 'ONLINE' || current === 'RECONNECTING' ? 'RECONNECTING' : 'OFFLINE';
    case 'close':
      return current === 'ONLINE' || current === 'CONNECTING' ? 'RECONNECTING' : current;
    case 'error':
      return current === 'CONNECTING' ? 'OFFLINE' : 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}
