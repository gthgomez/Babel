/**
 * W2 PR-E: SessionEventV1 schema + dual-write JSONL.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createSessionEventLog,
  recordUserSubmitted,
  recordModelStarted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordVerifierAttempt,
  recordTurnEnded,
  flushSessionEventLog,
  rewriteSessionEventLog,
  loadSessionEventLogFromDir,
  parseSessionEventLog,
  serializeSessionEventLog,
  completedToolIdempotencyKeys,
  interruptedToolIdempotencyKeys,
  markInterruptedToolsOnResume,
  planToolSettle,
  shouldSkipToolReExec,
  shortDigest,
  SESSION_EVENT_SCHEMA_VERSION,
  SESSION_EVENTS_FILENAME,
} from './sessionEvents.js';

describe('SessionEventV1 schema', () => {
  test('append user → tools → turn_ended with monotonic seq', () => {
    const log = createSessionEventLog('sess-1');
    const turn = 'turn-a';
    recordUserSubmitted(log, {
      turn_id: turn,
      task: 'fix the bug in wikidata.py',
      model: 'claude',
      provider: 'anthropic',
      projectRoot: '/tmp/ws',
      taskClass: 'general_swe',
    });
    recordModelStarted(log, { turn_id: turn, model: 'claude', provider: 'anthropic' });
    recordToolProposed(log, {
      turn_id: turn,
      tool_call_id: 'tc1',
      tool_name: 'str_replace',
    });
    recordToolStarted(log, {
      turn_id: turn,
      tool_call_id: 'tc1',
      tool_name: 'str_replace',
    });
    recordToolTerminal(log, {
      turn_id: turn,
      tool_call_id: 'tc1',
      tool_name: 'str_replace',
      exit_code: 0,
      content: 'ok',
    });
    recordVerifierAttempt(log, {
      turn_id: turn,
      command_preview: 'python -m pytest openlibrary/tests/core/test_wikidata.py -q',
      authoritative: true,
      exit_code: 4,
    });
    recordTurnEnded(log, {
      turn_id: turn,
      outcome: 'AGENT_FAILURE',
      status: 'failed',
    });

    assert.equal(log.events.length, 7);
    assert.equal(log.events[0]!.kind, 'user_submitted');
    assert.equal(log.events[0]!.schema_version, SESSION_EVENT_SCHEMA_VERSION);
    assert.equal(log.events[0]!.session_id, 'sess-1');
    for (let i = 0; i < log.events.length; i++) {
      assert.equal(log.events[i]!.seq, i);
    }
    const completed = log.events.find((e) => e.kind === 'tool_completed');
    assert.ok(completed && completed.kind === 'tool_completed');
    assert.equal(completed.idempotency_key, 'tc1');
    assert.equal(completed.output_digest, shortDigest('ok'));
  });

  test('tool_failed when exit_code non-zero', () => {
    const log = createSessionEventLog();
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'x',
      tool_name: 'run_command',
      exit_code: 1,
      content: 'ModuleNotFoundError: web',
    });
    assert.equal(log.events[0]!.kind, 'tool_failed');
  });

  test('tool_cancelled branch', () => {
    const log = createSessionEventLog();
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'x',
      tool_name: 'run_command',
      cancelled: true,
      reason: 'kill mid-tool',
    });
    assert.equal(log.events[0]!.kind, 'tool_cancelled');
  });
});

describe('SessionEventV1 dual-write JSONL', () => {
  test('flush appends only new events; load round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-session-events-'));
    try {
      const log = createSessionEventLog('sess-flush');
      recordUserSubmitted(log, { turn_id: 't1', task: 'hello' });
      const r1 = flushSessionEventLog(dir, log);
      assert.equal(r1.wrote, 1);
      assert.ok(!r1.error);
      assert.ok(existsSync(join(dir, SESSION_EVENTS_FILENAME)));

      recordToolProposed(log, {
        turn_id: 't1',
        tool_call_id: 'c1',
        tool_name: 'grep',
      });
      recordToolTerminal(log, {
        turn_id: 't1',
        tool_call_id: 'c1',
        tool_name: 'grep',
        exit_code: 0,
        content: 'hits',
      });
      const r2 = flushSessionEventLog(dir, log);
      assert.equal(r2.wrote, 2);

      const r3 = flushSessionEventLog(dir, log);
      assert.equal(r3.wrote, 0);

      const loaded = loadSessionEventLogFromDir(dir);
      assert.ok(loaded);
      assert.equal(loaded.session_id, 'sess-flush');
      assert.equal(loaded.events.length, 3);
      assert.equal(loaded.events[0]!.kind, 'user_submitted');
      assert.equal(loaded.events[2]!.kind, 'tool_completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serialize/parse round-trip and rewrite', () => {
    const log = createSessionEventLog('sess-rw');
    recordUserSubmitted(log, { turn_id: 't', task: 'x'.repeat(600) });
    const raw = serializeSessionEventLog(log);
    const parsed = parseSessionEventLog(raw);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0]!.kind, 'user_submitted');
    if (parsed.events[0]!.kind === 'user_submitted') {
      assert.equal(parsed.events[0]!.task_preview.length, 500);
    }

    const dir = mkdtempSync(join(tmpdir(), 'babel-session-rewrite-'));
    try {
      rewriteSessionEventLog(dir, log);
      const disk = readFileSync(join(dir, SESSION_EVENTS_FILENAME), 'utf-8');
      assert.ok(disk.includes('"kind":"user_submitted"'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('interrupted vs completed idempotency keys (W2.2 prep)', () => {
    const log = createSessionEventLog();
    recordToolProposed(log, {
      turn_id: 't',
      tool_call_id: 'done1',
      tool_name: 'read_file',
    });
    recordToolTerminal(log, {
      turn_id: 't',
      tool_call_id: 'done1',
      tool_name: 'read_file',
      exit_code: 0,
      content: 'ok',
    });
    recordToolProposed(log, {
      turn_id: 't',
      tool_call_id: 'open1',
      tool_name: 'run_command',
    });
    recordToolStarted(log, {
      turn_id: 't',
      tool_call_id: 'open1',
      tool_name: 'run_command',
    });
    // no terminal for open1 → interrupted
    const done = completedToolIdempotencyKeys(log);
    assert.ok(done.has('done1'));
    assert.ok(!done.has('open1'));
    const interrupted = interruptedToolIdempotencyKeys(log);
    assert.deepEqual(interrupted, ['open1']);
  });

  test('rejects wrong schema_version', () => {
    assert.throws(
      () => parseSessionEventLog('{"schema_version":2,"event_id":"x","session_id":"s","turn_id":null,"seq":0,"ts":"t","kind":"turn_ended","outcome":"CANCELLED","status":"x"}\n'),
      /Unsupported session event schema/,
    );
  });
});

describe('W2.2 tool settle kill/resume golden', () => {
  test('kill mid-tool → resume marks interrupted, no silent success', () => {
    // Simulate: propose+start flushed, then process killed before terminal.
    const log = createSessionEventLog('kill-resume');
    recordUserSubmitted(log, { turn_id: 't1', task: 'mutate then verify' });
    recordToolProposed(log, {
      turn_id: 't1',
      tool_call_id: 'call_mut',
      tool_name: 'str_replace',
    });
    recordToolStarted(log, {
      turn_id: 't1',
      tool_call_id: 'call_mut',
      tool_name: 'str_replace',
    });
    recordToolProposed(log, {
      turn_id: 't1',
      tool_call_id: 'call_run',
      tool_name: 'run_command',
    });
    recordToolStarted(log, {
      turn_id: 't1',
      tool_call_id: 'call_run',
      tool_name: 'run_command',
    });
    // Only mutation completed before kill; run_command still in-flight.
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'call_mut',
      tool_name: 'str_replace',
      exit_code: 0,
      content: 'patched',
    });

    assert.deepEqual(interruptedToolIdempotencyKeys(log), ['call_run']);
    assert.equal(shouldSkipToolReExec(log, 'call_mut'), true);
    assert.equal(shouldSkipToolReExec(log, 'call_run'), false);

    const marked = markInterruptedToolsOnResume(log);
    assert.equal(marked.length, 1);
    assert.equal(marked[0]!.kind, 'tool_cancelled');
    if (marked[0]!.kind === 'tool_cancelled') {
      assert.equal(marked[0]!.reason, 'interrupted_mid_tool');
      assert.equal(marked[0]!.idempotency_key, 'call_run');
    }
    // No silent success for interrupted tool.
    assert.equal(shouldSkipToolReExec(log, 'call_run'), true);
    assert.ok(
      !log.events.some(
        (e) => e.kind === 'tool_completed' && e.idempotency_key === 'call_run',
      ),
    );
    // Second resume is idempotent.
    assert.equal(markInterruptedToolsOnResume(log).length, 0);
  });

  test('resume planToolSettle skips completed keys (no double mutate)', () => {
    const log = createSessionEventLog('double-mut');
    recordToolProposed(log, {
      turn_id: 't',
      tool_call_id: 'a',
      tool_name: 'str_replace',
    });
    recordToolStarted(log, {
      turn_id: 't',
      tool_call_id: 'a',
      tool_name: 'str_replace',
    });
    recordToolTerminal(log, {
      turn_id: 't',
      tool_call_id: 'a',
      tool_name: 'str_replace',
      exit_code: 0,
      content: 'ok',
    });
    recordToolProposed(log, {
      turn_id: 't',
      tool_call_id: 'b',
      tool_name: 'str_replace',
    });
    recordToolStarted(log, {
      turn_id: 't',
      tool_call_id: 'b',
      tool_name: 'str_replace',
    });

    const plan = planToolSettle(log, [
      { idempotency_key: 'a', tool_call_id: 'a', tool_name: 'str_replace' },
      { idempotency_key: 'b', tool_call_id: 'b', tool_name: 'str_replace' },
      { idempotency_key: 'c', tool_call_id: 'c', tool_name: 'read_file' },
    ]);
    assert.deepEqual(
      plan.skip.map((t) => t.idempotency_key),
      ['a'],
    );
    assert.deepEqual(
      plan.execute.map((t) => t.idempotency_key),
      ['b', 'c'],
    );
    assert.deepEqual(plan.interrupted, ['b']);
  });

  test('disk dual-write: propose+start survives reload for kill simulation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-settle-kill-'));
    try {
      const log = createSessionEventLog('disk-kill');
      recordToolProposed(log, {
        turn_id: 't',
        tool_call_id: 'run1',
        tool_name: 'run_command',
      });
      recordToolStarted(log, {
        turn_id: 't',
        tool_call_id: 'run1',
        tool_name: 'run_command',
      });
      const flush = flushSessionEventLog(dir, log);
      assert.equal(flush.wrote, 2);

      // "Kill" — new process loads disk only.
      const reloaded = loadSessionEventLogFromDir(dir);
      assert.ok(reloaded);
      assert.deepEqual(interruptedToolIdempotencyKeys(reloaded!), ['run1']);
      markInterruptedToolsOnResume(reloaded!);
      flushSessionEventLog(dir, reloaded!);
      const final = loadSessionEventLogFromDir(dir);
      assert.ok(final!.events.some((e) => e.kind === 'tool_cancelled'));
      assert.equal(interruptedToolIdempotencyKeys(final!).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
