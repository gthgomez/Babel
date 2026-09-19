/**
 * Legacy event adapters — pure, total mappings from existing durable records to
 * `RuntimeFactV1`.
 *
 * These adapters are removable and never authoritative: they read the existing
 * session-event log (the richest semantic source) and translate observed
 * boundaries. Unknown or non-semantic kinds map to `[]`. No adapter invents a
 * completion, a tool result, or a verifier pass.
 *
 * The thread event log is intentionally *not* adapted here: it is a provider
 * transcript/compatibility projection, and adapting both would create a second
 * terminal producer. Its reader remains authoritative until P21.
 */

import type { SessionEvent } from '../agent/sessionEvents.js';
import {
  classifyFactType,
  RUNTIME_FACT_SCHEMA_VERSION,
  type EventCursor,
  type FactAuthority,
  type FactPayload,
  type RuntimeFactProducer,
  type RuntimeFactV1,
} from './events.js';

export interface LegacyFactContext {
  /** Defaults to the session id carried by the event. */
  threadId?: string;
  /** Defaults to empty (no frozen task identity on this surface yet). */
  taskId?: string;
  /** Defaults to the session id. */
  runId?: string;
  producer?: RuntimeFactProducer;
  ownerGeneration?: number;
  /** Called when the adapter truncates input (cap reached or iterator threw). */
  onTruncated?: () => void;
}

const DEFAULT_PRODUCER: RuntimeFactProducer = 'legacy_adapter';

/** Bound adapter input so an endless event iterable cannot run forever. */
const MAX_LEGACY_EVENTS = 100_000;
/** Bound evidence reference arrays so an endless iterable cannot run forever. */
const MAX_EVIDENCE_REFS = 10_000;

function boundedEvidenceRefs(refs: Iterable<unknown>): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    out.push(typeof ref === 'string' ? ref : String(ref));
    if (out.length >= MAX_EVIDENCE_REFS) break;
  }
  return out;
}

function cursorFor(sequence: number): EventCursor {
  return { stream: 'runtime-facts', sequence };
}

function authorityFor(type: FactPayload['type'], payload: FactPayload): FactAuthority {
  if (type === 'verification.recorded' && 'authoritative' in payload && !payload.authoritative) {
    return 'observation';
  }
  return classifyFactType(type) === 'authoritative' ? 'authoritative' : 'observation';
}

function approvalDecisionToFactDecision(
  decision: 'deny' | 'allow_once' | 'allow_session' | 'narrow_rule',
): 'allow' | 'ask' | 'deny' {
  switch (decision) {
    case 'deny':
      return 'deny';
    case 'allow_once':
    case 'allow_session':
      return 'allow';
    case 'narrow_rule':
      return 'ask';
  }
}

/** Map a validated session event to zero or more fact payloads. */
export function sessionEventPayloads(
  event: SessionEvent,
  context: LegacyFactContext = {},
): FactPayload[] {
  try {
  switch (event.kind) {
    case 'user_submitted':
      return [{ type: 'turn.admitted', commandId: event.event_id }];
    case 'model_started':
      return [{ type: 'run.started', ownerGeneration: context.ownerGeneration ?? 0 }];
    case 'model_input_receipt':
      return [
        {
          type: 'operation.prepared',
          operationDigest: event.body_digest ?? event.input_digest,
          operationId: event.inference_id,
          toolName: 'model_inference',
        },
      ];
    case 'model_result_delivery':
      return event.status === 'delivered'
        ? [
            {
              type: 'operation.settled',
              receiptId: event.inference_id,
              operationId: event.inference_id,
              status: 'delivered',
            },
          ]
        : [
            {
              type: 'operation.indeterminate',
              operationDigest: event.output_digest ?? event.inference_id,
              reason: event.failure_class ?? 'provider_failed',
              operationId: event.inference_id,
            },
          ];
    case 'provider_failure_receipt':
      return [
        {
          type: 'operation.indeterminate',
          operationDigest: event.receipt.receipt_hash || event.inference_id,
          reason: event.receipt.normalized_failure_class || 'provider_failure',
          operationId: event.inference_id,
        },
      ];
    case 'tool_proposed':
      return [
        {
          type: 'operation.prepared',
          operationDigest: event.args_digest ?? event.idempotency_key,
          operationId: event.idempotency_key,
          toolName: event.tool_name,
          ...(event.effect_class !== undefined ? { effectClass: event.effect_class } : {}),
        },
      ];
    case 'tool_completed':
      return [
        {
          type: 'operation.settled',
          receiptId: event.event_id,
          operationId: event.idempotency_key,
          status: 'completed',
        },
      ];
    case 'tool_failed':
      return [
        {
          type: 'operation.indeterminate',
          operationDigest: event.idempotency_key,
          reason: 'tool_failed',
          operationId: event.idempotency_key,
        },
      ];
    case 'tool_cancelled':
      return [
        {
          type: 'operation.indeterminate',
          operationDigest: event.args_digest ?? event.idempotency_key,
          reason: 'tool_cancelled',
          operationId: event.idempotency_key,
        },
      ];
    case 'recovery_reconciled':
      return [{ type: 'permission.decided', decision: 'allow', reason: 'recovery_reconciled' }];
    case 'mutation_batch': {
      const operationId = event.batch_id ?? event.event_id;
      if (event.status === 'prepare') {
        return [
          {
            type: 'operation.prepared',
            operationDigest: event.pre_hash ?? event.event_id,
            operationId,
            toolName: 'mutation_batch',
          },
        ];
      }
      if (event.status === 'rollback') {
        return [
          {
            type: 'operation.indeterminate',
            operationDigest: event.post_hash ?? event.pre_hash ?? event.event_id,
            reason: 'mutation_rollback',
            operationId,
          },
        ];
      }
      if (event.status === 'commit') {
        return [
          {
            type: 'operation.settled',
            receiptId: operationId,
            operationId,
            status: 'commit',
          },
        ];
      }
      // Unknown/absent mutation status must not be reported as a success.
      return [
        {
          type: 'operation.indeterminate',
          operationDigest: event.pre_hash ?? event.event_id,
          reason: `mutation_status_${event.status ?? 'unknown'}`,
          operationId,
        },
      ];
    }
    case 'verifier_attempt':
      return [
        {
          type: 'verification.recorded',
          receiptId: event.event_id,
          authoritative: event.authoritative,
        },
      ];
    case 'completion_decision':
      return [
        {
          type: 'completion.decided',
          decision: {
            requestedOutcome: event.requested_outcome,
            finalOutcome: event.final_outcome,
            allowed: event.allowed,
            reason: event.reason,
            evidenceRefs: boundedEvidenceRefs(event.evidence_refs),
            policyVersion: event.policy_version,
          },
        },
      ];
    case 'turn_ended':
      return [{ type: 'run.settled', status: event.outcome ?? 'UNKNOWN' }];
    case 'compaction_committed':
      return [{ type: 'context.committed', checkpointId: event.operation_id }];
    case 'approval_decision':
      return [
        {
          type: 'permission.decided',
          decision: approvalDecisionToFactDecision(event.decision),
          ...(event.scope !== undefined ? { reason: event.scope } : {}),
        },
      ];
    default:
      // Non-semantic or provider-lifecycle events are not facts yet. Existing
      // readers stay authoritative for them.
      return [];
  }
  } catch {
    // A type-violating or hostile event yields no facts rather than throwing.
    return [];
  }
}

/** Adapter identity for one fact derived from one legacy event. */
export function sessionEventToFacts(
  event: SessionEvent,
  context: LegacyFactContext = {},
): RuntimeFactV1[] {
  try {
    const payloads = sessionEventPayloads(event, context);
    const threadId = context.threadId ?? event.session_id;
    const runId = context.runId ?? event.session_id;
    const taskId = context.taskId ?? '';
    const producer = context.producer ?? DEFAULT_PRODUCER;
    const seq = event.seq;
    return payloads.map((payload, index) => ({
      schemaVersion: RUNTIME_FACT_SCHEMA_VERSION,
      id: payloads.length > 1 ? `${event.event_id}:${index}` : event.event_id,
      cursor: cursorFor(seq),
      threadId,
      taskId,
      turnId: event.turn_id ?? '',
      runId,
      sequence: seq,
      causationId: event.event_id,
      producer,
      authority: authorityFor(payload.type, payload),
      timestamp: event.ts,
      payload,
    }));
  } catch {
    return [];
  }
}

/** Map an ordered session log to shadow facts. Pure and side-effect free. */
export function sessionLogToFacts(
  events: readonly SessionEvent[],
  context: LegacyFactContext = {},
): RuntimeFactV1[] {
  const facts: RuntimeFactV1[] = [];
  let sequence = 0;
  let eventsSeen = 0;
  try {
    for (const event of events) {
      eventsSeen += 1;
      if (eventsSeen > MAX_LEGACY_EVENTS) {
        context.onTruncated?.();
        break;
      }
      for (const fact of sessionEventToFacts(event, context)) {
        // The fact stream owns its own contiguous sequence; the source session
        // sequence is not the fact cursor. Source identity stays on causationId.
        const cursor: EventCursor = { stream: 'runtime-facts', sequence };
        facts.push({ ...fact, sequence, cursor });
        sequence += 1;
      }
    }
  } catch {
    // A hostile/unterminating iterable yields the facts gathered so far.
    context.onTruncated?.();
  }
  return facts;
}
