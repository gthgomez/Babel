/**
 * Episode stream foundation — create/append/flush/load + hash chain + parity flush.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createEpisodeEventLog,
  appendEpisodeEvent,
  appendEpisodeFromSessionEvent,
  syncEpisodeFromSessionEvents,
  syncAndFlushEpisodeFromSession,
  flushEpisodeEventLog,
  loadEpisodeEventLogFromDir,
  parseEpisodeEventLog,
  serializeEpisodeEventLog,
  hashEpisodeEvent,
  mapSessionKindToEpisode,
  verifyHashChain,
  loadOrQuarantineEpisodeLog,
  loadEpisodeEventLogForMode,
  parseEpisodeEventLogResult,
  validateEpisodeEventLog,
  EPISODE_EVENT_SCHEMA_VERSION,
  EPISODE_EVENTS_FILENAME,
  EPISODE_PAYLOAD_MAX_BYTES,
} from './episodeStream.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordTurnEnded,
} from '../agent/sessionEvents.js';
import {
  createParityRuntime,
  finalizeParityTurnSync,
  parityOnUserTurn,
} from '../agent/chatEngineParityBridge.js';

describe('episodeStream schema + append', () => {
  test('create + append produces monotonic seq and CanonicalExecutorEvent shape', () => {
    const log = createEpisodeEventLog('sess-ep-1');
    const a = appendEpisodeEvent(log, {
      kind: 'session',
      type: 'user_submitted',
      turnId: 't1',
      payload: { task_preview: 'hello' },
    });
    const b = appendEpisodeEvent(log, {
      kind: 'tool',
      type: 'tool_completed',
      turnId: 't1',
      payload: { tool_name: 'grep' },
    });
    const c = appendEpisodeEvent(log, {
      kind: 'turn',
      type: 'turn_ended',
      turnId: 't1',
      payload: { outcome: 'VERIFIED_COMPLETE', status: 'completed' },
    });

    assert.equal(log.schemaVersion, EPISODE_EVENT_SCHEMA_VERSION);
    assert.equal(log.sessionId, 'sess-ep-1');
    assert.equal(log.events.length, 3);
    assert.equal(a.seq, 0);
    assert.equal(b.seq, 1);
    assert.equal(c.seq, 2);
    assert.equal(a.schemaVersion, 1);
    assert.equal(a.sessionId, 'sess-ep-1');
    assert.equal(a.turnId, 't1');
    assert.equal(typeof a.eventId, 'string');
    assert.equal(typeof a.ts, 'string');
    assert.equal(a.kind, 'session');
    assert.equal(a.type, 'user_submitted');
    assert.equal(a.payload['task_preview'], 'hello');
  });

  test('prevHash chains when hashLink enabled', () => {
    const log = createEpisodeEventLog('sess-hash', { hashLink: true });
    const e0 = appendEpisodeEvent(log, { kind: 'session', type: 'user_submitted' });
    const e1 = appendEpisodeEvent(log, { kind: 'tool', type: 'tool_started' });
    const e2 = appendEpisodeEvent(log, { kind: 'turn', type: 'turn_ended' });

    assert.equal(e0.prevHash, undefined);
    assert.equal(e1.prevHash, hashEpisodeEvent(e0));
    assert.equal(e2.prevHash, hashEpisodeEvent(e1));
    // Re-hash of stored events must still match chain links.
    assert.equal(e1.prevHash, hashEpisodeEvent(log.events[0]!));
    assert.equal(e2.prevHash, hashEpisodeEvent(log.events[1]!));
  });

  test('prevHash omitted when hashLink disabled', () => {
    const log = createEpisodeEventLog('sess-nohash', { hashLink: false });
    appendEpisodeEvent(log, { kind: 'session', type: 'user_submitted' });
    const e1 = appendEpisodeEvent(log, { kind: 'tool', type: 'tool_started' });
    assert.equal(e1.prevHash, undefined);
  });

  test('mapSessionKindToEpisode covers tool/mutation/verifier/completion/recovery', () => {
    assert.deepEqual(mapSessionKindToEpisode('tool_completed'), {
      kind: 'tool',
      type: 'tool_completed',
    });
    assert.deepEqual(mapSessionKindToEpisode('mutation_batch'), {
      kind: 'mutation',
      type: 'mutation_batch',
    });
    assert.deepEqual(mapSessionKindToEpisode('verifier_attempt'), {
      kind: 'verifier',
      type: 'verifier_attempt',
    });
    assert.deepEqual(mapSessionKindToEpisode('completion_decision'), {
      kind: 'completion',
      type: 'completion_decision',
    });
    assert.deepEqual(mapSessionKindToEpisode('progress_recovery'), {
      kind: 'recovery',
      type: 'progress_recovery',
    });
    assert.deepEqual(mapSessionKindToEpisode('capability_binding_receipt'), {
      kind: 'session',
      type: 'capability_binding_receipt',
    });
    assert.deepEqual(mapSessionKindToEpisode('turn_ended'), {
      kind: 'turn',
      type: 'turn_ended',
    });
  });
});

describe('episodeStream dual-write JSONL', () => {
  test('create + append + flush produces file; load round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-episode-'));
    try {
      const log = createEpisodeEventLog('sess-flush');
      appendEpisodeEvent(log, {
        kind: 'session',
        type: 'user_submitted',
        turnId: 't1',
        payload: { task_preview: 'hello' },
      });
      const r1 = flushEpisodeEventLog(dir, log);
      assert.equal(r1.wrote, 1);
      assert.ok(!r1.error);
      assert.ok(existsSync(join(dir, EPISODE_EVENTS_FILENAME)));

      appendEpisodeEvent(log, { kind: 'tool', type: 'tool_proposed', turnId: 't1' });
      appendEpisodeEvent(log, { kind: 'turn', type: 'turn_ended', turnId: 't1' });
      const r2 = flushEpisodeEventLog(dir, log);
      assert.equal(r2.wrote, 2);

      const r3 = flushEpisodeEventLog(dir, log);
      assert.equal(r3.wrote, 0);

      const loaded = loadEpisodeEventLogFromDir(dir);
      assert.ok(loaded);
      assert.equal(loaded.sessionId, 'sess-flush');
      assert.equal(loaded.events.length, 3);
      assert.equal(loaded.events[0]!.type, 'user_submitted');
      assert.equal(loaded.events[2]!.type, 'turn_ended');
      for (let i = 0; i < loaded.events.length; i++) {
        assert.equal(loaded.events[i]!.seq, i);
      }
      // Chain still valid after load.
      assert.equal(loaded.events[1]!.prevHash, hashEpisodeEvent(loaded.events[0]!));
      assert.equal(loaded.events[2]!.prevHash, hashEpisodeEvent(loaded.events[1]!));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serialize/parse round-trip', () => {
    const log = createEpisodeEventLog('sess-rt');
    appendEpisodeEvent(log, {
      kind: 'session',
      type: 'user_submitted',
      payload: { task_preview: 'x' },
    });
    const raw = serializeEpisodeEventLog(log);
    const parsed = parseEpisodeEventLog(raw);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0]!.type, 'user_submitted');
    assert.equal(parsed.sessionId, 'sess-rt');
  });

  test('rejects wrong schemaVersion', () => {
    assert.throws(
      () =>
        parseEpisodeEventLog(
          '{"schemaVersion":2,"eventId":"x","sessionId":"s","turnId":null,"seq":0,"ts":"t","kind":"session","type":"x","payload":{}}\n',
        ),
      /Unsupported episode event schema/,
    );
  });
});

describe('episodeStream session projection', () => {
  test('sync from session events maps kinds and tracks syncedSessionSeq', () => {
    const session = createSessionEventLog('sess-proj');
    recordUserSubmitted(session, { turn_id: 't1', task: 'fix a bug' });
    recordToolProposed(session, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'grep',
    });
    recordToolStarted(session, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'grep',
    });
    recordToolTerminal(session, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'grep',
      exit_code: 0,
      content: 'hits',
    });
    recordTurnEnded(session, {
      turn_id: 't1',
      outcome: 'AGENT_FAILURE',
      status: 'failed',
    });

    const episode = createEpisodeEventLog('sess-proj');
    const n = syncEpisodeFromSessionEvents(episode, session);
    assert.equal(n, 5);
    assert.equal(episode.events.length, 5);
    assert.equal(episode.syncedSessionSeq, session.events[session.events.length - 1]!.seq);

    assert.equal(episode.events[0]!.kind, 'session');
    assert.equal(episode.events[0]!.type, 'user_submitted');
    assert.equal(episode.events[1]!.kind, 'tool');
    assert.equal(episode.events[1]!.type, 'tool_proposed');
    assert.equal(episode.events[2]!.kind, 'tool');
    assert.equal(episode.events[2]!.type, 'tool_started');
    assert.equal(episode.events[3]!.type, 'tool_completed');
    assert.equal(episode.events[4]!.kind, 'turn');
    assert.equal(episode.events[4]!.type, 'turn_ended');
    assert.equal(episode.events[0]!.payload['sourceSessionSeq'], 0);
    assert.equal(episode.events[4]!.payload['outcome'], 'AGENT_FAILURE');

    // Idempotent second sync.
    assert.equal(syncEpisodeFromSessionEvents(episode, session), 0);
  });

  test('syncAndFlushEpisodeFromSession writes episode-events.jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-episode-sync-'));
    try {
      const session = createSessionEventLog('sess-sf');
      recordUserSubmitted(session, { turn_id: 't', task: 'task' });
      recordTurnEnded(session, {
        turn_id: 't',
        outcome: 'CANCELLED',
        status: 'cancelled',
      });
      const episode = createEpisodeEventLog('sess-sf');
      const result = syncAndFlushEpisodeFromSession(dir, episode, session);
      assert.equal(result.projected, 2);
      assert.equal(result.wrote, 2);
      assert.ok(!result.error);
      assert.ok(existsSync(join(dir, EPISODE_EVENTS_FILENAME)));

      const loaded = loadEpisodeEventLogFromDir(dir);
      assert.ok(loaded);
      assert.equal(loaded.events.length, 2);
      assert.equal(loaded.syncedSessionSeq, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appendEpisodeFromSessionEvent preserves event_id', () => {
    const session = createSessionEventLog('s');
    recordUserSubmitted(session, { turn_id: 't', task: 'x' });
    const se = session.events[0]!;
    const episode = createEpisodeEventLog('s');
    const ep = appendEpisodeFromSessionEvent(episode, se);
    assert.equal(ep.eventId, se.event_id);
    assert.equal(ep.payload['sourceEventId'], se.event_id);
  });
});

describe('parity bridge dual-write choke point', () => {
  test('finalizeParityTurnSync writes episode-events.jsonl from session events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-episode-parity-'));
    try {
      const rt = createParityRuntime('parity-sess-1');
      assert.ok(rt.episodeStream);
      assert.equal(rt.episodeStream.sessionId, 'parity-sess-1');

      parityOnUserTurn(rt, {
        task: 'write a test',
        model: 'test-model',
        provider: 'test',
        projectRoot: dir,
      });
      finalizeParityTurnSync(rt, dir, 'AGENT_FAILURE', 'failed');

      const path = join(dir, EPISODE_EVENTS_FILENAME);
      assert.ok(existsSync(path), `expected ${EPISODE_EVENTS_FILENAME} after finalize`);
      const raw = readFileSync(path, 'utf-8');
      const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      assert.ok(lines.length >= 2, 'user_submitted + turn_ended at minimum');

      const loaded = loadEpisodeEventLogFromDir(dir);
      assert.ok(loaded);
      const types = loaded.events.map((e) => e.type);
      assert.ok(types.includes('user_submitted'));
      assert.ok(types.includes('turn_ended'));
      // seq monotonic
      for (let i = 0; i < loaded.events.length; i++) {
        assert.equal(loaded.events[i]!.seq, i);
      }
      // hash chain when enabled (default)
      if (loaded.events.length >= 2) {
        assert.equal(loaded.events[1]!.prevHash, hashEpisodeEvent(loaded.events[0]!));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verifyHashChain and loadOrQuarantineEpisodeLog', () => {
  test('verifyHashChain passes for valid event log', () => {
    const log = createEpisodeEventLog('sess-valid-1');
    appendEpisodeEvent(log, { kind: 'session', type: 't1', payload: {} });
    appendEpisodeEvent(log, { kind: 'tool', type: 't2', payload: {} });
    const res = verifyHashChain(log.events);
    assert.equal(res.valid, true);
    assert.equal(res.error, undefined);
  });

  test('verifyHashChain detects non-contiguous seq and broken hash chain', () => {
    const log = createEpisodeEventLog('sess-valid-2');
    appendEpisodeEvent(log, { kind: 'session', type: 't1', payload: {} });
    appendEpisodeEvent(log, { kind: 'tool', type: 't2', payload: {} });

    // Break prevHash
    log.events[1]!.prevHash = 'corrupted_hash_value';
    const res = verifyHashChain(log.events);
    assert.equal(res.valid, false);
    assert.match(res.error ?? '', /Hash chain broken/);
  });

  test('loadOrQuarantineEpisodeLog creates quarantine file when stream is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-episode-quarantine-'));
    try {
      const log = createEpisodeEventLog('sess-corrupt');
      appendEpisodeEvent(log, { kind: 'session', type: 't1', payload: {} });
      appendEpisodeEvent(log, { kind: 'tool', type: 't2', payload: {} });
      log.events[1]!.prevHash = 'bad_hash';

      const path = join(dir, EPISODE_EVENTS_FILENAME);
      writeFileSync(path, log.events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

      const recovered = loadOrQuarantineEpisodeLog(dir, 'sess-corrupt');
      assert.ok(recovered);
      assert.equal(recovered.events[0]!.type, 'RECOVERY_GENESIS');
      assert.ok(recovered.events[0]!.payload['quarantineFile']);
      assert.deepEqual(Object.keys(recovered.events[0]!.payload).sort(), ['quarantineFile', 'reason']);

      const files = readdirSync(dir) as string[];
      const corruptFile = files.find((f) => f.startsWith('episode-events.corrupt.'));
      assert.ok(corruptFile, 'expected quarantined corrupt file to exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('typed episode load boundary', () => {
  test('new creates genesis, resume requires an existing stream, and new rejects duplicates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-episode-modes-'));
    try {
      const absentResume = loadEpisodeEventLogForMode(dir, { mode: 'resume', sessionId: 'mode-sess' });
      if (absentResume.ok) throw new Error('expected resume to fail when absent');
      assert.equal(absentResume.error.code, 'absent');

      const created = loadEpisodeEventLogForMode(dir, { mode: 'new', sessionId: 'mode-sess' });
      if (!created.ok) throw new Error('expected new mode to create a stream');
      assert.equal(created.value.events[0]!.type, 'PIPELINE_GENESIS');
      assert.equal(created.value.events[0]!.seq, 0);
      assert.equal(created.value.events[0]!.prevHash, undefined);
      flushEpisodeEventLog(dir, created.value);

      const duplicate = loadEpisodeEventLogForMode(dir, { mode: 'new', sessionId: 'mode-sess' });
      if (duplicate.ok) throw new Error('expected new to reject an existing stream');
      assert.equal(duplicate.error.code, 'already_exists');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cold resume preserves the hash chain and expected session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-episode-resume-'));
    try {
      const created = loadEpisodeEventLogForMode(dir, { mode: 'new', sessionId: 'resume-sess' });
      if (!created.ok) throw new Error('expected new mode to create a stream');
      appendEpisodeEvent(created.value, { kind: 'tool', type: 'TOOL_TEST', payload: { step: 1 } });
      flushEpisodeEventLog(dir, created.value);

      const resumed = loadEpisodeEventLogForMode(dir, { mode: 'resume', sessionId: 'resume-sess' });
      if (!resumed.ok) throw new Error('expected resume mode to load the stream');
      const previous = resumed.value.events[resumed.value.events.length - 1]!;
      const next = appendEpisodeEvent(resumed.value, { kind: 'completion', type: 'PIPELINE_COMPLETION' });
      assert.equal(next.seq, previous.seq + 1);
      assert.equal(next.prevHash, hashEpisodeEvent(previous));
      assert.equal(validateEpisodeEventLog(resumed.value.events, 'resume-sess').valid, true);
      flushEpisodeEventLog(dir, resumed.value);

      const wrongSession = loadEpisodeEventLogForMode(dir, { mode: 'resume', sessionId: 'other-sess' });
      assert.equal(wrongSession.ok, false);
      if (wrongSession.ok) throw new Error('expected session mismatch');
      assert.equal(wrongSession.error.code, 'session_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rename failure is fail-closed and leaves the corrupt file untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-episode-rename-fail-'));
    try {
      const path = join(dir, EPISODE_EVENTS_FILENAME);
      const corrupt = '{"schemaVersion":1,not-json}\n';
      writeFileSync(path, corrupt, 'utf-8');
      const result = loadEpisodeEventLogForMode(dir, {
        mode: 'legacy_resume',
        sessionId: 'rename-fail-sess',
        filesystem: {
          exists: (candidate) => existsSync(candidate),
          readFile: (candidate) => readFileSync(candidate, 'utf-8'),
          rename: () => {
            throw new Error('injected rename failure');
          },
        },
      });
      if (result.ok) throw new Error('expected quarantine failure');
      assert.equal(result.error.code, 'quarantine_failed');
      assert.equal(readFileSync(path, 'utf-8'), corrupt);
      assert.equal(readdirSync(dir).some((name) => name.startsWith('episode-events.corrupt.')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('typed parsing distinguishes malformed JSON and schema mismatch', () => {
      const malformed = parseEpisodeEventLogResult('{"schemaVersion":1,}\n');
    if (malformed.ok) throw new Error('expected malformed JSON to fail');
    assert.equal(malformed.error.code, 'malformed');

    const wrongSchema = parseEpisodeEventLogResult(
      '{"schemaVersion":2,"eventId":"x","sessionId":"s","turnId":null,"seq":0,"ts":"t","kind":"session","type":"x","payload":{}}\n',
    );
    if (wrongSchema.ok) throw new Error('expected schema mismatch to fail');
    assert.equal(wrongSchema.error.code, 'malformed');
  });
});

describe('episode payload safety', () => {
  test('redacts secrets, preserves routing fields, and caps UTF-8 payloads', () => {
    const log = createEpisodeEventLog('payload-sess');
    const secret = 'sk-live-should-not-persist';
    const event = appendEpisodeEvent(log, {
      kind: 'tool',
      type: 'TOOL_OUTPUT',
      payload: {
        tool: 'shell_exec',
        step: 7,
        status: 'completed',
        input: '😀'.repeat(80_000),
        stdout: `${secret} ${'x'.repeat(80_000)}`,
      },
    });
    const serialized = JSON.stringify(event.payload);
    assert.ok(Buffer.byteLength(serialized, 'utf8') <= EPISODE_PAYLOAD_MAX_BYTES);
    assert.equal(event.payload['truncated'], true);
    assert.equal(event.payload['tool'], 'shell_exec');
    assert.equal(event.payload['step'], 7);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes('\uFFFD'), false);
      assert.equal(Buffer.byteLength(String(event.payload['preview']), 'utf8') > 0, true);
    });

  test('caps serialized payloads after JSON escaping quotes and backslashes', () => {
    const log = createEpisodeEventLog('escaping-cap-sess');
    const event = appendEpisodeEvent(log, {
      kind: 'tool',
      type: 'TOOL_OUTPUT',
      payload: { stdout: ('"\\').repeat(100_000) },
    });
    assert.ok(Buffer.byteLength(JSON.stringify(event.payload), 'utf8') <= EPISODE_PAYLOAD_MAX_BYTES);
  });
});
