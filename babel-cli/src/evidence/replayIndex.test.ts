/**
 * Packet A3 — replayable redacted action/observation persistence.
 *
 * Integration coverage: scripted 3-turn session dual-written into an episode
 * stream, flushed to disk, reloaded, and replayed via the replay index.
 * Assertions cover round-trip fidelity (modulo capture-time redaction), secret
 * non-persistence, pair ordering, receiptIndex correlation, and the existing
 * per-event payload size cap.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendEpisodeActionObservationPair,
  createEpisodeEventLog,
  deriveEpisodeObservationRef,
  EPISODE_EVENTS_FILENAME,
  EPISODE_PAYLOAD_MAX_BYTES,
  rewriteEpisodeEventLog,
  syncEpisodeFromSessionEvents,
  loadEpisodeEventLogFromDir,
  verifyHashChain,
} from './episodeStream.js';
import {
  buildReplayIndex,
  formatReplayTranscript,
  loadReplayIndexForConversation,
  REPLAY_INDEX_SCHEMA_VERSION,
} from './replayIndex.js';
import {
  createSessionEventLog,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordTurnEnded,
  recordUserSubmitted,
} from '../agent/sessionEvents.js';

// Test fixture secret. The redaction patterns (`sk-…`, `api_key = …`) must
// replace these before any bytes reach disk; the literals must never persist.
// Assembled at runtime so no synthetic key literal is committed to source.
const SECRET_TOKEN = 'sk-' + 'a1b2c3d4e5f6g7h8'.repeat(3);
const SECRET_KEYLINE = 'api_key = "' + '7fQ9zK2vXwRn8mLp'.repeat(2) + '"';

function scriptedThreeTurnSession(sessionId: string) {
  const sessionLog = createSessionEventLog(sessionId);
  const episodeLog = createEpisodeEventLog(sessionId);
  const toolCallIds: string[] = [];

  for (let turn = 1; turn <= 3; turn += 1) {
    const turnId = `turn-${turn}`;
    const toolCallId = `call-${turn}`;
    toolCallIds.push(toolCallId);
    recordUserSubmitted(sessionLog, {
      turn_id: turnId,
      task: turn === 2 ? `deploy with ${SECRET_KEYLINE}` : `task ${turn}`,
    });
    recordToolProposed(sessionLog, {
      turn_id: turnId,
      tool_call_id: toolCallId,
      tool_name: 'shell',
      args_digest: 'digest-' + turn,
    });
    recordToolStarted(sessionLog, {
      turn_id: turnId,
      tool_call_id: toolCallId,
      tool_name: 'shell',
    });
    recordToolTerminal(sessionLog, {
      turn_id: turnId,
      tool_call_id: toolCallId,
      tool_name: 'shell',
      exit_code: 0,
      content:
        turn === 2
          ? `export GITHUB_TOKEN=${SECRET_TOKEN}\nok`
          : `result ${turn}`,
    });
    recordTurnEnded(sessionLog, { turn_id: turnId, status: 'completed' });
  }

  syncEpisodeFromSessionEvents(episodeLog, sessionLog);
  return { sessionLog, episodeLog, toolCallIds };
}

describe('replayIndex — packet A3 replayable evidence', () => {
  test('scripted 3-turn session round-trips: replay matches live stream modulo redaction', () => {
    const sessionId = 'sess-replay-3turn';
    const { sessionLog, episodeLog, toolCallIds } = scriptedThreeTurnSession(sessionId);

    // Live transcript pairing, before any persistence.
    const liveIndex = buildReplayIndex(episodeLog.events, sessionId);
    assert.equal(liveIndex.schemaVersion, REPLAY_INDEX_SCHEMA_VERSION);
    assert.equal(liveIndex.sessionId, sessionId);
    assert.equal(liveIndex.pairs.length, 3);
    assert.ok(liveIndex.pairs.every((p) => p.status === 'paired'));

    // Persist, reload from disk, replay.
    const dir = mkdtempSync(join(tmpdir(), 'babel-a3-replay-'));
    try {
      rewriteEpisodeEventLog(dir, episodeLog);
      const loaded = loadReplayIndexForConversation(dir, sessionId);
      assert.ok(loaded.ok, 'replay index must load from the persisted stream');
      if (!loaded.ok) return;

      assert.equal(loaded.log.events.length, episodeLog.events.length);
      assert.deepEqual(loaded.index.pairs.map((p) => p.toolCallId), toolCallIds);
      assert.equal(loaded.index.pairs.length, 3);
      assert.ok(loaded.index.pairs.every((p) => p.status === 'paired'));

      // Round-trip modulo redaction: every replayed observation equals the live
      // event except for capture-time redaction of secret material.
      const replayedPairs = loaded.index.pairs;
      for (let i = 0; i < 3; i += 1) {
        const live = liveIndex.pairs[i]!;
        const replayed = replayedPairs[i]!;
        assert.equal(replayed.toolName, live.toolName);
        assert.equal(replayed.turnId, live.turnId);
        const liveContent = 'content' in live.observation!.payload
          ? (live.observation!.payload['content'] as string)
          : undefined;
        const replayedContent = 'content' in replayed.observation!.payload
          ? (replayed.observation!.payload['content'] as string)
          : undefined;
        if (liveContent !== undefined) {
          assert.ok(replayedContent !== undefined, 'observation content must replay');
          if (i === 1) {
            assert.match(replayedContent!, /\[REDACTED\]/, 'secret must be redacted');
            assert.ok(
              !replayedContent!.includes('a1b2c3d4e5f6') &&
                !replayedContent!.includes('7fQ9zK2vXwRn'),
              'redacted observation must not retain secret material',
            );
          } else {
            assert.equal(replayedContent, liveContent);
          }
        }
      }

      // Transcript rendering includes each turn and tool in order.
      const transcript = formatReplayTranscript(loaded.index);
      for (const turnId of ['turn-1', 'turn-2', 'turn-3']) {
        assert.ok(transcript.includes(turnId), `transcript must include ${turnId}`);
      }
      assert.equal(transcript.split('| shell |').length - 1, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('injected secret never appears in persisted evidence files', () => {
    const sessionId = 'sess-replay-secret';
    const { episodeLog } = scriptedThreeTurnSession(sessionId);
    const dir = mkdtempSync(join(tmpdir(), 'babel-a3-secret-'));
    try {
      rewriteEpisodeEventLog(dir, episodeLog);
      const persisted = readFileSync(join(dir, EPISODE_EVENTS_FILENAME), 'utf-8');
      assert.ok(!persisted.includes(SECRET_TOKEN), 'token literal must not persist');
      assert.ok(!persisted.includes(SECRET_KEYLINE), 'api key line must not persist');
      assert.ok(!persisted.includes('7fQ9zK2vXwRn'), 'api key value must not persist');
      assert.ok(persisted.includes('[REDACTED]'), 'redaction marker must be present');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit action/observation pair capture correlates with receiptIndex id', () => {
    const log = createEpisodeEventLog('sess-replay-pair');
    const { action, observation, pairId, observationRef } = appendEpisodeActionObservationPair(log, {
      turnId: 'turn-1',
      toolCallId: 'call-x',
      toolName: 'edit',
      receiptId: 'receipt-abc',
      action: { args: { path: 'src/a.ts', content: SECRET_TOKEN } },
      observation: { content: 'wrote 10 bytes', exitCode: 0 },
    });

    assert.equal(action.type, 'action_invoked');
    assert.equal(observation.type, 'observation_recorded');
    assert.equal(observation.seq, action.seq + 1);
    assert.equal(action.payload['receiptId'], 'receipt-abc');
    assert.equal(action.payload['pairId'], pairId);
    assert.equal(observation.payload['pairId'], pairId);
    assert.equal(
      action.payload['observationRef'],
      deriveEpisodeObservationRef({ content: 'wrote 10 bytes', exitCode: 0 }),
    );
    assert.equal(observationRef, action.payload['observationRef']);

    const args = (action.payload['action'] as Record<string, unknown>)['args'] as Record<
      string,
      unknown
    >;
    assert.equal(args['content'], '[REDACTED]');
    assert.ok(!JSON.stringify(log.events).includes(SECRET_TOKEN));

    const index = buildReplayIndex(log.events, 'sess-replay-pair');
    assert.equal(index.pairs.length, 1);
    assert.equal(index.pairs[0]!.receiptId, 'receipt-abc');
    assert.equal(index.pairs[0]!.status, 'paired');
    assert.equal(index.pairs[0]!.pairId, pairId);
  });

  test('size guard: oversized observation content is capped at the existing payload cap', () => {
    const log = createEpisodeEventLog('sess-replay-size');
    const big = 'x'.repeat(EPISODE_PAYLOAD_MAX_BYTES * 3);
    const { observation } = appendEpisodeActionObservationPair(log, {
      turnId: 'turn-1',
      toolCallId: 'call-big',
      toolName: 'shell',
      observation: { content: big },
    });

    assert.equal(observation.payload['truncated'], true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(observation), 'utf8') <= EPISODE_PAYLOAD_MAX_BYTES * 1.5,
      'event envelope must stay near the payload cap',
    );
    assert.ok(!JSON.stringify(observation).includes(big), 'full oversized content must not persist');
  });

  test('replay loading fails closed on absent or mismatched streams', () => {
    const empty = mkdtempSync(join(tmpdir(), 'babel-a3-absent-'));
    try {
      const absent = loadReplayIndexForConversation(empty, 'sess-none');
      assert.ok(!absent.ok);
      if (!absent.ok) assert.equal(absent.reason, 'absent');

      // Session mismatch is refused, never replayed under the wrong identity.
      const { episodeLog } = scriptedThreeTurnSession('sess-other');
      rewriteEpisodeEventLog(empty, episodeLog);
      const mismatched = loadReplayIndexForConversation(empty, 'sess-something-else');
      assert.ok(!mismatched.ok);
      if (!mismatched.ok) {
        assert.equal(mismatched.reason, 'invalid');
        assert.match(mismatched.detail, /session mismatch/);
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('persisted stream stays hash-chain valid after pair capture', () => {
    const sessionId = 'sess-replay-chain';
    const { episodeLog } = scriptedThreeTurnSession(sessionId);
    appendEpisodeActionObservationPair(episodeLog, {
      turnId: 'turn-3',
      toolCallId: 'call-3b',
      toolName: 'shell',
      observation: { content: 'extra' },
    });
    assert.ok(verifyHashChain(episodeLog.events).valid);
    const dir = mkdtempSync(join(tmpdir(), 'babel-a3-chain-'));
    try {
      rewriteEpisodeEventLog(dir, episodeLog);
      const reloaded = loadEpisodeEventLogFromDir(dir);
      assert.ok(reloaded, 'persisted stream must reload');
      if (reloaded) assert.ok(verifyHashChain(reloaded.events).valid);
      assert.ok(existsSync(join(dir, EPISODE_EVENTS_FILENAME)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
