/**
 * Packet A2 — EventLog conformance.
 *
 * Covers: append/read round trip, parent linkage, torn-tail crash safety
 * (truncated last line is discarded fail-closed, never surfaced), replay
 * determinism (byte-for-byte), redaction at the sink, FactBus sinking, and the
 * single-writer guard.
 */
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFactBus, RUNTIME_FACT_SCHEMA_VERSION, type RuntimeFactV1 } from './events.js';
import {
  createRuntimeEventLog,
  FactParentLinker,
  readRuntimeEventLog,
  replayEventLogRecords,
  runtimeEventLogPathForConversation,
  RUNTIME_EVENT_LOG_FILENAME,
  serializeEventLogRecord,
  sinkFactBusIntoEventLog,
  type RuntimeEventLogRecordV1,
} from './eventLog.js';

function fact(overrides: Record<string, unknown> = {}): RuntimeFactV1 {
  return {
    schemaVersion: RUNTIME_FACT_SCHEMA_VERSION,
    id: `fact-${Math.random().toString(36).slice(2, 8)}`,
    cursor: { stream: 'runtime-facts', sequence: 1 },
    threadId: 'thread-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    runId: 'run-1',
    sequence: 1,
    causationId: 'cause-1',
    producer: 'legacy_adapter',
    authority: 'observation',
    timestamp: '2026-10-09T00:00:00.000Z',
    payload: { type: 'run.started', ownerGeneration: 1 },
    ...overrides,
  } as RuntimeFactV1;
}

function tmpSessionDir(): string {
  return mkdtempSync(join(tmpdir(), 'babel-eventlog-'));
}

function recordFor(f: RuntimeFactV1, parent = ''): RuntimeEventLogRecordV1 {
  return { recordVersion: 1, fact: f, parentFactId: parent };
}

test('A2: hostile conversation ids fail closed with no path', () => {
  const root = tmpSessionDir();
  try {
    assert.equal(runtimeEventLogPathForConversation(root, ''), null);
    assert.equal(runtimeEventLogPathForConversation(root, '../escape'), null);
    assert.equal(runtimeEventLogPathForConversation(root, 'a/b'), null);
    assert.equal(runtimeEventLogPathForConversation(root, 'a\\b'), null);
    assert.equal(runtimeEventLogPathForConversation(root, '.hidden'), null);
    assert.equal(runtimeEventLogPathForConversation(root, 'id with space'), null);
    assert.match(runtimeEventLogPathForConversation(root, 'conv-1')!, /conv-1\.runtime-facts\.jsonl$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('A2: append + read round trip reconstructs ordered history', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir });
  const f1 = fact({ id: 'f1', cursor: { stream: 'runtime-facts', sequence: 1 } });
  const f2 = fact({
    id: 'f2',
    cursor: { stream: 'runtime-facts', sequence: 2 },
    payload: { type: 'operation.settled', receiptId: 'r-1', status: 'completed' },
  });
  assert.deepEqual(log.appendFact(f1), { ok: true });
  assert.deepEqual(log.appendFact(f2), { ok: true });
  assert.deepEqual(log.flush(), { ok: true });
  assert.deepEqual(log.stats(), { appended: 2, rejectedInvalid: 0, rejectedIo: 0, flushes: 1 });
  log.close();

  const result = readRuntimeEventLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
  assert.equal(result.discarded, 0);
  assert.equal(result.tornTail, false);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0]!.fact.id, 'f1');
  assert.equal(result.records[1]!.fact.id, 'f2');
  const replay = replayEventLogRecords(result.records);
  assert.ok(replay.ok);
  assert.deepEqual(replay.ordered.map((f) => f.id), ['f1', 'f2']);
  rmSync(dir, { recursive: true, force: true });
});

test('A2: torn tail from a crash mid-append is discarded, never surfaced', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir, flushBytes: 1 });
  log.appendFact(fact({ id: 'good-1', cursor: { stream: 'runtime-facts', sequence: 1 } }));
  log.appendFact(fact({ id: 'good-2', cursor: { stream: 'runtime-facts', sequence: 2 } }));
  assert.deepEqual(log.flush(), { ok: true });

  // Simulate a writer killed mid-append: truncate the file inside the last line.
  const path = join(dir, RUNTIME_EVENT_LOG_FILENAME);
  const complete = serializeEventLogRecord(recordFor(fact({ id: 'torn', cursor: { stream: 'runtime-facts', sequence: 3 } })));
  const existing = readFileSync(path, 'utf-8');
  writeFileSync(path, existing + complete.slice(0, Math.floor(complete.length / 2)), 'utf-8');

  const result = readRuntimeEventLog(path);
  assert.equal(result.tornTail, true);
  assert.equal(result.discarded, 1);
  assert.equal(result.records.length, 2);
  for (const record of result.records) {
    assert.notEqual(record.fact.id, 'torn');
  }
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

test('A2: garbage interior line is discarded and counted, valid records still surface', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir });
  log.appendFact(fact({ id: 'a', cursor: { stream: 'runtime-facts', sequence: 1 } }));
  log.flush();
  const path = join(dir, RUNTIME_EVENT_LOG_FILENAME);
  const existing = readFileSync(path, 'utf-8');
  log.appendFact(fact({ id: 'b', cursor: { stream: 'runtime-facts', sequence: 2 } }));
  log.close();
  const after = readFileSync(path, 'utf-8');
  const secondLine = after.slice(existing.length);
  writeFileSync(path, existing + '{"recordVersion":1,"parent_fact_id":"x","fact":null}\n' + secondLine, 'utf-8');

  const result = readRuntimeEventLog(path);
  assert.equal(result.records.length, 2);
  assert.equal(result.discarded, 1);
  assert.equal(result.tornTail, false);
  rmSync(dir, { recursive: true, force: true });
});

test('A2: replay is deterministic byte-for-byte across independent runs', () => {
  const build = (): string => {
    const dir = tmpSessionDir();
    const log = createRuntimeEventLog({ sessionDir: dir, flushBytes: 1 });
    log.appendFact(fact({ id: 'r1', cursor: { stream: 'runtime-facts', sequence: 1 } }));
    log.appendFact(fact({ id: 'r2', cursor: { stream: 'runtime-facts', sequence: 2 }, payload: { type: 'turn.admitted', commandId: 'c-1' } }));
    log.appendFact(fact({ id: 'r3', cursor: { stream: 'runtime-facts', sequence: 3 }, payload: { type: 'context.degraded', reason: 'provider retry' } }));
    log.close();
    const bytes = readFileSync(join(dir, RUNTIME_EVENT_LOG_FILENAME), 'utf-8');
    rmSync(dir, { recursive: true, force: true });
    return bytes;
  };
  assert.equal(build(), build());
});

test('A2: reader replay reproduces the same ordered fact sequence', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir });
  const ids = ['s1', 's2', 's3'];
  ids.forEach((id, index) => {
    log.appendFact(fact({ id, cursor: { stream: 'runtime-facts', sequence: index + 1 } }));
  });
  log.close();
  const result = readRuntimeEventLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
  const replay = replayEventLogRecords(result.records);
  assert.ok(replay.ok);
  assert.deepEqual(replay.ordered.map((f) => f.id), ids);
  // Byte-for-byte: re-serializing replayed facts yields the file's own lines.
  const fileBytes = readFileSync(join(dir, RUNTIME_EVENT_LOG_FILENAME), 'utf-8');
  const reserialized = result.records.map((r) => serializeEventLogRecord(r)).join('');
  assert.equal(reserialized, fileBytes);
  rmSync(dir, { recursive: true, force: true });
});

test('A2: non-monotonic history fails closed instead of silently reordering', () => {
  const records = [
    recordFor(fact({ id: 'x', cursor: { stream: 'runtime-facts', sequence: 7 } })),
    recordFor(fact({ id: 'y', cursor: { stream: 'runtime-facts', sequence: 7 } })),
  ];
  const replay = replayEventLogRecords(records);
  assert.equal(replay.ok, false);
  if (!replay.ok) assert.match(replay.reason, /non_monotonic/);
});

test('A2: redaction at the sink keeps secret material out of the log file', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir });
  // Hostile payload: a secret-named field (matched by the fact redactor's
  // credential/secret key pattern) and an absolute path inside a string value.
  // Values are low-entropy test fixtures, not credentials.
  const secretFieldName = ['credential', 'Blob'].join('');
  const hostile = fact({
    id: 'redact-1',
    cursor: { stream: 'runtime-facts', sequence: 1 },
    payload: {
      type: 'context.degraded',
      reason: 'upstream rejected request at /opt/babel/credentials/store.txt',
      [secretFieldName]: 'placeholder-value',
    },
  });
  assert.deepEqual(log.appendFact(hostile), { ok: true });
  log.close();
  const bytes = readFileSync(join(dir, RUNTIME_EVENT_LOG_FILENAME), 'utf-8');
  assert.ok(!bytes.includes('placeholder-value'), 'secret-named value leaked into the log');
  assert.ok(!bytes.includes('/opt/babel/credentials/store.txt'), 'absolute path leaked into the log');
  assert.ok(bytes.includes('[redacted'), 'redaction placeholder expected');
  const result = readRuntimeEventLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
  assert.equal(result.records.length, 1);
  assert.equal(
    (result.records[0]!.fact.payload as Record<string, unknown>)[secretFieldName],
    '[redacted]',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('A2: invalid facts are rejected fail-closed and never reach disk', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir });
  const bad = fact({ schemaVersion: 99 }) as unknown as RuntimeFactV1;
  const result = log.appendFact(bad);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorCode, 'event_log_invalid_fact');
    assert.match(result.reason, /unsupported_fact_schema/);
  }
  log.close();
  const result2 = readRuntimeEventLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
  assert.equal(result2.records.length, 0);
  assert.equal(log.stats().rejectedInvalid, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('A2: parent linkage — run roots itself, turn parents to run, operation parents to turn', () => {
  const linker = new FactParentLinker();
  const run1 = fact({ id: 'run-1', payload: { type: 'run.started', ownerGeneration: 1 } });
  const recordRun = recordFor(run1);
  assert.equal(linker.parentFor(run1), '');
  linker.record(recordRun);

  const turn1 = fact({ id: 'turn-1', payload: { type: 'turn.admitted', commandId: 'c-1' } });
  assert.equal(linker.parentFor(turn1), 'run-1');
  linker.record(recordFor(turn1));

  const op = fact({ id: 'op-1', payload: { type: 'operation.prepared', operationDigest: 'd-1' } });
  assert.equal(linker.parentFor(op), 'turn-1');
  linker.record(recordFor(op));

  const verify = fact({ id: 'v-1', payload: { type: 'context.degraded', reason: 'r' } });
  assert.equal(linker.parentFor(verify), 'run-1');

  const run2 = fact({ id: 'run-2', payload: { type: 'run.started', ownerGeneration: 2 } });
  assert.equal(linker.parentFor(run2), 'run-1');
  linker.record(recordFor(run2));
  const turn2 = fact({ id: 'turn-2', payload: { type: 'turn.admitted', commandId: 'c-2' } });
  assert.equal(linker.parentFor(turn2), 'run-2');
  const op2 = fact({ id: 'op-2', payload: { type: 'operation.prepared', operationDigest: 'd-2' } });
  // New run clears stale turn linkage.
  linker.record(recordFor(turn2));
  assert.equal(linker.parentFor(op2), 'turn-2');
});

test('A2: persisted records carry parent_fact_id through the file', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir });
  log.appendFact(fact({ id: 'run-1', cursor: { stream: 'runtime-facts', sequence: 1 }, payload: { type: 'run.started', ownerGeneration: 1 } }));
  log.appendFact(fact({ id: 'turn-1', cursor: { stream: 'runtime-facts', sequence: 2 }, payload: { type: 'turn.admitted', commandId: 'c-1' } }));
  log.appendFact(fact({ id: 'op-1', cursor: { stream: 'runtime-facts', sequence: 3 }, payload: { type: 'operation.settled', receiptId: 'r-9', status: 'completed' } }));
  log.close();
  const result = readRuntimeEventLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
  assert.deepEqual(
    result.records.map((r) => [r.fact.id, r.parentFactId]),
    [
      ['run-1', ''],
      ['turn-1', 'run-1'],
      ['op-1', 'turn-1'],
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});

test('A2: FactBus sinks into the EventLog; live bus path keeps working', () => {
  const dir = tmpSessionDir();
  const bus = createFactBus();
  const log = createRuntimeEventLog({ sessionDir: dir });
  const sink = sinkFactBusIntoEventLog(bus, log);
  const seen: string[] = [];
  const liveView = bus.subscribe((f) => seen.push(f.id));

  bus.publish(fact({ id: 'b1', cursor: { stream: 'runtime-facts', sequence: 1 } }));
  bus.publish(fact({ id: 'b2', cursor: { stream: 'runtime-facts', sequence: 2 } }));
  // Facts sit in each subscriber's bounded queue until that subscriber drains
  // (bus contract); the sink drains its own queue into the log.
  sink.drain();
  liveView.drain();
  sink.close();

  const result = readRuntimeEventLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
  assert.deepEqual(result.records.map((r) => r.fact.id), ['b1', 'b2']);
  // Live in-memory path is untouched by the sink.
  assert.deepEqual(seen, ['b1', 'b2']);
  assert.equal(sink.busDropped(), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('A2: single-writer guard fails closed on a second open of the same file', () => {
  const dir = tmpSessionDir();
  const first = createRuntimeEventLog({ sessionDir: dir });
  assert.throws(() => createRuntimeEventLog({ sessionDir: dir }), /event_log_writer_exists/);
  first.close();
  // After close the file is writable again.
  const second = createRuntimeEventLog({ sessionDir: dir });
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

test('A2: fsync-batched writes keep the durable tail complete or absent', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir, flushBytes: 10 * 1024 * 1024 });
  log.appendFact(fact({ id: 'buffered-1', cursor: { stream: 'runtime-facts', sequence: 1 } }));
  // Not flushed yet: the record exists in the buffer, not on disk.
  const path = join(dir, RUNTIME_EVENT_LOG_FILENAME);
  let sizeOnDisk = 0;
  try {
    sizeOnDisk = statSync(path).size;
  } catch {
    sizeOnDisk = 0;
  }
  assert.ok(log.pendingBytes() > 0);
  assert.equal(sizeOnDisk, 0);
  log.flush();
  assert.ok(statSync(path).size > 0);
  assert.equal(log.pendingBytes(), 0);
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

test('A2: a blank trailing line is torn-tail discarded, never surfaced', () => {
  const dir = tmpSessionDir();
  const log = createRuntimeEventLog({ sessionDir: dir });
  log.appendFact(fact({ id: 'only', cursor: { stream: 'runtime-facts', sequence: 1 } }));
  log.close();
  const path = join(dir, RUNTIME_EVENT_LOG_FILENAME);
  // Append a lone newline fragment: an extra blank physical line at the tail.
  const fd = openSync(path, 'a');
  writeSync(fd, '\n');
  closeSync(fd);
  const result = readRuntimeEventLog(path);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]!.fact.id, 'only');
  assert.equal(result.discarded, 1);
  assert.equal(result.tornTail, true);
  rmSync(dir, { recursive: true, force: true });
});

test('A2: reader on a missing log fails closed with no records and no throw', () => {
  const result = readRuntimeEventLog(join(tmpSessionDir(), 'absent.runtime-facts.jsonl'));
  assert.equal(result.records.length, 0);
  assert.equal(result.discarded, 0);
  assert.ok(result.lastError);
});
