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

test('P04: unknown authority demotes the verifier badge as well as the outcome', () => {
  const facts = sessionLogToFacts(corpus());
  const unknownAuthority = {
    ...facts[0]!,
    id: 'future-authority-2',
    sequence: 998,
    cursor: { stream: 'runtime-facts', sequence: 998 },
    schemaVersion: 2,
    authority: 'authoritative',
    payload: { type: 'future.authority' },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([...facts, unknownAuthority]);
  assert.equal(proj.outcome?.authoritative, false);
  assert.equal(
    proj.verifier.authoritative,
    false,
    'a client reading only the verifier badge must not claim verified state',
  );
});

test('P04: reordering with unknown optional facts is deterministic', () => {
  const facts = sessionLogToFacts(corpus());
  const optional = {
    ...facts[0]!,
    id: 'future-optional-2',
    sequence: 999,
    cursor: { stream: 'runtime-facts', sequence: 999 },
    schemaVersion: 2,
    authority: 'observation',
    payload: { type: 'future.optional' },
  } as unknown as RuntimeFactV1;
  const forward = projectTask([...facts, optional]);
  const reverse = projectTask([optional, ...[...facts].reverse()]);
  assert.deepEqual(forward, reverse);
  assert.ok(forward.evidenceFactIds.includes('future-optional-2'));
});

test('P04: observation-authority completion.decided does not authorize', () => {
  const facts = sessionLogToFacts(corpus());
  const demoted = facts.map((fact) =>
    fact.payload.type === 'completion.decided' && fact.authority === 'authoritative'
      ? { ...fact, authority: 'observation' as const }
      : fact,
  );
  const proj = projectTask(demoted);
  assert.equal(proj.outcome?.outcome, 'VERIFIED_COMPLETE');
  assert.equal(proj.outcome?.authoritative, false);
  // The verifier receipt is independently authoritative; only the completion
  // claim was demoted.
  assert.equal(proj.verifier.authoritative, true);
});

test('P04: mutation prepare/rollback do not imply success', () => {
  const rollback = projectTaskFromSessionEvents([
    ev(1, { kind: 'mutation_batch', paths: ['src/a.ts'], batch_id: 'b9', status: 'rollback' }),
  ]);
  assert.ok(rollback.tools.interruptedOperationIds.includes('b9'));
  assert.ok(!rollback.tools.completedOperationIds.includes('b9'));

  const prepare = projectTaskFromSessionEvents([
    ev(1, { kind: 'mutation_batch', paths: ['src/a.ts'], batch_id: 'b8', status: 'prepare' }),
  ]);
  assert.ok(prepare.tools.openOperationIds.includes('b8'));
  assert.ok(!prepare.tools.completedOperationIds.includes('b8'));
});

test('P04: a terminal phase does not regress after a later observation', () => {
  const proj = projectTaskFromSessionEvents([
    ev(1, { kind: 'user_submitted', task_preview: 'do it' }),
    ev(2, {
      kind: 'completion_decision',
      requested_outcome: 'UNVERIFIED_PATCH',
      final_outcome: 'UNVERIFIED_PATCH',
      allowed: true,
      reason: 'done',
      evidence_refs: [],
      policy_version: 'v1',
    }),
    ev(3, { kind: 'verifier_attempt', command_preview: 'npm test', authoritative: true, exit_code: 0 }),
  ]);
  assert.equal(proj.phase, 'terminal');
  assert.equal(proj.outcome?.authoritative, true);
});

test('P04: a malformed known fact degrades without throwing', () => {
  const proj = projectTask([
    {
      ...sessionLogToFacts(corpus())[0]!,
      id: 'broken',
      payload: { type: 'completion.decided' },
    } as unknown as RuntimeFactV1,
  ]);
  assert.equal(proj.outcome, null);
  assert.equal(proj.degraded, true);
  assert.ok(proj.degradedReasons.some((reason) => reason.startsWith('invalid_fact:')));
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

test('P04: distinct unknown-authority facts are order-independent', () => {
  const facts = sessionLogToFacts(corpus());
  const ua = (id: string, sequence: number): RuntimeFactV1 =>
    ({
      ...facts[0]!,
      id,
      sequence,
      cursor: { stream: 'runtime-facts', sequence },
      schemaVersion: 2,
      authority: 'authoritative',
      payload: { type: 'future.authority' },
    }) as unknown as RuntimeFactV1;
  const forward = projectTask([...facts, ua('ua1', 10), ua('ua2', 11)]);
  const reverse = projectTask([...facts, ua('ua2', 11), ua('ua1', 10)]);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.unknownAuthorityFactIds, ['ua1', 'ua2']);
});

test('P04: duplicate id with differing envelope authority is deterministic', () => {
  const facts = sessionLogToFacts(corpus());
  const completion = facts.find((f) => f.payload.type === 'completion.decided')!;
  const authoritative: RuntimeFactV1 = { ...completion, authority: 'authoritative' };
  const observation: RuntimeFactV1 = { ...completion, authority: 'observation' };
  const forward = projectTask([authoritative, observation]);
  const reverse = projectTask([observation, authoritative]);
  assert.deepEqual(forward, reverse);
  // The conflict winner is chosen by the deterministic content key and the
  // projection is marked degraded, so consumers must not trust the claim.
  assert.ok(forward.degradedReasons.includes('conflicting_duplicate_fact'));
});

test('P04: non-serializable payload degrades without throwing', () => {
  const base = sessionLogToFacts(corpus())[0]!;
  const payload: Record<string, unknown> = {
    type: 'completion.decided',
    decision: {
      requestedOutcome: 'x',
      finalOutcome: 'VERIFIED_COMPLETE',
      allowed: true,
      reason: 'r',
      evidenceRefs: [],
      policyVersion: 'v1',
    },
  };
  payload['self'] = payload; // cyclic payload
  const cyclic = { ...base, id: 'cyclic', payload } as unknown as RuntimeFactV1;
  const proj = projectTask([cyclic]);
  assert.equal(proj.outcome, null);
  assert.equal(proj.degraded, true);
  assert.ok(proj.degradedReasons.some((reason) => reason.includes('unserializable_payload')));
});

test('P04: an observation run.settled terminal does not regress', () => {
  const proj = projectTaskFromSessionEvents([
    ev(1, { kind: 'user_submitted', task_preview: 'do it' }),
    ev(2, { kind: 'turn_ended', outcome: 'CANCELLED', status: 'cancelled' }),
    ev(3, { kind: 'verifier_attempt', command_preview: 'npm test', authoritative: true, exit_code: 0 }),
  ]);
  assert.equal(proj.phase, 'terminal');
  assert.equal(proj.outcome?.authoritative, false);
});

test('P04: id-less unknown authority fact still demotes every authority claim', () => {
  const facts = sessionLogToFacts(corpus());
  const idless = {
    ...facts[0]!,
    schemaVersion: 2,
    authority: 'authoritative',
    payload: { type: 'future.authority' },
  } as unknown as RuntimeFactV1;
  delete (idless as { id?: string }).id;
  const proj = projectTask([...facts, idless]);
  assert.equal(proj.outcome?.authoritative, false, 'demotion must not depend on the id list');
  assert.equal(proj.verifier.authoritative, false);
});

test('P04: hostile envelope accessors do not throw and fail closed', () => {
  const facts = sessionLogToFacts(corpus());
  const hostile = {
    get authority(): never {
      throw new Error('boom');
    },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([...facts, hostile]);
  assert.equal(proj.outcome?.authoritative, false);
  assert.ok(proj.degradedReasons.some((reason) => reason.includes('inaccessible_fact')));
});

test('P04: unknown optional fact with hostile envelope getter does not throw', () => {
  const facts = sessionLogToFacts(corpus());
  const hostile = {
    schemaVersion: 2,
    id: 'hostile-opt',
    authority: 'observation',
    payload: { type: 'future.optional' },
    get threadId(): never {
      throw new Error('boom');
    },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([...facts, hostile]);
  assert.ok(proj.degradedReasons.some((reason) => reason.includes('inaccessible_fact')));
  assert.equal(proj.outcome?.authoritative, false, 'inaccessible facts fail closed');
});

test('P04: JSON-collapsing duplicate pair is order-independent', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const a = {
    ...template,
    id: 'n',
    sequence: 400,
    payload: { type: 'run.settled', status: Number.NaN },
  } as unknown as RuntimeFactV1;
  const b = {
    ...template,
    id: 'n',
    sequence: 400,
    payload: { type: 'run.settled', status: Number.POSITIVE_INFINITY },
  } as unknown as RuntimeFactV1;
  assert.deepEqual(projectTask([a, b]), projectTask([b, a]));
});

test('P04: malformed completion/indeterminate payloads degrade without throwing', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const noEvidenceRefs = {
    ...template,
    id: 'no-refs',
    payload: {
      type: 'completion.decided',
      decision: { requestedOutcome: 'x', finalOutcome: 'y', allowed: true, reason: 'r', policyVersion: 'v1' },
    },
  } as unknown as RuntimeFactV1;
  const numericReason = {
    ...template,
    id: 'num-reason',
    payload: { type: 'operation.indeterminate', operationDigest: 'd', reason: 5 },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([noEvidenceRefs, numericReason]);
  assert.equal(proj.outcome, null);
  assert.equal(proj.degraded, true);
});

test('P04: optional facts with non-finite sequence are order-independent', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const a = {
    ...template,
    id: 'oa',
    schemaVersion: 2,
    authority: 'observation',
    sequence: Number.NaN,
    cursor: { stream: 'runtime-facts', sequence: Number.NaN },
    payload: { type: 'future.optional' },
  } as unknown as RuntimeFactV1;
  const b = {
    ...template,
    id: 'ob',
    schemaVersion: 2,
    authority: 'observation',
    sequence: Number.POSITIVE_INFINITY,
    cursor: { stream: 'runtime-facts', sequence: Number.POSITIVE_INFINITY },
    payload: { type: 'future.optional' },
  } as unknown as RuntimeFactV1;
  assert.deepEqual(projectTask([a, b]), projectTask([b, a]));
});

test('P04: canonical special-value tags cannot be forged by user objects', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const nan = {
    ...template,
    id: 'tag',
    sequence: 400,
    payload: { type: 'run.settled', status: Number.NaN },
  } as unknown as RuntimeFactV1;
  const forgedTag = {
    ...template,
    id: 'tag',
    sequence: 400,
    payload: { type: 'run.settled', status: { $number: 'NaN' } },
  } as unknown as RuntimeFactV1;
  assert.deepEqual(projectTask([nan, forgedTag]), projectTask([forgedTag, nan]));
});

test('P04: boxed primitives and class instances cannot collide with plain objects', () => {
  class A {
    a = 1;
  }
  class B {
    a = 1;
  }
  const template = sessionLogToFacts(corpus())[0]!;
  const mk = (status: unknown) =>
    ({
      ...template,
      id: 'c',
      sequence: 1,
      payload: { type: 'run.settled', status },
    }) as unknown as RuntimeFactV1;
  const boxed = mk(new String('x'));
  const plain = mk({ 0: 'x' });
  const instanceA = mk(new A());
  const instanceB = mk(new B());
  assert.deepEqual(projectTask([boxed, plain]), projectTask([plain, boxed]));
  assert.deepEqual(projectTask([instanceA, instanceB]), projectTask([instanceB, instanceA]));
  assert.equal(projectTask([boxed, plain]).degraded, true);
});

test('P04: a stateful throwing getter cannot escape projectTask', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  let reads = 0;
  const fact = new Proxy(
    { ...template },
    {
      get(target, property, receiver) {
        if (property === 'authority' && ++reads > 2) throw new Error('boom');
        return Reflect.get(target, property, receiver);
      },
    },
  ) as unknown as RuntimeFactV1;
  assert.doesNotThrow(() => projectTask([fact]));
});

test('P04: deeply nested payloads degrade deterministically instead of colliding', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const deep = (depth: number): unknown => {
    let cursor: unknown = 'x';
    for (let i = 0; i < depth; i += 1) cursor = { v: cursor };
    return cursor;
  };
  const mk = (marker: string) =>
    ({
      ...template,
      id: 'dup',
      sequence: 7,
      payload: { type: 'run.settled', status: { marker, deep: deep(5000) } },
    }) as unknown as RuntimeFactV1;
  const a = mk('A');
  const b = mk('B');
  const forward = projectTask([a, b]);
  const reverse = projectTask([b, a]);
  assert.equal(forward.degraded, true);
  assert.deepEqual(forward, reverse);
});

test('P04: own __proto__ payload keys cannot merge distinct facts', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const mk = (operationId: string) =>
    ({
      ...template,
      id: 'dup',
      sequence: 7,
      payload: JSON.parse(
        `{"type":"operation.settled","receiptId":"r","__proto__":{"operationId":"${operationId}"}}`,
      ),
    }) as unknown as RuntimeFactV1;
  const forward = projectTask([mk('OP_A'), mk('OP_B')]);
  const reverse = projectTask([mk('OP_B'), mk('OP_A')]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.degraded, true);
});

test('P04: shared-reference payload amplification is rejected', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const shared: { v: string } = { v: 'x' };
  let node: unknown = shared;
  for (let i = 0; i < 30; i += 1) node = { a: node, b: node };
  const fact = {
    ...template,
    id: 'dag',
    payload: { type: 'run.settled', status: node },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([fact]);
  assert.equal(proj.degraded, true);
  assert.ok(proj.degradedReasons.some((reason) => reason.includes('unserializable_payload')));
});

test('P04: an observation completion cannot replace an authoritative one', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  const authoritative = {
    ...template,
    id: 'a',
    sequence: 10,
    authority: 'authoritative',
    payload: {
      type: 'completion.decided',
      decision: {
        requestedOutcome: 'x',
        finalOutcome: 'VERIFIED_COMPLETE',
        allowed: true,
        reason: 'ok',
        evidenceRefs: [],
        policyVersion: 'v1',
      },
    },
  } as unknown as RuntimeFactV1;
  const observation = {
    ...template,
    id: 'b',
    sequence: 20,
    authority: 'observation',
    payload: {
      type: 'completion.decided',
      decision: {
        requestedOutcome: 'x',
        finalOutcome: 'OBS',
        allowed: true,
        reason: 'obs',
        evidenceRefs: [],
        policyVersion: 'v1',
      },
    },
  } as unknown as RuntimeFactV1;
  const proj = projectTask([authoritative, observation]);
  assert.equal(proj.outcome?.outcome, 'VERIFIED_COMPLETE');
  assert.equal(proj.outcome?.authoritative, true);
});

test('P04: projectTask bounds the number of facts consumed', () => {
  const template = sessionLogToFacts(corpus())[0]!;
  let produced = 0;
  function* endless(): Generator<RuntimeFactV1> {
    while (true) {
      produced += 1;
      yield { ...template, id: `f${produced}`, sequence: produced } as RuntimeFactV1;
    }
  }
  const proj = projectTask(endless());
  assert.ok(proj.degradedReasons.includes('fact_count_exceeded'));
  assert.ok(produced <= 100_001, `stopped after ${produced} facts`);
});

test('P04: a stateful authority getter cannot make the projection order-dependent', () => {
  const make = (finalOutcome: string): RuntimeFactV1 => {
    let reads = 0;
    const fact: Record<string, unknown> = {
      schemaVersion: 1,
      id: 'SAME',
      cursor: { stream: 'runtime-facts', sequence: 7 },
      threadId: 't',
      taskId: 'k',
      turnId: 'u',
      runId: 'r',
      sequence: 7,
      causationId: 'c',
      producer: 'legacy_adapter',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        type: 'completion.decided',
        decision: {
          requestedOutcome: 'x',
          finalOutcome,
          allowed: true,
          reason: 'r',
          evidenceRefs: [],
          policyVersion: 'v1',
        },
      },
    };
    Object.defineProperty(fact, 'authority', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads >= 3 ? function evil() {} : 'authoritative';
      },
    });
    return fact as unknown as RuntimeFactV1;
  };
  const forward = projectTask([make('OUTCOME_A'), make('OUTCOME_B')]);
  const reverse = projectTask([make('OUTCOME_B'), make('OUTCOME_A')]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.degraded, true);
});
