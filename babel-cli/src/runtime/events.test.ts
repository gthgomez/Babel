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
  type EventCursor,
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

test('P04: redaction removes absolute Windows and POSIX paths from string values', () => {
  const windowsPath = 'C:\\Users\\alice\\AppData\\Local\\babel\\run\\thread_events.json';
  const posixPath = ['', 'home', 'alice', '.local', 'share', 'babel', 'run', 'thread_events.json'].join('/');
  const redacted = redactRuntimeFact(
    fact({ payload: { type: 'context.degraded', reason: `failed at ${windowsPath}; retry ${posixPath}` } }),
  );
  const serialized = JSON.stringify(redacted.payload);
  assert.ok(!serialized.includes(windowsPath));
  assert.ok(!serialized.includes(posixPath));
  assert.equal((redacted.payload as { reason: string }).reason.match(/\[redacted:path\]/g)?.length, 2);
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

test('P04: redaction output is bounded for a wide sparse array', () => {
  const sparse: unknown[] = [];
  sparse.length = 5_000_000;
  const redacted = redactRuntimeFact(
    fact({ payload: { type: 'permission.decided', decision: 'allow', arr: sparse } }),
  );
  const arr = (redacted.payload as unknown as Record<string, unknown>)['arr'];
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length <= 100_002, `bounded output, got ${arr.length}`);
});

test('P04: validateRuntimeFact and cursor helpers are total for hostile input', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.doesNotThrow(() => validateRuntimeFact(proxy));
  assert.equal(validateRuntimeFact(proxy).ok, false);
  assert.doesNotThrow(() =>
    validateRuntimeFact({
      get authority(): never {
        throw new Error('boom');
      },
    }),
  );
  assert.doesNotThrow(() => compareFactCursors(null as never, null as never));
  assert.doesNotThrow(() => isFactAfter(null as never, null as never));
});

test('P04: fact bus tolerates null options and a faulty subscriber', () => {
  assert.doesNotThrow(() => createFactBus(null));
  const bus = createFactBus({ maxQueue: 10 });
  const seen: string[] = [];
  const sub = bus.subscribe((f) => {
    if (f.id === 'f1') throw new Error('handler boom');
    seen.push(f.id);
  });
  for (let i = 0; i < 3; i += 1) bus.publish(fact({ id: `f${i}`, sequence: i }));
  assert.doesNotThrow(() => sub.drain());
  assert.deepEqual(seen, ['f0', 'f2']);
});

test('P04: cursor helpers are total and single-read for hostile input', () => {
  const hostile = {
    get stream(): never {
      throw new Error('hostile');
    },
  } as unknown as EventCursor;
  assert.doesNotThrow(() => compareFactCursors(hostile, hostile));
  assert.doesNotThrow(() => isFactAfter(hostile, hostile));
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.doesNotThrow(() => compareFactCursors(proxy as never, proxy as never));
  assert.doesNotThrow(() => isFactAfter(proxy as never, proxy as never));

  let reads = 0;
  const stateful = {
    stream: 'runtime-facts',
    get sequence(): number {
      reads += 1;
      return 1;
    },
  } as unknown as EventCursor;
  assert.equal(compareFactCursors(stateful, stateful), 0);
  assert.ok(reads <= 2, `each cursor field read once, got ${reads}`);
});

test('P04: ephemeral envelope kind cannot be overridden', () => {
  const event = makeEphemeralEvent({
    threadId: 't',
    turnId: 'u',
    sequence: 0,
    payload: { x: 1 },
    kind: 'durable',
  } as never);
  assert.equal(event.kind, 'ephemeral');
});

test('P04: createFactBus tolerates hostile options', () => {
  const hostile = {
    get maxQueue(): never {
      throw new Error('boom');
    },
  };
  assert.doesNotThrow(() => createFactBus(hostile as never));
});

test('P04: fact bus clamps a huge maxQueue', () => {
  const bus = createFactBus({ maxQueue: 1_000_000 });
  const sub = bus.subscribe(() => undefined);
  for (let i = 0; i < 10_050; i += 1) {
    bus.publish(fact({ id: `f${i}`, sequence: i }));
  }
  assert.equal(sub.queued(), 10_000);
});

test('P04: validator rejects non-string payload fields', () => {
  const result = validateRuntimeFact(
    fact({ payload: { type: 'operation.prepared', operationDigest: 123 } }),
  );
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /invalid_operation_prepared/);
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
