import type { SessionEvent } from './sessionEvents.js';

export type ChatCausalReadiness = 'ready' | 'incomplete' | 'contradictory';

export interface ChatCausalEvidenceOptions {
  /** Session identity the caller obtained from its authoritative run context. */
  expectedSessionId?: string;
  /** Event kinds required by the claim being made by the caller. */
  expectedEventKinds?: readonly SessionEvent['kind'][];
  /** Optional binding to a verified durable prefix used for this projection. */
  durablePrefix?: {
    sessionId: string;
    lastSeq: number;
    lastEventId?: string;
  };
}

export interface ChatCausalEvidenceNode {
  seq: number;
  event_id: string;
  turn_id: string | null;
  kind: SessionEvent['kind'];
  inference_id?: string;
  request_digest?: string;
  context_manifest_hash?: string;
  tool_call_id?: string;
  idempotency_key?: string;
  tool_name?: string;
  exit_code?: number;
  status?: string;
  paths?: string[];
  evidence: 'observed';
}

export interface ChatCausalEvidenceView {
  schema_version: 'chat-causal-evidence.v1';
  readiness: ChatCausalReadiness;
  consistency: 'consistent' | 'contradictory';
  completeness: 'complete' | 'incomplete';
  durability: 'verified' | 'unverified';
  nodes: ChatCausalEvidenceNode[];
  contradictions: string[];
  unknowns: string[];
}

function nodeForEvent(event: SessionEvent): ChatCausalEvidenceNode {
  const base: ChatCausalEvidenceNode = {
    seq: event.seq,
    event_id: event.event_id,
    turn_id: event.turn_id,
    kind: event.kind,
    evidence: 'observed',
  };
  if (event.kind === 'model_input_receipt') {
    return {
      ...base,
      inference_id: event.inference_id,
      request_digest: event.input_digest,
      ...(event.context_manifest?.manifest_hash
        ? { context_manifest_hash: event.context_manifest.manifest_hash }
        : {}),
    };
  }
  if (event.kind === 'model_result_delivery') {
    return {
      ...base,
      inference_id: event.inference_id,
      status: event.status,
      ...(event.failure_class ? { status: `${event.status}:${event.failure_class}` } : {}),
    };
  }
  if (
    event.kind === 'tool_proposed' ||
    event.kind === 'tool_started' ||
    event.kind === 'tool_completed' ||
    event.kind === 'tool_failed' ||
    event.kind === 'tool_cancelled'
  ) {
    return {
      ...base,
      tool_call_id: event.tool_call_id,
      idempotency_key: event.idempotency_key,
      tool_name: event.tool_name,
      ...('exit_code' in event && event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
      status: event.kind,
    };
  }
  if (event.kind === 'verifier_attempt') {
    return {
      ...base,
      ...(event.tool_call_id ? { tool_call_id: event.tool_call_id } : {}),
      ...(event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
      status: event.authoritative ? 'authoritative' : 'non_authoritative',
    };
  }
  if (event.kind === 'mutation_batch') {
    return { ...base, paths: [...event.paths], ...(event.status ? { status: event.status } : {}) };
  }
  return base;
}

/**
 * Build a compact causal view from a supplied session-event sequence.
 * Callers must bind it to a verified durable source before treating it as durable evidence.
 * Missing evidence stays UNKNOWN; this function never upgrades absence into success.
 */
export function buildChatCausalEvidence(
  events: readonly SessionEvent[],
  options: ChatCausalEvidenceOptions = {},
): ChatCausalEvidenceView {
  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const nodes = orderedEvents.map(nodeForEvent);
  const contradictions: string[] = [];
  const unknowns: string[] = [];
  let durability: ChatCausalEvidenceView['durability'] = 'unverified';
  const inputs = new Map<string, SessionEvent & { kind: 'model_input_receipt' }>();
  const results = new Map<string, SessionEvent & { kind: 'model_result_delivery' }>();
  const lifecycles = new Map<string, {
    proposed: boolean;
    started: boolean;
    terminal: boolean;
    toolCallId: string;
    toolName: string;
  }>();

  const attemptKey = (turnId: string | null, id: string): string =>
    `${turnId ?? 'null'}:${id}`;

  if (orderedEvents.length === 0) {
    unknowns.push('session event evidence is empty');
  }

  const sessionIds = new Set(orderedEvents.map((event) => event.session_id));
  if (sessionIds.size > 1) {
    contradictions.push(
      `causal evidence mixes session identities: ${[...sessionIds].sort().join(', ')}`,
    );
  }
  if (options.expectedSessionId !== undefined) {
    for (const event of orderedEvents) {
      if (event.session_id !== options.expectedSessionId) {
        contradictions.push(
          `event ${event.event_id} belongs to session ${event.session_id}, expected ${options.expectedSessionId}`,
        );
      }
    }
  }

  const outcomeKinds = new Set<SessionEvent['kind']>([
    'model_result_delivery',
    'provider_failure_receipt',
    'tool_completed',
    'tool_failed',
    'tool_cancelled',
    'mutation_batch',
    'verifier_attempt',
    'completion_decision',
    'turn_ended',
    'policy_intervened',
    'gate_decision',
  ]);
  if (!orderedEvents.some((event) => outcomeKinds.has(event.kind))) {
    unknowns.push('causal evidence has no terminal or outcome coverage');
  }

  if (options.expectedEventKinds) {
    const observedKinds = new Set(orderedEvents.map((event) => event.kind));
    for (const kind of new Set(options.expectedEventKinds)) {
      if (!observedKinds.has(kind)) {
        unknowns.push(`expected event coverage missing for ${kind}`);
      }
    }
  }

  if (options.durablePrefix) {
    const prefix = options.durablePrefix;
    const last = orderedEvents.at(-1);
    const contiguousFromZero =
      orderedEvents.length > 0 &&
      orderedEvents.every((event, index) => event.seq === index) &&
      last?.seq === prefix.lastSeq;
    const prefixMatches =
      sessionIds.size === 1 &&
      sessionIds.has(prefix.sessionId) &&
      contiguousFromZero &&
      orderedEvents.every((event) => event.session_id === prefix.sessionId) &&
      (prefix.lastEventId === undefined || last?.event_id === prefix.lastEventId);
    if (prefixMatches) {
      durability = 'verified';
    } else {
      unknowns.push('causal evidence does not match the supplied durable prefix');
    }
  }

  for (const event of orderedEvents) {
    if (event.kind === 'model_input_receipt') {
      if (!event.input_digest) contradictions.push(`model input ${event.inference_id} has no request digest`);
      const key = attemptKey(event.turn_id, event.inference_id);
      const prior = inputs.get(key);
      if (prior) {
        contradictions.push(
          prior.input_digest === event.input_digest
            ? `duplicate model input receipt for inference ${event.inference_id}`
            : `conflicting model input digests for inference ${event.inference_id}`,
        );
      } else {
        inputs.set(key, event);
      }
    } else if (event.kind === 'model_result_delivery') {
      const key = attemptKey(event.turn_id, event.inference_id);
      const input = inputs.get(key);
      if (!input) {
        contradictions.push(`model result ${event.inference_id} has no input receipt`);
      } else if (input.provider !== event.provider || input.sent_model_id !== event.model) {
        contradictions.push(`model result ${event.inference_id} identity does not match its input receipt`);
      }
      if (results.has(key)) {
        contradictions.push(`duplicate model result delivery for inference ${event.inference_id}`);
      } else {
        results.set(key, event);
      }
    } else if (
      event.kind === 'tool_proposed' || event.kind === 'tool_started' ||
      event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled'
    ) {
      const key = attemptKey(event.turn_id, event.idempotency_key);
      const state = lifecycles.get(key) ?? {
        proposed: false,
        started: false,
        terminal: false,
        toolCallId: event.tool_call_id,
        toolName: event.tool_name,
      };
      if (state.toolCallId !== event.tool_call_id || state.toolName !== event.tool_name) {
        contradictions.push(`tool ${event.tool_call_id} has conflicting lifecycle identity for ${key}`);
      }
      if (event.kind === 'tool_proposed') {
        if (state.proposed) contradictions.push(`duplicate tool proposal for ${event.tool_call_id}`);
        state.proposed = true;
      }
      if (event.kind === 'tool_started') {
        if (!state.proposed) contradictions.push(`tool ${event.tool_call_id} started without proposal`);
        if (state.started) contradictions.push(`duplicate tool start for ${event.tool_call_id}`);
        state.started = true;
      }
      if (event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') {
        if (!state.proposed || !state.started) contradictions.push(`tool ${event.tool_call_id} terminated before start`);
        if (state.terminal) contradictions.push(`duplicate tool terminal for ${event.tool_call_id}`);
        state.terminal = true;
      }
      lifecycles.set(key, state);
    }
  }

  for (const [key, input] of inputs) {
    if (!results.has(key)) unknowns.push(`model result missing for inference ${input.inference_id}`);
  }
  for (const [key, state] of lifecycles) {
    if (!state.terminal) unknowns.push(`terminal tool evidence missing for ${key}`);
  }
  for (const event of orderedEvents) {
    if (event.kind === 'verifier_attempt' && event.exit_code === undefined) {
      unknowns.push(`verifier exit code missing for ${event.command_preview}`);
    }
    if (event.kind === 'mutation_batch' && event.paths.length > 0 && !event.post_hash && !event.post_image_hashes) {
      unknowns.push(`post-mutation hash missing for ${event.paths.join(', ')}`);
    }
  }

  return {
    schema_version: 'chat-causal-evidence.v1',
    readiness: contradictions.length > 0 ? 'contradictory' : unknowns.length > 0 ? 'incomplete' : 'ready',
    consistency: contradictions.length > 0 ? 'contradictory' : 'consistent',
    completeness: unknowns.length > 0 ? 'incomplete' : 'complete',
    durability,
    nodes,
    contradictions,
    unknowns,
  };
}
