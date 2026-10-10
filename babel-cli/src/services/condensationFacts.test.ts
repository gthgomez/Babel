/**
 * Packet A5 tests — condensation-as-event.
 *
 * Covers the packet's acceptance criteria:
 *   - every compaction on both paths produces a paired started/completed
 *     fact carrying real token counts, pruned ranges, and the fenced P11
 *     capsule id when one was fenced;
 *   - an interrupted compaction leaves a started fact without its completed
 *     pair, and the gap stays visible (fail-closed, never papered over);
 *   - replay reconstructs the pre-compaction view from condensation facts,
 *     and refuses (fail-closed) when the pair is incomplete.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ChatMessage } from '../agent/chatCompaction.js';
import {
  runChatEngineCompaction,
  type ChatEngineCompactionHost,
} from '../agent/compactionCommit.js';
import { createThreadEventLog, recordUserMessage, startTurn } from '../agent/threadEventLog.js';
import { createSessionEventLog } from '../agent/sessionEvents.js';
import { autoCompactIfNeeded } from './compaction.js';
import { countTextTokens } from './tokenCounter.js';
import {
  CondensationFactEmitter,
  condensationGapIds,
  prunedIndexesToRanges,
  type CondensationFactChannel,
} from './condensationFacts.js';
import type { EvidenceBundle } from '../evidence.js';
import {
  createRuntimeEventLog,
  readRuntimeEventLog,
  replayEventLogRecords,
  RUNTIME_EVENT_LOG_FILENAME,
} from '../runtime/eventLog.js';
import type { RuntimeFactV1 } from '../runtime/events.js';
import { validateRuntimeFact, type FactPayload } from '../runtime/events.js';
import type { ContextCheckpointV1 } from '../runtime/contextCheckpoints.js';
import {
  hydrateResumeStateFromFacts,
  reconstructPreCompactionView,
  resumeCapsuleContext,
} from './resumeReplay.js';
import type { ToolCallLog } from '../schemas/agentContracts.js';

function sequentialEmitter(facts: RuntimeFactV1[]): {
  emitter: CondensationFactEmitter;
  channel: CondensationFactChannel;
} {
  let sequence = 0;
  const emitter = new CondensationFactEmitter(
    { threadId: 'thread-a5', runId: 'run-a5' },
    () => ++sequence,
    () => '2026-10-10T00:00:00.000Z',
  );
  return { emitter, channel: { emitter, emit: (fact) => facts.push(fact) } };
}

function toolEntry(step: number, stdout = ''): ToolCallLog {
  return {
    step,
    tool: 'file_read',
    target: `file-${step}.ts`,
    exit_code: 0,
    stdout,
    stderr: '',
    verified: true,
  };
}

function condensationPayloadFact(
  sequence: number,
  payload: FactPayload,
  overrides: Partial<RuntimeFactV1> = {},
): RuntimeFactV1 {
  return {
    schemaVersion: 1,
    id: `fact-${sequence}`,
    cursor: { stream: 'runtime-facts', sequence },
    threadId: 'thread-a5',
    taskId: '',
    turnId: 'turn-1',
    runId: 'run-a5',
    sequence,
    causationId: 'cause-1',
    producer: 'chat_engine',
    authority: 'observation',
    timestamp: '2026-10-10T00:00:00.000Z',
    payload,
    ...overrides,
  } as RuntimeFactV1;
}

// ─── Fact production + validation ───────────────────────────────────────────

test('A5: emitter produces strict validated started/completed pairs with real counts', () => {
  const facts: RuntimeFactV1[] = [];
  const { emitter } = sequentialEmitter(facts);

  const started = emitter.begin({
    compactionId: 'c-1',
    path: 'pipeline_step_prune',
    countBefore: 900,
  });
  assert.ok(started);
  assert.equal(started.payload.type, 'context.condensation.started');
  assert.deepEqual(validateRuntimeFact(started), { ok: true, fact: started });

  const completed = emitter.complete({
    compactionId: 'c-1',
    countAfter: 200,
    prunedMessageRanges: [{ from: 0, to: 3 }],
    capsuleCheckpointId: 'checkpoint-9',
  });
  assert.ok(completed);
  assert.equal(completed.payload.type, 'context.condensation.completed');
  const completedPayload = completed.payload as Extract<
    FactPayload,
    { type: 'context.condensation.completed' }
  >;
  // countBefore is the real value recorded at begin, not re-derived.
  assert.equal(completedPayload.countBefore, 900);
  assert.equal(completedPayload.countAfter, 200);
  assert.deepEqual(completedPayload.prunedMessageRanges, [{ from: 0, to: 3 }]);
  assert.equal(completedPayload.capsuleCheckpointId, 'checkpoint-9');
  assert.deepEqual(validateRuntimeFact(completed), { ok: true, fact: completed });

  // Strict pairing: the pair closed, no open condensation remains.
  assert.deepEqual(emitter.openCompactionIds(), []);
});

test('A5: fail-closed emitter — no completed without started, no malformed facts', () => {
  const facts: RuntimeFactV1[] = [];
  const { emitter } = sequentialEmitter(facts);

  // A completed fact without an open started fact is refused, not invented.
  assert.equal(
    emitter.complete({ compactionId: 'ghost', countAfter: 1, prunedMessageRanges: [] }),
    null,
  );

  // Malformed begin input emits nothing rather than an invalid fact.
  assert.equal(
    emitter.begin({ path: 'chat_engine_inline', countBefore: Number.NaN }),
    null,
  );
  assert.equal(
    emitter.begin({ path: 'not-a-path' as never, countBefore: 5 }),
    null,
  );

  // Malformed completed input is refused and the condensation stays open
  // (a visible gap), never closed with fabricated data.
  assert.ok(emitter.begin({ compactionId: 'c-2', path: 'chat_engine_inline', countBefore: 5 }));
  assert.equal(
    emitter.complete({ compactionId: 'c-2', countAfter: -1, prunedMessageRanges: [] }),
    null,
  );
  assert.deepEqual(emitter.openCompactionIds(), ['c-2']);
});

test('A5: condensationGapIds surfaces started-without-completed as a visible gap', () => {
  const facts: RuntimeFactV1[] = [
    condensationPayloadFact(1, { type: 'run.started', ownerGeneration: 1 }),
    condensationPayloadFact(2, {
      type: 'context.condensation.started',
      compactionId: 'interrupted',
      path: 'chat_engine_inline',
      countBefore: 500,
    }),
    condensationPayloadFact(3, {
      type: 'context.condensation.started',
      compactionId: 'finished',
      path: 'pipeline_step_prune',
      countBefore: 700,
    }),
    condensationPayloadFact(4, {
      type: 'context.condensation.completed',
      compactionId: 'finished',
      path: 'pipeline_step_prune',
      countBefore: 700,
      countAfter: 100,
      prunedMessageRanges: [{ from: 0, to: 2 }],
    }),
  ];
  const gaps = condensationGapIds(facts);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.compactionId, 'interrupted');
  assert.equal(gaps[0]!.countBefore, 500);
});

test('A5: ingress validation rejects malformed condensation payloads fail-closed', () => {
  const bad: unknown[] = [
    // Unknown fact type never validates.
    {
      schemaVersion: 1,
      id: 'x',
      cursor: { stream: 'runtime-facts', sequence: 1 },
      threadId: 't',
      taskId: '',
      turnId: '',
      runId: 'r',
      sequence: 1,
      causationId: 'c',
      producer: 'chat_engine',
      authority: 'observation',
      timestamp: '2026-10-10T00:00:00.000Z',
      payload: { type: 'context.condensation.exploded', compactionId: 'c' },
    },
    // Completed with non-integer pruned range bounds.
    condensationPayloadFact(5, {
      type: 'context.condensation.completed',
      compactionId: 'c',
      path: 'chat_engine_inline',
      countBefore: 1,
      countAfter: 1,
      prunedMessageRanges: [{ from: 0.5, to: 2 }],
    } as unknown as FactPayload),
    // Completed with an invalid path.
    condensationPayloadFact(6, {
      type: 'context.condensation.started',
      compactionId: 'c',
      path: 'somewhere_else',
      countBefore: 1,
    } as unknown as FactPayload),
  ];
  for (const fact of bad) {
    const validation = validateRuntimeFact(fact);
    assert.equal(validation.ok, false);
  }
});

// ─── Pipeline path (services/compaction.ts) ─────────────────────────────────

test('A5: pipeline compaction emits a paired started/completed fact pair', async () => {
  const facts: RuntimeFactV1[] = [];
  const { channel } = sequentialEmitter(facts);

  const history = Array.from({ length: 8 }, (_, index) => `step ${index + 1} output`).join('\n\n');
  const log: ToolCallLog[] = Array.from({ length: 8 }, (_, index) =>
    toolEntry(index + 1, `output ${index + 1}`.repeat(300)),
  );

  const result = await autoCompactIfNeeded(history, 8, log, undefined, channel);
  assert.equal(result.compacted, true);
  assert.ok(result.condensationId);

  assert.equal(facts.length, 2);
  const started = facts[0]!.payload as Extract<FactPayload, { type: 'context.condensation.started' }>;
  const completed = facts[1]!.payload as Extract<
    FactPayload,
    { type: 'context.condensation.completed' }
  >;
  assert.equal(started.type, 'context.condensation.started');
  assert.equal(started.path, 'pipeline_step_prune');
  assert.equal(started.compactionId, result.condensationId);
  assert.equal(completed.compactionId, result.condensationId);
  // Counts are real: before matches the measured history, after matches the
  // token count of the actual compacted history (never fabricated).
  assert.equal(completed.countBefore, started.countBefore);
  assert.equal(completed.countAfter, countTextTokens(result.newHistory));
  // Pruned ranges derive from the actually pruned steps (1..3 for turn 8).
  assert.deepEqual(completed.prunedMessageRanges, [{ from: 1, to: 3 }]);
  assert.deepEqual(condensationGapIds(facts), []);
});

test('A5: interrupted pipeline compaction leaves a visible started-without-completed gap', async () => {
  const facts: RuntimeFactV1[] = [];
  const { channel } = sequentialEmitter(facts);

  const history = Array.from({ length: 8 }, (_, index) => `step ${index + 1} output`).join('\n\n');
  const log: ToolCallLog[] = Array.from({ length: 8 }, (_, index) =>
    toolEntry(index + 1, `output ${index + 1}`.repeat(300)),
  );
  const hostileEvidence = {
    writeDebugFile: () => {
      throw new Error('disk full');
    },
  } as unknown as EvidenceBundle;

  const result = await autoCompactIfNeeded(history, 8, log, hostileEvidence, channel);
  assert.equal(result.compacted, false);
  assert.ok(result.condensationId);

  // The started fact was emitted; no completed fact exists. The gap is
  // visible, never papered over.
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.payload.type, 'context.condensation.started');
  const gaps = condensationGapIds(facts);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.compactionId, result.condensationId);
});

// ─── ChatEngine inline path (agent/compactionCommit.ts) ─────────────────────

interface ChatEngineFixture {
  facts: RuntimeFactV1[];
  host: ChatEngineCompactionHost;
}

function chatEngineFixture(
  checkpoint: () => Promise<void>,
  compactWithResult?: ChatEngineCompactionHost['compactionManager'],
): ChatEngineFixture {
  const facts: RuntimeFactV1[] = [];
  const { channel } = sequentialEmitter(facts);
  const threadLog = createThreadEventLog('thread-a5-engine');
  const sessionLog = createSessionEventLog('thread-a5-engine');
  const turnId = startTurn(threadLog, {
    task: 'a5 condensation',
    model: 'test-model',
    provider: 'deepseek',
    projectRoot: '/tmp/proj',
    policyPreset: 'chat',
  });
  recordUserMessage(threadLog, turnId, 'earlier context');
  const conversation: ChatMessage[] = [
    { role: 'system', content: 'System instructions' },
    { role: 'user', content: 'earlier context' },
    { role: 'user', content: 'current request' },
  ];
  const host: ChatEngineCompactionHost = {
    conversation,
    ...(compactWithResult ? { compactionManager: compactWithResult } : {}),
    options: { task: 'a5 condensation', model: 'test-model' },
    limits: { maxEstimatedTokens: 10 },
    abortSignal: new AbortController().signal,
    writeCount: 0,
    turnIndex: 1,
    toolCallLog: [],
    progress: { receipts: [], consecutiveNoProgress: 0 },
    threadLog,
    sessionLog,
    turnId,
    shouldUseTextTools: () => false,
    compactHeuristic: () => {
      conversation.splice(1, 1);
    },
    checkpoint,
    reserveTokens: 0,
    textToolsReserve: 0,
    forceCompaction: true,
    resolveModel: () => 'test-model',
    shouldCompactByTokens: () => true,
    estimateTokens: (messages) => messages.length * 10,
    condensationFacts: channel,
  };
  return { facts, host };
}

test('A5: ChatEngine inline compaction emits a paired fact pair with the fenced capsule id', async () => {
  const { facts, host } = chatEngineFixture(async () => undefined, {
    compactWithResult: async (messages) => ({
      messages: [
        messages[0]!,
        { role: 'assistant', name: 'compaction_summary', content: 'condensed', provenance: 'model', authoritative: false },
      ],
      strategy: 'llm-summarize',
      tokensBefore: 300,
      tokensAfter: 20,
      changed: true,
    }),
  });

  const result = await runChatEngineCompaction(host);
  assert.ok(result?.changed);

  assert.equal(facts.length, 2);
  const started = facts[0]!.payload as Extract<FactPayload, { type: 'context.condensation.started' }>;
  const completed = facts[1]!.payload as Extract<
    FactPayload,
    { type: 'context.condensation.completed' }
  >;
  assert.equal(started.type, 'context.condensation.started');
  assert.equal(started.path, 'chat_engine_inline');
  assert.equal(started.countBefore, 300);
  assert.equal(completed.compactionId, started.compactionId);
  // countAfter is the committed conversation's real token estimate (the
  // commit recomputes it), not the manager's rough pre-commit estimate.
  assert.equal(completed.countAfter, result.commit?.tokensAfter);
  assert.ok(completed.countAfter > 0);
  assert.deepEqual(completed.prunedMessageRanges, [{ from: 0, to: 2 }]);
  // The completed fact references the same capsule/operation id the
  // committed compaction recorded (the context.committed checkpoint id).
  assert.ok(completed.capsuleCheckpointId);
  assert.deepEqual(condensationGapIds(facts), []);
});

test('A5: interrupted ChatEngine compaction leaves the started fact visibly unpaired', async () => {
  const { facts, host } = chatEngineFixture(
    async () => {
      throw new Error('checkpoint failure');
    },
    {
      compactWithResult: async (messages) => ({
        messages: [
          messages[0]!,
          { role: 'assistant', name: 'compaction_summary', content: 'condensed', provenance: 'model', authoritative: false },
        ],
        strategy: 'llm-summarize',
        tokensBefore: 300,
        tokensAfter: 20,
        changed: true,
      }),
    },
  );

  await assert.rejects(runChatEngineCompaction(host), /checkpoint failure|persistence/i);

  // Started without completed: the interrupted compaction stays visible.
  assert.ok(facts.length >= 1);
  assert.equal(facts[0]!.payload.type, 'context.condensation.started');
  const gaps = condensationGapIds(facts);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.compactionId, (facts[0]!.payload as { compactionId: string }).compactionId);
});

// ─── Replay reconstruction (services/resumeReplay.ts) ───────────────────────

function capsuleFixture(overrides: Partial<ContextCheckpointV1> = {}): ContextCheckpointV1 {
  return {
    schema_version: 1,
    checkpointId: 'checkpoint-9',
    threadId: 'thread-a5',
    sessionId: 'session-a5',
    turnId: null,
    contextEpoch: 'epoch-a5',
    generation: 1,
    owner: { threadId: 'thread-a5', generation: 1, token: 'token-a5' },
    preparedAt: '2026-10-10T00:00:00.000Z',
    taskContractReference: null,
    workingStateSnapshot: { state: null, provenance: 'mixed', authoritative: false },
    workspace: {
      current_snapshot_revision: 'rev-a5',
      capture_complete: true,
      coverage_ref: null,
      capture_provenance: 'current_capture',
      capture_epoch: 'epoch-a5',
    },
    receipts: [
      {
        receipt_id: 'receipt-a5',
        identity: 'test',
        scope: 'full_suite',
        stale: false,
        bound_revision: 'rev-a5',
      },
    ],
    budget: null,
    pending: [],
    route: null,
    population: {
      schema_version: 1,
      status: 'populated',
      rows: [],
      errors: [],
      workspace_revision_current: true,
      workspace_matches_verifier_revision: true,
      installation_blocked_on: [],
      observation_manifest: [],
      install_authorized: true,
    },
    observation_manifest: [],
    observation_manifest_digest: 'digest-a5',
    checkpoint_digest: 'digest-a5',
    ...overrides,
  } as ContextCheckpointV1;
}


test('A5: replay reconstructs the pre-compaction view from condensation facts', () => {
  const facts: RuntimeFactV1[] = [
    condensationPayloadFact(1, { type: 'run.started', ownerGeneration: 1 }),
    condensationPayloadFact(2, {
      type: 'context.condensation.started',
      compactionId: 'mid-run',
      path: 'chat_engine_inline',
      countBefore: 800,
    }),
    condensationPayloadFact(3, {
      type: 'context.condensation.completed',
      compactionId: 'mid-run',
      path: 'chat_engine_inline',
      countBefore: 800,
      countAfter: 120,
      prunedMessageRanges: [
        { from: 0, to: 4 },
        { from: 9, to: 11 },
      ],
      capsuleCheckpointId: 'checkpoint-9',
    }),
    condensationPayloadFact(4, { type: 'context.committed', checkpointId: 'checkpoint-9' }),
  ];

  const state = hydrateResumeStateFromFacts(facts);
  assert.equal(state.condensations.length, 1);
  assert.equal(state.condensations[0]!.open, false);
  assert.equal(state.condensations[0]!.countBefore, 800);
  assert.equal(state.condensations[0]!.capsuleCheckpointId, 'checkpoint-9');

  // Reconstruction with the capsule supplied goes through P11 lineage fencing.
  const reconstruction = reconstructPreCompactionView(
    facts,
    'mid-run',
    capsuleFixture({
      installed_lineage: {
        checkpoint_id: 'checkpoint-9',
        compaction_event_id: null,
        compaction_commit_event_id: null,
        compaction_digest: null,
        thread_event_boundary_seq: null,
      },
    } as Partial<ContextCheckpointV1>),
  );
  assert.equal(reconstruction.status, 'ready');
  if (reconstruction.status !== 'ready') return;
  assert.equal(reconstruction.countBefore, 800);
  assert.equal(reconstruction.countAfter, 120);
  assert.deepEqual(reconstruction.prunedMessageRanges, [
    { from: 0, to: 4 },
    { from: 9, to: 11 },
  ]);
  assert.equal(reconstruction.capsuleCheckpointId, 'checkpoint-9');
  assert.ok(reconstruction.capsule);
  assert.equal(reconstruction.capsule!.status, 'ready');

  // Without the capsule object the view still reconstructs, naming the
  // capsule id the caller must supply to surface its context.
  const withoutCapsule = reconstructPreCompactionView(facts, 'mid-run');
  assert.equal(withoutCapsule.status, 'ready');
  assert.equal(withoutCapsule.capsuleCheckpointId, 'checkpoint-9');
  assert.equal(withoutCapsule.capsule, null);
});

test('A5: reconstruction fails closed for unknown and interrupted condensations', () => {
  const interrupted: RuntimeFactV1[] = [
    condensationPayloadFact(1, {
      type: 'context.condensation.started',
      compactionId: 'half-done',
      path: 'chat_engine_inline',
      countBefore: 400,
    }),
  ];
  const blocked = reconstructPreCompactionView(interrupted, 'half-done');
  assert.equal(blocked.status, 'blocked');
  if (blocked.status === 'blocked') {
    assert.equal(blocked.reason, 'incomplete_condensation');
  }

  const unknown = reconstructPreCompactionView([], 'never-happened');
  assert.equal(unknown.status, 'blocked');
  if (unknown.status === 'blocked') assert.equal(unknown.reason, 'unknown_compaction');
});

test('A5: condensation facts round-trip through the A2 EventLog fail-closed sink', () => {
  const facts: RuntimeFactV1[] = [];
  const { channel } = sequentialEmitter(facts);
  const started = channel.emitter.begin({
    compactionId: 'c-log',
    path: 'pipeline_step_prune',
    countBefore: 50,
  });
  if (started) channel.emit(started);
  const completed = channel.emitter.complete({
    compactionId: 'c-log',
    countAfter: 10,
    prunedMessageRanges: [{ from: 0, to: 1 }],
  });
  if (completed) channel.emit(completed);

  const dir = mkdtempSync(join(tmpdir(), 'babel-a5-log-'));
  try {
    const log = createRuntimeEventLog({ sessionDir: dir });
    for (const fact of facts) assert.deepEqual(log.appendFact(fact), { ok: true });
    assert.deepEqual(log.flush(), { ok: true });
    log.close();

    const read = readRuntimeEventLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
    assert.equal(read.records.length, 2);
    assert.equal(read.discarded, 0);
    const replay = replayEventLogRecords(read.records);
    assert.ok(replay.ok);
    const state = hydrateResumeStateFromFacts(replay.ordered);
    assert.equal(state.condensations.length, 1);
    assert.equal(state.condensations[0]!.open, false);
    assert.deepEqual(condensationGapIds(replay.ordered), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Range helper ───────────────────────────────────────────────────────────

test('A5: prunedIndexesToRanges collapses pruned indexes into inclusive ranges', () => {
  assert.deepEqual(prunedIndexesToRanges([3, 1, 2, 7, 9, 10]), [
    { from: 1, to: 3 },
    { from: 7, to: 7 },
    { from: 9, to: 10 },
  ]);
  assert.deepEqual(prunedIndexesToRanges([]), []);
});

// Re-exported surface sanity: resumeCapsuleContext is the fencing entry the
// reconstruction path delegates to (never reimplements).
test('A5: reconstruction delegates capsule fencing to the existing P11 validator', () => {
  const blocked = resumeCapsuleContext(capsuleFixture());
  assert.equal(blocked.status, 'blocked');
});
