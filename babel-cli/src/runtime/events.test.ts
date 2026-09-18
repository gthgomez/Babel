/**
 * P04 — runtime fact contract conformance.
 *
 * Covers classification, ingress validation (unknown authority fails closed),
 * redaction, cursor semantics distinct from wire/history cursors, the ephemeral
 * envelope, and the bounded subscriber queue.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTHORITATIVE_FACT_TYPES,
  classifyFactType,
  compareFactCursors,
  createFactBus,
  isFactAfter,
  makeEphemeralEvent,
  redactRuntimeFact,
  RUNTIME_FACT_SCHEMA_VERSION,
  validateRuntimeFact,
  type RuntimeFactV1,
} from './events.js';

function fact(overrides: Record<string, unknown> = {}): RuntimeFactV1 {
  return {
    schemaVersion: RUNTIME_FACT_SCHEMA_VERSION,
    id: 'fact-1',
    cursor: { stream: 'runtime-facts', sequence: 1 },
    threadId: 'thread-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    runId: 'run-1',
    sequence: 1,
    causationId: 'event-1',
    producer: 'legacy_adapter',
    authority: 'observation',
    timestamp: '2026-09-18T00:00:00.000Z',
    payload: { type: 'run.started', ownerGeneration: 1 },
    ...overrides,
  } as unknown as RuntimeFactV1;
}

test('P04: fact type classification distinguishes authority from observation', () => {
  assert.equal(classifyFactType('completion.decided'), 'authoritative');
  assert.equal(classifyFactType('verification.recorded'), 'authoritative');
  assert.equal(classifyFactType('run.settled'), 'observation');
  assert.equal(classifyFactType('context.degraded'), 'observation');
  assert.equal(classifyFactType('made.up.fact'), 'unknown');
  assert.equal(AUTHORITATIVE_FACT_TYPES.has('run.settled'), false);
});

test('P04: valid fact passes ingress validation', () => {
  const result = validateRuntimeFact(fact());
  assert.equal(result.ok, true);
});

test('P04: unknown authority-bearing schema fails closed', () => {
  const result = validateRuntimeFact(
    fact({ schemaVersion: 99, authority: 'authoritative' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.authority, 'authoritative');
  assert.match(result.ok === false ? result.reason : '', /unsupported_fact_schema/);
});

test('P04: unknown fact type is rejected with its claimed authority', () => {
  const result = validateRuntimeFact(
    fact({ payload: { type: 'future.authoritative.thing' }, authority: 'authoritative' }),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /unknown_fact_type/);
});

test('P04: malformed facts are rejected', () => {
  assert.equal(validateRuntimeFact(null).ok, false);
  assert.equal(validateRuntimeFact(fact({ id: 42 })).ok, false);
  assert.equal(validateRuntimeFact(fact({ sequence: 1.5 })).ok, false);
  assert.equal(validateRuntimeFact(fact({ payload: {} })).ok, false);
});

test('P04: a novel authority token is reported authority-bearing', () => {
  const result = validateRuntimeFact(fact({ authority: 'superuser' }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.authority, 'authoritative');
});

test('P04: redaction removes credential keys and caps long strings', () => {
  const long = 'x'.repeat(800);
  const redacted = redactRuntimeFact(
    fact({
      payload: {
        type: 'permission.decided',
        decision: 'allow',
        reason: long,
        access_token: 'super-secret',
        nested: { apiKey: 'also-secret' },
      },
    }),
  );
  const payload = redacted.payload as unknown as Record<string, unknown>;
  assert.equal(payload['access_token'], '[redacted]');
  assert.equal((payload['nested'] as Record<string, unknown>)['apiKey'], '[redacted]');
  assert.ok(String(payload['reason']).length < long.length);
  assert.match(String(payload['reason']), /truncated/);
});

test('P04: redaction does not leak nested secrets past the depth budget', () => {
  let nested: Record<string, unknown> = { access_token: 'deep-secret' };
  for (let i = 0; i < 8; i += 1) nested = { wrapper: nested };
  const redacted = redactRuntimeFact(
    fact({ payload: { type: 'permission.decided', decision: 'allow', nested } }),
  );
  assert.ok(
    !JSON.stringify(redacted.payload).includes('deep-secret'),
    'a nested credential must not survive redaction',
  );
});

test('P04: redactRuntimeFact is total and bounded for hostile/DAG input', () => {
  let node: unknown = { token: 'secret' };
  for (let i = 0; i < 12; i += 1) {
    const next: Record<string, unknown> = {};
    for (let k = 0; k < 5; k += 1) next[`k${k}`] = node;
    node = next;
  }
  const started = Date.now();
  const redacted = redactRuntimeFact(
    fact({ payload: { type: 'permission.decided', decision: 'allow', nested: node } }),
  );
  assert.ok(Date.now() - started < 5000, 'shared-reference redaction must be bounded');
  assert.ok(!JSON.stringify(redacted).includes('secret'));

  const hostile = fact({
    payload: {
      type: 'permission.decided',
      decision: 'allow',
      get boom(): never {
        throw new Error('boom');
      },
    },
  });
  assert.doesNotThrow(() => redactRuntimeFact(hostile));

  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.doesNotThrow(() => redactRuntimeFact(fact({ payload: proxy })));
});

test('P04: fact cursor is its own address space', () => {
  const a = { stream: 'runtime-facts' as const, sequence: 1 };
  const b = { stream: 'runtime-facts' as const, sequence: 2 };
  assert.ok(compareFactCursors(a, b) < 0);
  assert.equal(isFactAfter(b, a), true);
  assert.equal(isFactAfter(a, b), false);
});

test('P04: ephemeral envelope is explicitly non-durable', () => {
  const ephemeral = makeEphemeralEvent({
    threadId: 't',
    turnId: 'turn',
    sequence: 0,
    payload: { delta: 'hello' },
  });
  assert.equal(ephemeral.kind, 'ephemeral');
});

test('P04: bounded subscriber queue drops the oldest and reports it', () => {
  const bus = createFactBus({ maxQueue: 2 });
  const seen: string[] = [];
  const sub = bus.subscribe((f) => seen.push(f.id));
  for (let i = 0; i < 5; i += 1) {
    bus.publish(fact({ id: `f${i}`, sequence: i }));
  }
  assert.equal(sub.queued(), 2);
  assert.equal(sub.dropped(), 3);
  sub.drain();
  assert.deepEqual(seen, ['f3', 'f4']);
  sub.close();
  assert.equal(bus.subscriberCount(), 0);
});

test('P04: fact bus stays bounded for a non-finite maxQueue', () => {
  const bus = createFactBus({ maxQueue: Number.NaN });
  const sub = bus.subscribe(() => undefined);
  for (let i = 0; i < 1000; i += 1) {
    bus.publish(fact({ id: `f${i}`, sequence: i }));
  }
  assert.equal(sub.queued(), 256);
});
