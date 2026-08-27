/**
 * Explicit Remote V1 client state machines. Illegal transitions fail closed.
 */

export type HostUiState = 'UNKNOWN' | 'CONNECTING' | 'ONLINE' | 'OFFLINE' | 'RECONNECTING';
export type ThreadUiState =
  | 'NONE'
  | 'CREATING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'RECOVERING'
  | 'FAILED';
export type TurnUiState =
  | 'IDLE'
  | 'SUBMITTING'
  | 'ACKNOWLEDGED'
  | 'STREAMING'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'UNKNOWN';
export type ApprovalUiState =
  | 'NONE'
  | 'PENDING'
  | 'ALLOWING'
  | 'DENYING'
  | 'RESOLVED'
  | 'STALE'
  | 'EXPIRED';

export class IllegalUiTransitionError extends Error {
  constructor(
    public readonly machine: string,
    public readonly from: string,
    public readonly event: string,
  ) {
    super(`Illegal ${machine} transition: ${from} + ${event}`);
    this.name = 'IllegalUiTransitionError';
  }
}

const HOST_TRANSITIONS: Record<HostUiState, readonly string[]> = {
  UNKNOWN: ['start', 'health_fail'],
  CONNECTING: ['open', 'error', 'health_fail'],
  ONLINE: ['close', 'health_fail'],
  OFFLINE: ['start'],
  RECONNECTING: ['open', 'health_fail', 'error'],
};

const THREAD_TRANSITIONS: Record<ThreadUiState, readonly string[]> = {
  NONE: ['create', 'resume'],
  CREATING: ['ready', 'fail'],
  READY: ['submit', 'recover', 'fail'],
  RUNNING: ['waiting_approval', 'ready', 'fail', 'recover'],
  WAITING_APPROVAL: ['running', 'ready', 'stale', 'fail'],
  RECOVERING: ['ready', 'running', 'fail'],
  FAILED: ['create', 'resume'],
};

const TURN_TRANSITIONS: Record<TurnUiState, readonly string[]> = {
  IDLE: ['submit'],
  SUBMITTING: ['ack', 'fail', 'unknown'],
  ACKNOWLEDGED: ['stream', 'complete', 'fail', 'cancel'],
  STREAMING: ['complete', 'fail', 'cancel'],
  CANCELLING: ['complete', 'fail', 'unknown'],
  COMPLETED: ['submit'],
  FAILED: ['submit'],
  UNKNOWN: ['recover', 'fail', 'complete'],
};

const APPROVAL_TRANSITIONS: Record<ApprovalUiState, readonly string[]> = {
  NONE: ['pending'],
  PENDING: ['allow', 'deny', 'stale', 'expire', 'resolve'],
  ALLOWING: ['resolve', 'stale', 'expire'],
  DENYING: ['resolve', 'stale'],
  RESOLVED: ['pending', 'clear'],
  STALE: ['clear', 'pending'],
  EXPIRED: ['clear', 'pending'],
};

function step<S extends string>(
  machine: string,
  table: Record<S, readonly string[]>,
  from: S,
  event: string,
): S {
  const allowed = table[from];
  if (!allowed?.includes(event)) {
    throw new IllegalUiTransitionError(machine, from, event);
  }
  return applyTransition(machine, from, event);
}

function applyTransition<S extends string>(machine: string, from: S, event: string): S {
  if (machine === 'host') {
    if (event === 'start') return 'CONNECTING' as S;
    if (event === 'open') return 'ONLINE' as S;
    if (event === 'health_fail' && from === 'CONNECTING') return 'OFFLINE' as S;
    if (event === 'health_fail') return 'RECONNECTING' as S;
    if (event === 'close') return 'RECONNECTING' as S;
    if (event === 'error' && from === 'CONNECTING') return 'OFFLINE' as S;
    if (event === 'error') return 'UNKNOWN' as S;
  }
  if (machine === 'thread') {
    if (event === 'create') return 'CREATING' as S;
    if (event === 'resume' || event === 'ready') return 'READY' as S;
    if (event === 'submit' || event === 'running') return 'RUNNING' as S;
    if (event === 'waiting_approval') return 'WAITING_APPROVAL' as S;
    if (event === 'recover') return 'RECOVERING' as S;
    if (event === 'fail') return 'FAILED' as S;
    if (event === 'stale') return 'READY' as S;
  }
  if (machine === 'turn') {
    if (event === 'submit') return 'SUBMITTING' as S;
    if (event === 'ack') return 'ACKNOWLEDGED' as S;
    if (event === 'stream') return 'STREAMING' as S;
    if (event === 'cancel') return 'CANCELLING' as S;
    if (event === 'complete') return 'COMPLETED' as S;
    if (event === 'fail') return 'FAILED' as S;
    if (event === 'unknown') return 'UNKNOWN' as S;
    if (event === 'recover') return 'STREAMING' as S;
  }
  if (machine === 'approval') {
    if (event === 'pending') return 'PENDING' as S;
    if (event === 'allow') return 'ALLOWING' as S;
    if (event === 'deny') return 'DENYING' as S;
    if (event === 'resolve') return 'RESOLVED' as S;
    if (event === 'stale') return 'STALE' as S;
    if (event === 'expire') return 'EXPIRED' as S;
    if (event === 'clear') return 'NONE' as S;
  }
  throw new IllegalUiTransitionError(machine, from, event);
}

export function transitionHost(from: HostUiState, event: string): HostUiState {
  return step('host', HOST_TRANSITIONS, from, event);
}

export function transitionThread(from: ThreadUiState, event: string): ThreadUiState {
  return step('thread', THREAD_TRANSITIONS, from, event);
}

export function transitionTurn(from: TurnUiState, event: string): TurnUiState {
  return step('turn', TURN_TRANSITIONS, from, event);
}

export function transitionApproval(from: ApprovalUiState, event: string): ApprovalUiState {
  return step('approval', APPROVAL_TRANSITIONS, from, event);
}

export function canSendTurn(thread: ThreadUiState, turn: TurnUiState): boolean {
  return (
    (thread === 'READY' || thread === 'FAILED') &&
    (turn === 'IDLE' || turn === 'COMPLETED' || turn === 'FAILED')
  );
}

export function canCancelTurn(turn: TurnUiState): boolean {
  return turn === 'ACKNOWLEDGED' || turn === 'STREAMING' || turn === 'SUBMITTING';
}

export function canDecideApproval(approval: ApprovalUiState): boolean {
  return approval === 'PENDING';
}
