import type { SettleAdmissionInput } from '../runtime/admission.js';
import type { ParityRuntime } from './chatEngineParityBridge.js';
import { assertObjectiveLifecycle, type TaskObjectiveLifecycleV1 } from './taskObjectiveLifecycle.js';

/** Durable admission state used by the Chat replacement fence. */
export interface BufferAdmissionStore {
  listAdmissions(runId: string): {
    skippedCorruptRows: number;
    records: ReadonlyArray<{ state: string }>;
  };
}

export interface DurableAdmissionState {
  /** A prior physical effect was never reconciled and must block all successors. */
  indeterminate: boolean;
  /** A claimed record with a live wrapper is unsettled work. */
  claimed: boolean;
}

export function durableAdmissionState(
  store: BufferAdmissionStore | undefined,
  runId: string,
): DurableAdmissionState {
  if (!store) return { indeterminate: false, claimed: false };
  try {
    const listing = store.listAdmissions(runId);
    return {
      indeterminate: listing.skippedCorruptRows > 0 ||
        listing.records.some(record => record.state === 'indeterminate'),
      claimed: listing.records.some(record => record.state === 'claimed'),
    };
  } catch {
    return { indeterminate: true, claimed: true };
  }
}

/** Use the canonical attempt identity allocated before SQLite admission. */
export function chatAttemptCommandId(attemptId: string): string {
  return `chat-attempt:${attemptId}`;
}

/**
 * The outbox records the append of the accepted submission. Physical operations
 * and their unknowns remain in the effect ledger and session tool lifecycle.
 */
export function committedChatSubmission(
  attempt: TaskObjectiveLifecycleV1['attempts'][number],
): NonNullable<SettleAdmissionInput['outbox']> {
  return {
    state: 'committed',
    postImageHashes: { accepted_input: attempt.input_digest },
  };
}

/** Reconcile accepted submissions after the host acquires the session writer lease. */
export function reconcileChatSubmissions(parity: ParityRuntime): void {
  const store = parity.admissionStore;
  const authority = parity.liveAuthority;
  const lifecycle = authority?.taskObjectiveLifecycle;
  const threadId = parity.eventLog.thread_id;
  if (!store || !lifecycle || parity.sessionEvents.session_id !== threadId) return;
  const listing = store.listAdmissions(threadId);
  const claimed = new Map(listing.records.filter(record => record.state === 'claimed').map(record => [record.commandId, record]));
  const owner = store.readOwner(threadId);
  if (!owner || !claimed.size || listing.skippedCorruptRows) return;
  assertObjectiveLifecycle(authority, lifecycle, { thread: parity.eventLog, session: parity.sessionEvents });
  const terminals = new Map(parity.sessionEvents.events
    .filter(event => event.kind === 'turn_ended')
    .map(event => [event.turn_id, event]));
  for (const attempt of lifecycle.attempts) {
    const commandId = chatAttemptCommandId(attempt.attempt_id);
    const claim = claimed.get(commandId);
    if (!claim) continue;
    const outbox = store.readOutbox(claim.admissionId);
    if (outbox?.state !== 'intent' || outbox.operationId !== `chat-submission:${threadId}:${commandId}` ||
        outbox.effectClass !== 'reconcilable_mutation') continue;
    const terminal = terminals.get(attempt.turn_id);
    // An interrupted submission is no longer executing under this lease. An
    // aborted admission does not assert that its physical tools had no effect.
    if (terminal && claim.ownerGeneration !== owner.generation) continue;
    store.settleAdmission({
      threadId, commandId, ownerGeneration: claim.ownerGeneration, ownerToken: owner.token,
      state: !terminal || terminal.outcome === 'CANCELLED' ? 'aborted' : 'settled',
      outcome: terminal
        ? { finalOutcome: 'CHAT_TERMINAL_RECORDED', turnId: attempt.turn_id, terminalEventId: terminal.event_id }
        : { finalOutcome: 'SUBMISSION_INTERRUPTED', turnId: attempt.turn_id },
      outbox: committedChatSubmission(attempt),
    });
  }
}
