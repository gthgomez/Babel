/**
 * Packet A3 — replay index over the episode stream.
 *
 * Given a conversation (session) id, enumerates the ordered action→observation
 * sequence recorded by `episodeStream.ts` so any run can be audited/replayed.
 * This module is read-only: it never regenerates, re-redacts, or extends
 * evidence. Every persisted byte was already redacted and capped at capture
 * time (see `redactAndCapEpisodePayload`), so replay output can only be *less*
 * detailed than the live transcript, never more.
 *
 * Two pair sources are supported:
 *  - explicit pairs captured via `appendEpisodeActionObservationPair`
 *    (`action_invoked` / `observation_recorded` linked by `pairId`);
 *  - projected session tool events (`tool_started` action side; `tool_completed`
 *    / `tool_failed` / `tool_cancelled` observation side) correlated by
 *    `turn_id` + `tool_call_id`.
 */

import {
  loadEpisodeEventLogFromDir,
  type EpisodeEvent,
  type EpisodeEventLog,
} from './episodeStream.js';

export const REPLAY_INDEX_SCHEMA_VERSION = 1 as const;

export type ReplayPairStatusV1 = 'paired' | 'action_only' | 'observation_only';

/** One ordered action→observation pair with its receiptIndex correlation. */
export interface ReplayActionObservationPairV1 {
  pairId: string;
  turnId: string | null;
  toolCallId: string;
  toolName: string;
  receiptId: string | null;
  status: ReplayPairStatusV1;
  action: EpisodeEvent | null;
  observation: EpisodeEvent | null;
}

export interface ReplayIndexV1 {
  schemaVersion: typeof REPLAY_INDEX_SCHEMA_VERSION;
  sessionId: string;
  pairs: ReplayActionObservationPairV1[];
  /** Number of episode events not attributed to any pair. */
  unpairedEvents: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

const ACTION_EVENT_TYPES = new Set(['action_invoked', 'tool_proposed', 'tool_started']);
const OBSERVATION_EVENT_TYPES = new Set([
  'observation_recorded',
  'tool_completed',
  'tool_failed',
  'tool_cancelled',
]);

function actionKey(turnId: string | null, toolCallId: string): string {
  return `${turnId ?? ''}\u0000${toolCallId}`;
}

/**
 * Build the ordered replay index from episode events. Ordering follows stream
 * sequence (events are assumed seq-ordered, as produced by every writer in
 * `episodeStream.ts`).
 */
export function buildReplayIndex(
  events: readonly EpisodeEvent[],
  expectedSessionId?: string,
): ReplayIndexV1 {
  const sessionId = events[0]?.sessionId ?? expectedSessionId ?? '';
  const pairs: ReplayActionObservationPairV1[] = [];
  const pairIdIndex = new Map<string, ReplayActionObservationPairV1>();
  const pendingActions = new Map<string, ReplayActionObservationPairV1>();
  const attributed = new Set<EpisodeEvent>();

  const startPair = (event: EpisodeEvent): ReplayActionObservationPairV1 => {
    const payload = asRecord(event.payload) ?? {};
    const pair: ReplayActionObservationPairV1 = {
      pairId: str(payload, 'pairId') ?? `seq:${event.seq}`,
      turnId: event.turnId ?? null,
      toolCallId: str(payload, 'toolCallId') ?? str(payload, 'tool_call_id') ?? '',
      toolName: recordString(payload, 'toolName') ?? recordString(payload, 'tool_name') ?? '',
      receiptId: str(payload, 'receiptId') ?? null,
      status: 'action_only',
      action: event,
      observation: null,
    };
    pairs.push(pair);
    if (!pair.pairId.startsWith('seq:')) {
      pairIdIndex.set(pair.pairId, pair);
    }
    return pair;
  };

  for (const event of events) {
    const payload = asRecord(event.payload) ?? {};
    if (event.type === 'action_invoked') {
      const pair = startPair(event);
      attributed.add(event);
      pendingActions.set(actionKey(pair.turnId, pair.toolCallId), pair);
      continue;
    }
    if (event.type === 'observation_recorded') {
      attributed.add(event);
      const byPairId = str(payload, 'pairId') ? pairIdIndex.get(str(payload, 'pairId')!) : undefined;
      if (byPairId && byPairId.observation === null) {
        byPairId.observation = event;
        byPairId.status = 'paired';
        continue;
      }
      // Unlinked observation (no matching action in stream): own pair.
      pairs.push({
        pairId: str(payload, 'pairId') ?? `seq:${event.seq}`,
        turnId: event.turnId ?? null,
        toolCallId: str(payload, 'toolCallId') ?? str(payload, 'tool_call_id') ?? '',
        toolName: recordString(payload, 'toolName') ?? recordString(payload, 'tool_name') ?? '',
        receiptId: str(payload, 'receiptId') ?? null,
        status: 'observation_only',
        action: null,
        observation: event,
      });
      continue;
    }
    if (event.type === 'tool_started' || event.type === 'tool_proposed') {
      const toolCallId = str(payload, 'tool_call_id') ?? '';
      const key = actionKey(event.turnId ?? null, toolCallId);
      const existing = pendingActions.get(key);
      if (existing) continue; // proposal followed by started: keep the first action
      const pair = startPair(event);
      attributed.add(event);
      pendingActions.set(key, pair);
      continue;
    }
    if (OBSERVATION_EVENT_TYPES.has(event.type)) {
      const toolCallId = str(payload, 'tool_call_id') ?? '';
      const key = actionKey(event.turnId ?? null, toolCallId);
      const pending = pendingActions.get(key);
      attributed.add(event);
      if (pending && pending.observation === null) {
        pending.observation = event;
        pending.status = 'paired';
        pendingActions.delete(key);
        continue;
      }
      pairs.push({
        pairId: `seq:${event.seq}`,
        turnId: event.turnId ?? null,
        toolCallId,
        toolName: recordString(payload, 'tool_name') ?? '',
        receiptId: null,
        status: 'observation_only',
        action: null,
        observation: event,
      });
    }
  }

  return {
    schemaVersion: REPLAY_INDEX_SCHEMA_VERSION,
    sessionId,
    pairs,
    unpairedEvents: events.length - attributed.size,
  };
}

export type ReplayIndexLoadResult =
  | { ok: true; runDir: string; log: EpisodeEventLog; index: ReplayIndexV1 }
  | { ok: false; reason: 'absent' | 'invalid'; detail: string };

/**
 * Load the episode stream for a conversation id from its run dir and build the
 * replay index. Fails closed on an absent or invalid stream — replay never
 * fabricates history.
 */
export function loadReplayIndexForConversation(
  runDir: string,
  conversationId: string,
): ReplayIndexLoadResult {
  const log = loadEpisodeEventLogFromDir(runDir);
  if (!log) {
    return {
      ok: false,
      reason: 'absent',
      detail: `No valid episode stream for conversation "${conversationId}" under ${runDir}.`,
    };
  }
  if (conversationId && log.sessionId !== conversationId) {
    return {
      ok: false,
      reason: 'invalid',
      detail: `Episode stream session mismatch: expected "${conversationId}", got "${log.sessionId}".`,
    };
  }
  return { ok: true, runDir, log, index: buildReplayIndex(log.events, conversationId) };
}

/** Render the replay transcript (human-readable) from a replay index. */
export function formatReplayTranscript(index: ReplayIndexV1): string {
  const lines: string[] = [];
  lines.push(`replay: session ${index.sessionId} (${index.pairs.length} action/observation pairs)`);
  for (const pair of pairsOrdered(index)) {
    const turn = pair.turnId ?? '-';
    const tool = pair.toolName || pair.toolCallId || 'unknown';
    lines.push(`\n== turn ${turn} | ${tool} | pair ${pair.pairId} | ${pair.status}` +
      (pair.receiptId ? ` | receipt ${pair.receiptId}` : ''));
    const actionPayload = asRecord(pair.action?.payload);
    const actionBody = actionPayload?.['action'];
    if (actionBody !== undefined) {
      lines.push(`  action: ${JSON.stringify(actionBody)}`);
    }
    const observationPayload = asRecord(pair.observation?.payload);
    const observationBody = observationPayload?.['observation'];
    if (observationBody !== undefined) {
      lines.push(`  observation: ${JSON.stringify(observationBody)}`);
    }
    if (pair.observation && observationBody === undefined) {
      const projected = observationProjection(pair.observation);
      if (projected !== null) lines.push(`  observation: ${projected}`);
    }
    if (pair.action === null) lines.push('  action: [not recorded]');
    if (pair.observation === null) lines.push('  observation: [not recorded]');
  }
  return lines.join('\n');
}

function pairsOrdered(index: ReplayIndexV1): ReplayActionObservationPairV1[] {
  return [...index.pairs];
}

function observationProjection(event: EpisodeEvent): string | null {
  const payload = asRecord(event.payload) ?? {};
  const parts: string[] = [];
  const content = recordString(payload, 'content');
  if (content !== null) parts.push(JSON.stringify(content));
  const exitCode = payload['exit_code'];
  if (typeof exitCode === 'number') parts.push(`exit_code=${exitCode}`);
  if (typeof payload['failed'] === 'boolean') parts.push(`failed=${String(payload['failed'])}`);
  if (typeof payload['cancelled'] === 'boolean') {
    parts.push(`cancelled=${String(payload['cancelled'])}`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
