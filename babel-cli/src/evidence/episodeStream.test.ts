/**
 * Episode stream foundation — create/append/flush/load + hash chain + parity flush.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
  EPISODE_EVENT_SCHEMA_VERSION,
  EPISODE_EVENTS_FILENAME,
} from './episodeStream.js';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordToolProposed,
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
    assert.equal(n, 4);
    assert.equal(episode.events.length, 4);
    assert.equal(episode.syncedSessionSeq, session.events[session.events.length - 1]!.seq);

    assert.equal(episode.events[0]!.kind, 'session');
    assert.equal(episode.events[0]!.type, 'user_submitted');
    assert.equal(episode.events[1]!.kind, 'tool');
    assert.equal(episode.events[1]!.type, 'tool_proposed');
    assert.equal(episode.events[2]!.type, 'tool_completed');
    assert.equal(episode.events[3]!.kind, 'turn');
    assert.equal(episode.events[3]!.type, 'turn_ended');
    assert.equal(episode.events[0]!.payload['sourceSessionSeq'], 0);
    assert.equal(episode.events[3]!.payload['outcome'], 'AGENT_FAILURE');

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
