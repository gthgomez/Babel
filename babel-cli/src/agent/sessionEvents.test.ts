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
  appendSessionEvent,
  recordUserSubmitted,
  recordModelStarted,
  recordModelInputReceipt,
  recordModelInvocationPhase,
  recordCapabilityBindingReceipt,
  recordModelResultDelivery,
  recordProviderRetryScheduled,
  recordProviderRetrySettled,
  recordCompactionStarted,
  recordCompactionSummary,
  recordCompactionCommitted,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordVerifierAttempt,
  recordTurnEnded,
  recordRecoveredOutcomeReconciled,
  flushSessionEventLog,
  rewriteSessionEventLog,
  loadSessionEventLogFromDir,
  inspectSessionEventLogFromDir,
  parseSessionEventLog,
  serializeSessionEventLog,
  completedToolIdempotencyKeys,
  interruptedToolIdempotencyKeys,
  interruptedToolRecoveries,
  markInterruptedToolsOnResume,
  resumedToolRecoveryGuidance,
  planToolSettle,
  shouldSkipToolReExec,
  shortDigest,
  SESSION_EVENT_SCHEMA_VERSION,
  SESSION_EVENTS_FILENAME,
} from './sessionEvents.js';
import { buildModelRouteReceipt, hashRouteReference } from './modelRouteReceipt.js';

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
    recordToolProposed(log, { turn_id: 't1', tool_call_id: 'x', tool_name: 'run_command' });
    recordToolStarted(log, { turn_id: 't1', tool_call_id: 'x', tool_name: 'run_command' });
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'x',
      tool_name: 'run_command',
      exit_code: 1,
      content: 'ModuleNotFoundError: web',
    });
    assert.equal(log.events.at(-1)!.kind, 'tool_failed');
  });

  test('tool_cancelled branch', () => {
    const log = createSessionEventLog();
    recordToolProposed(log, { turn_id: 't1', tool_call_id: 'x', tool_name: 'run_command' });
    recordToolStarted(log, { turn_id: 't1', tool_call_id: 'x', tool_name: 'run_command' });
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'x',
      tool_name: 'run_command',
      cancelled: true,
      reason: 'kill mid-tool',
    });
    assert.equal(log.events.at(-1)!.kind, 'tool_cancelled');
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
      recordToolStarted(log, {
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
      assert.equal(r2.wrote, 3);

      const r3 = flushSessionEventLog(dir, log);
      assert.equal(r3.wrote, 0);

      const loaded = loadSessionEventLogFromDir(dir);
      assert.ok(loaded);
      assert.equal(loaded.session_id, 'sess-flush');
      assert.equal(loaded.events.length, 4);
      assert.equal(loaded.events[0]!.kind, 'user_submitted');
      assert.equal(loaded.events[3]!.kind, 'tool_completed');
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
    recordToolStarted(log, {
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

  test('requires exact append-only sequence continuity and rejects empty content', () => {
    const event = (seq: number): string =>
      JSON.stringify({
        schema_version: SESSION_EVENT_SCHEMA_VERSION,
        event_id: 'event-' + seq,
        session_id: 'session-sequence',
        turn_id: null,
        seq,
        ts: '2026-08-13T00:00:00.000Z',
        kind: 'model_started',
      });

    assert.equal(parseSessionEventLog([0, 1, 2].map(event).join('\n')).events.length, 3);
    for (const seqs of [[5], [0, 1, 3], [0, 1, 1], [0, 2, 1]]) {
      assert.throws(
        () => parseSessionEventLog(seqs.map(event).join('\n')),
        /seq must be contiguous starting at 0/,
      );
    }
    assert.throws(() => parseSessionEventLog(''), /no events found/);
    assert.throws(() => parseSessionEventLog(' \n\t'), /no events found/);
  });
});

describe('B2 durable recovery-reconciliation causality', () => {
  const fingerprint = 'a'.repeat(64);
  const recoveryInput = {
    turn_id: 'resume-turn' as const,
    recovered_idempotency_key: 'effect-key',
    operation_fingerprint: fingerprint,
    reconciliation_ref: 'operator-ticket-B2-42',
  };

  function appendUnknownCancellation(
    log: ReturnType<typeof createSessionEventLog>,
    input: {
      idempotencyKey?: string;
      fingerprint?: string;
      effectClass?: 'non_idempotent_local_effect' | 'external_side_effect' | 'reconcilable_mutation';
      lifecycle?: boolean;
    } = {},
  ): void {
    const idempotencyKey = input.idempotencyKey ?? recoveryInput.recovered_idempotency_key;
    const operationFingerprint = input.fingerprint ?? fingerprint;
    if (input.lifecycle !== false) {
      recordToolProposed(log, {
        turn_id: 'resume-turn', tool_call_id: 'effect-call', tool_name: 'run_command',
        idempotency_key: idempotencyKey, effect_class: input.effectClass ?? 'non_idempotent_local_effect',
        args_digest: operationFingerprint,
      });
      recordToolStarted(log, {
        turn_id: 'resume-turn', tool_call_id: 'effect-call', tool_name: 'run_command',
        idempotency_key: idempotencyKey, effect_class: input.effectClass ?? 'non_idempotent_local_effect',
      });
    }
    if (input.lifecycle === false) {
      appendForgedTerminalUnsafe(log, { kind: 'tool_cancelled', idempotencyKey });
      return;
    }
    recordToolTerminal(log, {
      turn_id: 'resume-turn', tool_call_id: 'effect-call', tool_name: 'run_command',
      idempotency_key: idempotencyKey, cancelled: true,
      recovery_state: 'TOOL_OUTCOME_UNKNOWN', effect_class: input.effectClass ?? 'non_idempotent_local_effect',
      args_digest: operationFingerprint,
    });
  }

  /** Test-only corruption helper: bypasses the public append guard to model forged disk data. */
  function appendForgedAuthorizationUnsafe(
    log: ReturnType<typeof createSessionEventLog>,
    input = recoveryInput,
  ): void {
    const seq = log.nextSeq++;
    log.events.push({
      schema_version: SESSION_EVENT_SCHEMA_VERSION,
      event_id: `forged-recovery-${seq}`,
      session_id: log.session_id,
      turn_id: input.turn_id,
      seq,
      ts: '2026-08-13T00:00:00.000Z',
      kind: 'recovery_reconciled',
      recovered_idempotency_key: input.recovered_idempotency_key,
      operation_fingerprint: input.operation_fingerprint,
      reconciliation_ref: input.reconciliation_ref,
    });
  }

  /** Test-only corruption helper for terminal rows that must never pass public append. */
  function appendForgedTerminalUnsafe(
    log: ReturnType<typeof createSessionEventLog>,
    input: { kind: 'tool_cancelled' | 'tool_completed'; idempotencyKey?: string; toolCallId?: string; recovery?: boolean } = { kind: 'tool_cancelled' },
  ): void {
    const seq = log.nextSeq++;
    log.events.push({
      schema_version: SESSION_EVENT_SCHEMA_VERSION,
      event_id: `forged-terminal-${seq}`,
      session_id: log.session_id,
      turn_id: 'resume-turn',
      seq,
      ts: '2026-08-13T00:00:00.000Z',
      kind: input.kind,
      tool_call_id: input.toolCallId ?? 'effect-call',
      tool_name: 'run_command',
      idempotency_key: input.idempotencyKey ?? recoveryInput.recovered_idempotency_key,
      ...(input.kind === 'tool_completed' ? { exit_code: 0 } : {}),
      ...(input.kind === 'tool_cancelled' && input.recovery !== false ? {
        recovery_state: 'TOOL_OUTCOME_UNKNOWN' as const,
        effect_class: 'non_idempotent_local_effect' as const,
        args_digest: fingerprint,
      } : {}),
    } as never);
  }
  function assertPersistedReload(
    name: string,
    log: ReturnType<typeof createSessionEventLog>,
    expected: RegExp,
  ): void {
    const dir = mkdtempSync(join(tmpdir(), `babel-recovery-causality-${name}-`));
    try {
      rewriteSessionEventLog(dir, log);
      const result = inspectSessionEventLogFromDir(dir, log.session_id);
      assert.equal(result.kind, 'invalid', `${name} must be rejected on durable reload`);
      if (result.kind === 'invalid') assert.match(result.error.message, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('accepts a valid full durable lifecycle and rejects duplicate in-memory authorization', () => {
    const log = createSessionEventLog('valid-recovery-auth');
    appendUnknownCancellation(log);
    recordRecoveredOutcomeReconciled(log, recoveryInput);
    assert.throws(
      () => recordRecoveredOutcomeReconciled(log, recoveryInput),
      /authorization is duplicated/,
      'the append boundary itself must reject replay',
    );
    const dir = mkdtempSync(join(tmpdir(), 'babel-recovery-causality-valid-'));
    try {
      rewriteSessionEventLog(dir, log);
      const result = inspectSessionEventLogFromDir(dir, log.session_id);
      assert.equal(result.kind, 'valid');
      if (result.kind === 'valid') assert.equal(result.log.events.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('append boundary rejects premature authorization and forged cancellation-only logs fail persisted parse', () => {
    const premature = createSessionEventLog('authorization-before-cancellation');
    assert.throws(
      () => recordRecoveredOutcomeReconciled(premature, recoveryInput),
      /exactly one prior TOOL_OUTCOME_UNKNOWN cancellation/,
    );
    assert.equal(premature.events.length, 0, 'rejected authorization must not mutate the in-memory log');
    assert.throws(
      () => appendSessionEvent(premature, { kind: 'recovery_reconciled', ...recoveryInput }),
      /exactly one prior TOOL_OUTCOME_UNKNOWN cancellation/,
      'the generic public append boundary must not bypass recovery authorization validation',
    );
    assert.equal(premature.events.length, 0, 'generic append rejection must not mutate the in-memory log');

    const forgedCancellationOnly = createSessionEventLog('forged-cancellation-only');
    appendUnknownCancellation(forgedCancellationOnly, { lifecycle: false });
    appendForgedAuthorizationUnsafe(forgedCancellationOnly);
    assertPersistedReload('cancellation-only', forgedCancellationOnly, /terminal tool event requires one prior tool_proposed and tool_started/);
  });

  test('rejects authorization with an unmatched key, wrong fingerprint, or non-qualifying effect', () => {
    const unmatched = createSessionEventLog('unmatched-recovery-key');
    appendUnknownCancellation(unmatched);
    appendForgedAuthorizationUnsafe(unmatched, { ...recoveryInput, recovered_idempotency_key: 'other-effect-key' });
    assertPersistedReload('unmatched-key', unmatched, /exactly one prior TOOL_OUTCOME_UNKNOWN cancellation/);

    const wrongFingerprint = createSessionEventLog('wrong-recovery-fingerprint');
    appendUnknownCancellation(wrongFingerprint);
    appendForgedAuthorizationUnsafe(wrongFingerprint, { ...recoveryInput, operation_fingerprint: 'b'.repeat(64) });
    assertPersistedReload('wrong-fingerprint', wrongFingerprint, /exactly one prior TOOL_OUTCOME_UNKNOWN cancellation/);

    const nonQualifying = createSessionEventLog('non-qualifying-effect');
    appendUnknownCancellation(nonQualifying, { effectClass: 'reconcilable_mutation' });
    appendForgedAuthorizationUnsafe(nonQualifying);
    assertPersistedReload('non-qualifying-effect', nonQualifying, /effect_class is not eligible/);
  });

  test('rejects a forged lifecycle with mismatched dispatch identity or a prior terminal', () => {
    const mismatchedStart = createSessionEventLog('mismatched-recovery-start');
    appendUnknownCancellation(mismatchedStart);
    const start = mismatchedStart.events.find((event) => event.kind === 'tool_started');
    assert.ok(start && start.kind === 'tool_started');
    start.tool_call_id = 'other-call';
    appendForgedAuthorizationUnsafe(mismatchedStart);
    assertPersistedReload('mismatched-start', mismatchedStart, /tool_started requires exactly one prior tool_proposed/);

    const priorTerminal = createSessionEventLog('prior-recovery-terminal');
    recordToolProposed(priorTerminal, {
      turn_id: 'resume-turn', tool_call_id: 'effect-call', tool_name: 'run_command',
      idempotency_key: recoveryInput.recovered_idempotency_key,
      effect_class: 'non_idempotent_local_effect', args_digest: fingerprint,
    });
    recordToolStarted(priorTerminal, {
      turn_id: 'resume-turn', tool_call_id: 'effect-call', tool_name: 'run_command',
      idempotency_key: recoveryInput.recovered_idempotency_key, effect_class: 'non_idempotent_local_effect',
    });
    recordToolTerminal(priorTerminal, {
      turn_id: 'resume-turn', tool_call_id: 'effect-call', tool_name: 'run_command',
      idempotency_key: recoveryInput.recovered_idempotency_key, failed: true, content: 'failed before cancellation',
    });

    appendForgedTerminalUnsafe(priorTerminal, { kind: 'tool_cancelled' });

    appendForgedAuthorizationUnsafe(priorTerminal);
    assertPersistedReload('prior-terminal', priorTerminal, /tool lifecycle cannot record a terminal after a terminal/);
  });

  test('rejects a persisted terminal recorded after the unknown cancellation before authorization', () => {
    const terminalAfterCancellation = createSessionEventLog('terminal-after-unknown-cancellation');
    appendUnknownCancellation(terminalAfterCancellation);
    assert.throws(
      () => recordToolTerminal(terminalAfterCancellation, {
        turn_id: 'resume-turn', tool_call_id: 'effect-call', tool_name: 'run_command',
        idempotency_key: recoveryInput.recovered_idempotency_key, exit_code: 0, content: 'contradictory completion',
      }),
      /tool lifecycle cannot record a terminal after a terminal/,
    );
    appendForgedTerminalUnsafe(terminalAfterCancellation, { kind: 'tool_completed' });
    appendForgedAuthorizationUnsafe(terminalAfterCancellation);
    assertPersistedReload(
      'terminal-after-unknown-cancellation',
      terminalAfterCancellation,
      /tool lifecycle cannot record a terminal after a terminal/,
    );
  });

  test('rejects malformed recovery identifiers and operation fingerprints', () => {
    const invalidFingerprint = createSessionEventLog('invalid-recovery-fingerprint');
    appendUnknownCancellation(invalidFingerprint);
    appendForgedAuthorizationUnsafe(invalidFingerprint, { ...recoveryInput, operation_fingerprint: 'not-a-digest' });
    assertPersistedReload('invalid-fingerprint', invalidFingerprint, /SHA-256 hex digest/);

    const invalidToolId = createSessionEventLog('invalid-recovered-tool-id');
    appendUnknownCancellation(invalidToolId);
    const cancellation = invalidToolId.events.find((event) => event.kind === 'tool_cancelled');
    assert.ok(cancellation && cancellation.kind === 'tool_cancelled');
    cancellation.tool_call_id = '';
    appendForgedAuthorizationUnsafe(invalidToolId);
    assertPersistedReload('invalid-tool-id', invalidToolId, /tool identifiers must be non-empty/);
  });

  test('append boundary rejects ambiguity and persisted replay or duplicate ids', () => {
    const ambiguous = createSessionEventLog('ambiguous-recovery-cancellation');
    appendUnknownCancellation(ambiguous);
    appendForgedTerminalUnsafe(ambiguous, { kind: 'tool_cancelled' });
    assert.throws(
      () => recordRecoveredOutcomeReconciled(ambiguous, recoveryInput),
      /exactly one prior TOOL_OUTCOME_UNKNOWN cancellation/,
    );

    const replay = createSessionEventLog('replayed-recovery-authorization');
    appendUnknownCancellation(replay);
    recordRecoveredOutcomeReconciled(replay, recoveryInput);
    appendForgedAuthorizationUnsafe(replay);
    assertPersistedReload('replayed-authorization', replay, /authorization is duplicated/);

    const duplicateId = createSessionEventLog('duplicate-recovery-event-id');
    appendUnknownCancellation(duplicateId);
    recordRecoveredOutcomeReconciled(duplicateId, recoveryInput);
    duplicateId.events[3]!.event_id = duplicateId.events[0]!.event_id;
    assertPersistedReload('duplicate-event-id', duplicateId, /event_id is duplicated/);
  });
});
describe('C2 compaction lifecycle causality', () => {
  const digest = 'c'.repeat(64);
  const start = {
    operation_id: 'compact-1', strategy: 'heuristic',
    replaces_thread_seq_start: 0, replaces_thread_seq_end: 4, replaces_message_count: 5,
  };

  test('requires start → summary → committed and rejects a tampered replacement range on parse', () => {
    const log = createSessionEventLog('c2-lifecycle');
    assert.throws(
      () => recordCompactionSummary(log, null, {
        operation_id: start.operation_id, capsule_digest: digest,
        raw_observation_refs: [], preserved_tool_call_ids: [],
      }),
      /requires one prior start/,
    );
    recordCompactionStarted(log, null, start);
    recordCompactionSummary(log, null, {
      operation_id: start.operation_id, capsule_digest: digest,
      raw_observation_refs: ['obs:one'], preserved_tool_call_ids: ['call-1'],
    });
    recordCompactionCommitted(log, null, {
      thread_event_id: 'thread-capsule-1', capsule_digest: digest,
      ...start, preserved_tool_call_ids: ['call-1'],
    });
    const parsed = parseSessionEventLog(serializeSessionEventLog(log));
    assert.equal(parsed.events.length, 3);
    const committed = log.events[2]! as Extract<typeof log.events[number], { kind: 'compaction_committed' }>;
    committed.replaces_thread_seq_end = 9;
    assert.throws(
      () => parseSessionEventLog(serializeSessionEventLog(log)),
      /must link one prior start and summary exactly/,
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

  test('persisted reload distinguishes proposed-not-started from started-without-terminal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-recovery-boundary-'));
    try {
      const log = createSessionEventLog('recovery-boundary');
      recordToolProposed(log, {
        turn_id: 't', tool_call_id: 'write-1', tool_name: 'write_file',
        idempotency_key: 'write-1', effect_class: 'reconcilable_mutation',
      });
      // Fault injection: process dies after proposal but before dispatch.
      flushSessionEventLog(dir, log);
      const beforeDispatch = loadSessionEventLogFromDir(dir)!;
      assert.deepEqual(interruptedToolRecoveries(beforeDispatch), [{
        idempotencyKey: 'write-1', toolCallId: 'write-1', toolName: 'write_file',
        effectClass: 'reconcilable_mutation', state: 'TOOL_NOT_STARTED',
        reconciliation: 'reconsider_and_authorize',
      }]);
      markInterruptedToolsOnResume(beforeDispatch);
      flushSessionEventLog(dir, beforeDispatch);

      const afterProposalRepair = loadSessionEventLogFromDir(dir)!;
      assert.equal(shouldSkipToolReExec(afterProposalRepair, 'write-1'), true);
      assert.match(resumedToolRecoveryGuidance(afterProposalRepair) ?? '', /TOOL_NOT_STARTED/);

      recordToolProposed(afterProposalRepair, {
        turn_id: 't', tool_call_id: 'shell-1', tool_name: 'run_command',
        idempotency_key: 'shell-1', effect_class: 'non_idempotent_local_effect',
      });
      recordToolStarted(afterProposalRepair, {
        turn_id: 't', tool_call_id: 'shell-1', tool_name: 'run_command',
        idempotency_key: 'shell-1', effect_class: 'non_idempotent_local_effect',
      });
      // Fault injection: process dies after real dispatch marker, before terminal.
      flushSessionEventLog(dir, afterProposalRepair);
      const afterDispatch = loadSessionEventLogFromDir(dir)!;
      assert.deepEqual(interruptedToolRecoveries(afterDispatch), [{
        idempotencyKey: 'shell-1', toolCallId: 'shell-1', toolName: 'run_command',
        effectClass: 'non_idempotent_local_effect', state: 'TOOL_OUTCOME_UNKNOWN',
        reconciliation: 'manual_review_no_auto_retry',
      }]);
      markInterruptedToolsOnResume(afterDispatch);
      flushSessionEventLog(dir, afterDispatch);

      const final = loadSessionEventLogFromDir(dir)!;
      assert.equal(shouldSkipToolReExec(final, 'shell-1'), true);
      const guidance = resumedToolRecoveryGuidance(final) ?? '';
      assert.match(guidance, /TOOL_OUTCOME_UNKNOWN/);
      assert.match(guidance, /manual_review_no_auto_retry/);
      assert.doesNotMatch(guidance, /secret|content/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

test('persists content-free provider retry schedule and settlement', () => {
  const log = createSessionEventLog('retry-session');
  recordUserSubmitted(log, { turn_id: 'turn-retry', task: 'retry once' });
  recordProviderRetryScheduled(log, {
    turn_id: 'turn-retry', provider: 'deepseek', model: 'deepseek-v4-flash',
    attempt: 2, reason: 'rate_limit', backoff_ms: 250,
  });
  recordProviderRetrySettled(log, {
    turn_id: 'turn-retry', provider: 'deepseek', model: 'deepseek-v4-flash',
    attempt: 2, outcome: 'succeeded',
  });
  const restored = parseSessionEventLog(serializeSessionEventLog(log), 'retry-session');
  assert.deepEqual(restored.events.map((event) => event.kind), [
    'user_submitted', 'provider_retry_scheduled', 'provider_retry_settled',
  ]);
  assert.equal((restored.events[1] as any).backoff_ms, 250);
  assert.equal((restored.events[2] as any).outcome, 'succeeded');
});

test('round-trips causal model input and result-delivery receipts', () => {
  const log = createSessionEventLog('model-lifecycle-session');
  const digest = 'a'.repeat(64);
  recordUserSubmitted(log, {
    turn_id: 'turn-model',
    task: 'prove the exact model route',
    model: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
  });
  recordModelInputReceipt(log, {
    turn_id: 'turn-model',
    inference_id: 'inference-1',
    provider: 'openrouter',
    requested_model_id: 'z-ai/glm-5.3-flash',
    normalized_model_id: 'z-ai/glm-5.3-flash',
    sent_model_id: 'z-ai/glm-5.3-flash',
    input_digest: digest,
    input_ref: 'thread_events.json',
    input_message_count: 3,
    route_receipt: buildModelRouteReceipt({
      projectRef: hashRouteReference('project'),
      taskRef: hashRouteReference('prove the exact model route'),
      runRef: 'run-1',
      contractRef: 'chat',
      inferenceId: 'inference-1',
      executionStage: 'chat',
      requestedModelSelector: 'z-ai/glm-5.3-flash',
      normalizedBabelModel: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
      exactModelIdSent: 'z-ai/glm-5.3-flash',
      timestamp: '2026-08-28T00:00:00.000Z',
    }),
  });
  recordCapabilityBindingReceipt(log, {
    turn_id: 'turn-model',
    inference_id: 'inference-1',
    provider: 'openrouter',
    capability: 'write_file',
    advertised: true,
    authorized: null,
    effective: null,
    evidence_ref: 'thread_events.json',
  });
  recordModelResultDelivery(log, {
    turn_id: 'turn-model',
    inference_id: 'inference-1',
    provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash',
    status: 'delivered',
    observed_model_id: 'z-ai/glm-5.3-flash',
    upstream_provider: 'ExampleProvider',
    output_digest: digest,
    route_receipt: buildModelRouteReceipt({
      projectRef: hashRouteReference('project'),
      taskRef: hashRouteReference('prove the exact model route'),
      runRef: 'run-1',
      contractRef: 'chat',
      inferenceId: 'inference-1',
      executionStage: 'chat',
      requestedModelSelector: 'z-ai/glm-5.3-flash',
      normalizedBabelModel: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
      exactModelIdSent: 'z-ai/glm-5.3-flash',
      observedModelId: 'z-ai/glm-5.3-flash',
      upstreamProvider: 'ExampleProvider',
      retryCount: 1,
      timestamp: '2026-08-28T00:00:01.000Z',
    }),
  });
  recordToolProposed(log, {
    turn_id: 'turn-model',
    tool_call_id: 'verify-1',
    tool_name: 'run_command',
  });
  recordToolStarted(log, {
    turn_id: 'turn-model',
    tool_call_id: 'verify-1',
    tool_name: 'run_command',
  });
  recordToolTerminal(log, {
    turn_id: 'turn-model',
    tool_call_id: 'verify-1',
    tool_name: 'run_command',
    exit_code: 0,
    content: 'passed',
  });
  recordVerifierAttempt(log, {
    turn_id: 'turn-model',
    command_preview: 'npm test',
    authoritative: true,
    exit_code: 0,
    tool_call_id: 'verify-1',
  });

  const restored = parseSessionEventLog(serializeSessionEventLog(log), 'model-lifecycle-session');
  assert.deepEqual(restored.events.map((event) => event.kind), [
    'user_submitted', 'model_input_receipt', 'capability_binding_receipt', 'model_result_delivery',
    'tool_proposed', 'tool_started', 'tool_completed', 'verifier_attempt',
  ]);
  const input = restored.events[1]!;
  assert.equal(input.kind, 'model_input_receipt');
  if (input.kind === 'model_input_receipt') {
    assert.equal(input.input_digest, digest);
    assert.equal(input.input_message_count, 3);
    assert.equal(input.route_receipt?.execution_stage, 'chat');
  }
  const capability = restored.events[2]!;
  assert.equal(capability.kind, 'capability_binding_receipt');
  if (capability.kind === 'capability_binding_receipt') {
    assert.equal(capability.capability, 'write_file');
    assert.equal(capability.authorized, null);
    assert.equal(capability.effective, null);
  }
  const result = restored.events[3]!;
  assert.equal(result.kind, 'model_result_delivery');
  if (result.kind === 'model_result_delivery') {
    assert.equal(result.observed_model_id, 'z-ai/glm-5.3-flash');
    assert.equal(result.upstream_provider, 'ExampleProvider');
    assert.equal(result.route_receipt?.observed_model_id, 'z-ai/glm-5.3-flash');
    assert.equal(result.route_receipt?.upstream_provider, 'ExampleProvider');
    assert.equal(result.route_receipt?.retry_count, 1);
  }
  const verifier = restored.events.at(-1)!;
  assert.equal(verifier.kind, 'verifier_attempt');
  if (verifier.kind === 'verifier_attempt') {
    assert.equal(verifier.tool_call_id, 'verify-1');
  }
});

test('round-trips provider invocation phases and rejects orphan phases', () => {
  const log = createSessionEventLog('model-phase-session');
  recordModelInputReceipt(log, {
    turn_id: 'turn-phase', inference_id: 'inference-phase', provider: 'openrouter',
    requested_model_id: 'z-ai/glm-5.3-flash', normalized_model_id: 'z-ai/glm-5.3-flash',
    sent_model_id: 'z-ai/glm-5.3-flash', input_digest: 'c'.repeat(64), input_ref: 'thread_events.json',
  });
  recordModelInvocationPhase(log, {
    turn_id: 'turn-phase', inference_id: 'inference-phase', provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', phase: 'request_created',
  });
  recordModelInvocationPhase(log, {
    turn_id: 'turn-phase', inference_id: 'inference-phase', provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', phase: 'request_dispatched', status_code: 200,
  });
  recordModelInvocationPhase(log, {
    turn_id: 'turn-phase', inference_id: 'inference-phase', provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', phase: 'response_started', status_code: 200,
  });
  recordModelInvocationPhase(log, {
    turn_id: 'turn-phase', inference_id: 'inference-phase', provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', phase: 'first_byte',
  });
  recordModelInvocationPhase(log, {
    turn_id: 'turn-phase', inference_id: 'inference-phase', provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', phase: 'stream_completed',
  });

  const restored = parseSessionEventLog(serializeSessionEventLog(log), 'model-phase-session');
  assert.deepEqual(
    restored.events.filter((event) => event.kind === 'model_invocation_phase').map((event) => event.phase),
    ['request_created', 'request_dispatched', 'response_started', 'first_byte', 'stream_completed'],
  );

  const orphan = createSessionEventLog('orphan-phase');
  assert.throws(() => recordModelInvocationPhase(orphan, {
    turn_id: 'turn-phase', inference_id: 'missing-input', provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash', phase: 'request_created',
  }), /matching model input receipt/);
});

test('rejects duplicate or mismatched model lifecycle receipts', () => {
  const log = createSessionEventLog('model-lifecycle-causal');
  recordModelInputReceipt(log, {
    turn_id: 'turn-model', inference_id: 'inference-1', provider: 'openrouter',
    requested_model_id: 'z-ai/glm-5.3-flash', normalized_model_id: 'z-ai/glm-5.3-flash',
    sent_model_id: 'z-ai/glm-5.3-flash', input_digest: 'b'.repeat(64), input_ref: 'thread_events.json',
  });
  assert.throws(() => recordModelInputReceipt(log, {
    turn_id: 'turn-model', inference_id: 'inference-1', provider: 'openrouter',
    requested_model_id: 'z-ai/glm-5.3-flash', normalized_model_id: 'z-ai/glm-5.3-flash',
    sent_model_id: 'z-ai/glm-5.3-flash', input_digest: 'b'.repeat(64), input_ref: 'thread_events.json',
  }), /duplicated/);
  assert.throws(() => recordModelResultDelivery(log, {
    turn_id: 'turn-model', inference_id: 'inference-1', provider: 'deepseek',
    model: 'deepseek-v4-flash', status: 'failed',
  }), /identity does not match/);

  const missingToolResult = createSessionEventLog('missing-tool-result');
  assert.throws(() => recordModelInputReceipt(missingToolResult, {
    turn_id: 'turn-model', inference_id: 'inference-with-missing-tool', provider: 'openrouter',
    requested_model_id: 'z-ai/glm-5.3-flash', normalized_model_id: 'z-ai/glm-5.3-flash',
    sent_model_id: 'z-ai/glm-5.3-flash', input_digest: 'd'.repeat(64), input_ref: 'thread_events.json',
    delivered_tool_call_ids: ['tool-without-terminal'],
  }), /has no prior terminal result/);
});

test('rejects verifier receipts whose tool result cannot be reconstructed', () => {
  const log = createSessionEventLog('orphan-verifier');
  recordVerifierAttempt(log, {
    turn_id: 'turn-verifier',
    command_preview: 'npm test',
    authoritative: true,
    exit_code: 0,
    tool_call_id: 'missing-verifier-result',
  });
  assert.throws(
    () => parseSessionEventLog(serializeSessionEventLog(log), 'orphan-verifier'),
    /must match exactly one terminal tool result/,
  );
});

test('round-trips OpenRouter retry evidence through the durable parser', () => {
  const log = createSessionEventLog('openrouter-retry-session');
  recordUserSubmitted(log, {
    turn_id: 'turn-openrouter',
    task: 'run the exact GLM route',
    model: 'z-ai/glm-5.3-flash',
    provider: 'openrouter',
  });
  recordProviderRetryScheduled(log, {
    turn_id: 'turn-openrouter', provider: 'openrouter', model: 'z-ai/glm-5.3-flash',
    attempt: 2, reason: 'server_error', backoff_ms: 200,
  });
  recordProviderRetrySettled(log, {
    turn_id: 'turn-openrouter', provider: 'openrouter', model: 'z-ai/glm-5.3-flash',
    attempt: 2, outcome: 'succeeded',
  });

  const restored = parseSessionEventLog(serializeSessionEventLog(log), 'openrouter-retry-session');
  assert.equal(restored.events[1]!.kind, 'provider_retry_scheduled');
  assert.equal((restored.events[1] as any).provider, 'openrouter');
  assert.equal((restored.events[2] as any).model, 'z-ai/glm-5.3-flash');
});
test('rejects orphaned or overlapping provider retry schedules on durable reload', () => {
  const log = createSessionEventLog('retry-causal');
  recordUserSubmitted(log, { turn_id: 'turn-retry', task: 'retry causally' });
  recordProviderRetryScheduled(log, {
    turn_id: 'turn-retry', provider: 'deepinfra', model: 'model-a',
    attempt: 2, reason: 'server_error', backoff_ms: 200,
  });
  assert.throws(() => recordProviderRetryScheduled(log, {
    turn_id: 'turn-retry', provider: 'deepinfra', model: 'model-a',
    attempt: 3, reason: 'server_error', backoff_ms: 400,
  }), /all prior schedules/);
  assert.throws(() => parseSessionEventLog(serializeSessionEventLog(log), 'retry-causal'), /exactly one settlement/);
  recordProviderRetrySettled(log, {
    turn_id: 'turn-retry', provider: 'deepinfra', model: 'model-a', attempt: 2, outcome: 'failed',
  });
  assert.throws(() => recordProviderRetrySettled(log, {
    turn_id: 'turn-retry', provider: 'deepinfra', model: 'model-a', attempt: 2, outcome: 'failed',
  }), /unmatched prior schedule/);
});
