/**
 * P04 — runtime fact projection conformance.
 *
 * Proves the new projection matches the existing LiveSessionV1 projection on a
 * pinned corpus, that only `completion.decided` authorizes a terminal, and that
 * duplicates/reordering/gaps and unknown facts degrade honestly rather than
 * inventing success.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { projectLiveSession } from '../agent/liveSession.js';
import { createSessionEventLog, type SessionEvent } from '../agent/sessionEvents.js';
import {
  sessionEventPayloads,
  sessionLogToFacts,
} from './legacyEventAdapters.js';
import { projectTask, projectTaskFromSessionEvents } from './projection.js';
import type { RuntimeFactV1 } from './events.js';

function ev(seq: number, fields: Record<string, unknown>): SessionEvent {
  return {
    schema_version: 1,
    event_id: `e${seq}`,
    session_id: 'sess-1',
    turn_id: 'turn-1',
    seq,
    ts: new Date(1700000000000 + seq * 1000).toISOString(),
    ...fields,
  } as unknown as SessionEvent;
}

function corpus(): SessionEvent[] {
  return [
    ev(1, {
      kind: 'user_submitted',
      task_preview: 'fix the bug',
      model: 'm',
      provider: 'p',
      task_class: 'general_swe',
    }),
    ev(2, { kind: 'model_started', model: 'm', provider: 'p' }),
    ev(3, {
      kind: 'tool_proposed',
      tool_call_id: 'c1',
      tool_name: 'file_read',
      idempotency_key: 'k1',
      effect_class: 'read_only',
    }),
    ev(4, {
      kind: 'tool_completed',
      tool_call_id: 'c1',
      tool_name: 'file_read',
      idempotency_key: 'k1',
      exit_code: 0,
    }),
    ev(5, {
      kind: 'mutation_batch',
      paths: ['src/a.ts'],
      batch_id: 'b1',
      status: 'commit',
      starting_revision: 'r0',
      ending_revision: 'r1',
    }),
    ev(6, { kind: 'verifier_attempt', command_preview: 'npm test', authoritative: true, exit_code: 0 }),
    ev(7, {
      kind: 'completion_decision',
      requested_outcome: 'VERIFIED_COMPLETE',
      final_outcome: 'VERIFIED_COMPLETE',
      allowed: true,
      reason: 'verifier green',
      evidence_refs: ['ev-1'],
      policy_version: 'v1',
    }),
    ev(8, { kind: 'turn_ended', outcome: 'VERIFIED_COMPLETE', status: 'completed' }),
  ];
}

test('P04: new projection matches LiveSessionV1 on a pinned corpus', () => {
  const log = createSessionEventLog('sess-1');
  log.events = corpus();
  const live = projectLiveSession({ sessionLog: log });
  const proj = projectTaskFromSessionEvents(corpus());

  assert.equal(proj.threadId, 'sess-1');
  assert.equal(proj.activeTurnId, 'turn-1');
  assert.equal(proj.execution.state, 'settled');
  assert.equal(proj.outcome?.outcome, live.terminal?.outcome);
  assert.equal(proj.outcome?.outcome, 'VERIFIED_COMPLETE');
  assert.equal(proj.outcome?.authoritative, true);
  assert.equal(proj.verifier.attempts, live.verifier.attempts);
  assert.equal(proj.verifier.authoritative, live.verifier.authoritative);
  assert.equal(proj.compactionCount, live.compaction_count);
  assert.ok(proj.tools.completedOperationIds.includes('k1'));
  assert.equal(proj.lastCursor?.stream, 'runtime-facts');
  assert.equal(proj.degraded, false);
});

test('P04: exactly one authoritative terminal producer', () => {
  const facts = sessionLogToFacts(corpus());
  const authoritativeTerminals = facts.filter(
    (f) => f.payload.type === 'completion.decided' && f.authority === 'authoritative',
  );
  const runSettled = facts.filter((f) => f.payload.type === 'run.settled');
  assert.equal(authoritativeTerminals.length, 1);
  assert.equal(runSettled.length, 1);
  assert.equal(runSettled[0]?.authority, 'observation');
  assert.equal(projectTask(facts).outcome?.authoritative, true);
});

test('P04: duplicates and reordering do not change the projection', () => {
  const base = sessionLogToFacts(corpus());
  const shuffled = [...base].reverse();
  const withDuplicates = [...shuffled, ...base, ...base];
  assert.deepEqual(projectTask(withDuplicates), projectTask(base));
});

test('P04: a sequence gap degrades the projection', () => {
  const facts = sessionLogToFacts(corpus());
  facts.splice(3, 1);
  const proj = projectTask(facts);
  assert.equal(proj.degraded, true);
  assert.ok(proj.degradedReasons.includes('sequence_gap'));
});

test('P04: unknown optional fact is preserved and does not affect state', () => {
  const facts = sessionLogToFacts(corpus());
  const optional = {
    ...facts[0]!,
    id: 'future-optional',
    sequence: 999,
    cursor: { stream: 'runtime-facts', sequence: 999 },
    schemaVersion: 2,
    authority: 'observation',
    payload: { type: 'future.optional' },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([...facts, optional]);
  assert.equal(proj.unknownAuthorityFactIds.length, 0);
  assert.ok(proj.evidenceFactIds.includes('future-optional'));
  assert.equal(proj.outcome?.outcome, 'VERIFIED_COMPLETE');
});

test('P04: unknown authority-bearing fact fails closed', () => {
  const facts = sessionLogToFacts(corpus());
  const unknownAuthority = {
    ...facts[0]!,
    id: 'future-authority',
    sequence: 998,
    cursor: { stream: 'runtime-facts', sequence: 998 },
    schemaVersion: 2,
    authority: 'authoritative',
    payload: { type: 'future.authority' },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([...facts, unknownAuthority]);
  assert.equal(proj.degraded, true);
  assert.ok(proj.degradedReasons.includes('unknown_authoritative_fact'));
  assert.ok(proj.unknownAuthorityFactIds.includes('future-authority'));
  assert.equal(
    proj.outcome?.authoritative,
    false,
    'unknown authority schema must prevent a safe authoritative claim',
  );
});

test('P04: an unsettled operation is interrupted, never a success', () => {
  const events = [
    ev(1, { kind: 'user_submitted', task_preview: 'start something' }),
    ev(2, {
      kind: 'tool_proposed',
      tool_call_id: 'c9',
      tool_name: 'shell_exec',
      idempotency_key: 'k9',
      effect_class: 'non_idempotent_local_effect',
    }),
  ];
  const proj = projectTaskFromSessionEvents(events);
  assert.ok(proj.tools.interruptedOperationIds.includes('k9'));
  assert.equal(proj.outcome, null, 'no terminal fact means no terminal claim');
});

test('P04: non-authoritative verifier maps to observation authority', () => {
  const facts = sessionLogToFacts([
    ev(1, { kind: 'verifier_attempt', command_preview: 'echo hi', authoritative: false }),
  ]);
  assert.equal(facts[0]?.payload.type, 'verification.recorded');
  assert.equal(facts[0]?.authority, 'observation');
});

test('P04: adapter is total for non-semantic kinds', () => {
  assert.deepEqual(
    sessionEventPayloads(ev(1, { kind: 'gate_decision', decision: 'allow', detail: 'x' })),
    [],
  );
  assert.deepEqual(
    sessionEventPayloads(ev(2, { kind: 'model_invocation_phase', inference_id: 'i', provider: 'p', model: 'm', phase: 'request_dispatched' })),
    [],
  );
});
