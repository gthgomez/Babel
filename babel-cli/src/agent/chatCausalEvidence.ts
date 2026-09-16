import type { SessionEvent } from './sessionEvents.js';

export type ChatCausalReadiness = 'ready' | 'incomplete' | 'contradictory';

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
 * Build a compact causal view from existing durable session events.
 * Missing evidence stays UNKNOWN; this function never upgrades absence into success.
 */
export function buildChatCausalEvidence(events: readonly SessionEvent[]): ChatCausalEvidenceView {
  const orderedEvents = [...events].sort((left, right) => left.seq - right.seq);
  const nodes = orderedEvents.map(nodeForEvent);
  const contradictions: string[] = [];
  const unknowns: string[] = [];
  const inputs = new Map<string, SessionEvent & { kind: 'model_input_receipt' }>();
  const results = new Map<string, SessionEvent & { kind: 'model_result_delivery' }>();
  const lifecycles = new Map<string, { proposed: boolean; started: boolean; terminal: boolean }>();

  for (const event of orderedEvents) {
    if (event.kind === 'model_input_receipt') {
      if (!event.input_digest) contradictions.push(`model input ${event.inference_id} has no request digest`);
      inputs.set(event.inference_id, event);
    } else if (event.kind === 'model_result_delivery') {
      if (!inputs.has(event.inference_id)) contradictions.push(`model result ${event.inference_id} has no input receipt`);
      results.set(event.inference_id, event);
    } else if (
      event.kind === 'tool_proposed' || event.kind === 'tool_started' ||
      event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled'
    ) {
      const key = `${event.turn_id ?? 'null'}:${event.idempotency_key}`;
      const state = lifecycles.get(key) ?? { proposed: false, started: false, terminal: false };
      if (event.kind === 'tool_proposed') state.proposed = true;
      if (event.kind === 'tool_started') {
        if (!state.proposed) contradictions.push(`tool ${event.tool_call_id} started without proposal`);
        state.started = true;
      }
      if (event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') {
        if (!state.proposed || !state.started) contradictions.push(`tool ${event.tool_call_id} terminated before start`);
        state.terminal = true;
      }
      lifecycles.set(key, state);
    }
  }

  for (const [inferenceId] of inputs) {
    if (!results.has(inferenceId)) unknowns.push(`model result missing for inference ${inferenceId}`);
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
    nodes,
    contradictions,
    unknowns,
  };
}
