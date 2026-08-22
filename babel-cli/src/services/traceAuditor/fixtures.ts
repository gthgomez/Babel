/**
 * traceAuditor/fixtures.ts — synthetic harness stream builders for auditor tests.
 *
 * Pure functions producing raw JSONL text keyed by relative file name, written
 * into tmp dirs by tests (mkdtempSync pattern). No real run data is used.
 *
 * Envelopes mirror the real writers:
 *   - session-events.jsonl: snake_case {schema_version:1, event_id, session_id,
 *     turn_id, seq, ts, kind, ...}  (agent/sessionEvents.ts)
 *   - episode-events.jsonl: camelCase {schemaVersion:1, eventId, sessionId,
 *     turnId, seq, ts, kind, type, payload}  (evidence/episodeStream.ts)
 *   - policy-events.jsonl: {at_turn, kind, detail?, tool?} with NO durable id
 *     (agent/policyEventLog.ts) — the auditor synthesizes `policy:L<line>` ids.
 */

export type FixtureFiles = Record<string, string>;

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(2, '0')}`;
}
export function resetFixtureIds(): void {
  counter = 0;
}

// ─── Line builders ───────────────────────────────────────────────────────────

export interface SessionEventSpec {
  seq: number;
  ts: string;
  eventId?: string;
  turnId?: string | null;
  kind: string;
  fields?: Record<string, unknown>;
}

export function sessionLine(spec: SessionEventSpec): string {
  const base: Record<string, unknown> = {
    schema_version: 1,
    event_id: spec.eventId ?? nextId('se'),
    session_id: 'sess-fixture',
    turn_id: spec.turnId ?? null,
    seq: spec.seq,
    ts: spec.ts,
    kind: spec.kind,
  };
  return JSON.stringify({ ...base, ...(spec.fields ?? {}) });
}

export interface EpisodeEventSpec {
  seq: number;
  ts: string;
  eventId?: string;
  kind: string;
  type: string;
  payload?: Record<string, unknown>;
}

export function episodeLine(spec: EpisodeEventSpec): string {
  return JSON.stringify({
    schemaVersion: 1,
    eventId: spec.eventId ?? nextId('ev'),
    sessionId: 'sess-fixture',
    turnId: null,
    seq: spec.seq,
    ts: spec.ts,
    kind: spec.kind,
    type: spec.type,
    payload: spec.payload ?? {},
  });
}

export interface PolicyEventSpec {
  atTurn: number;
  kind: string;
  detail?: string;
  tool?: string;
}

export function policyLine(spec: PolicyEventSpec): string {
  return JSON.stringify({
    at_turn: spec.atTurn,
    kind: spec.kind,
    ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
    ...(spec.tool !== undefined ? { tool: spec.tool } : {}),
  });
}

function toText(lines: readonly string[]): string {
  return lines.join('\n') + '\n';
}

// ─── Shared event fragments ──────────────────────────────────────────────────

function mutationBatch(seq: number, ts: string, path = 'src/feature.ts'): string {
  return sessionLine({
    seq,
    ts,
    kind: 'mutation_batch',
    fields: { paths: [path] },
  });
}

function verifierAttempt(
  seq: number,
  ts: string,
  command: string,
  exitCode: number,
  opts?: { receipt?: Record<string, unknown> },
): string {
  return sessionLine({
    seq,
    ts,
    kind: 'verifier_attempt',
    fields: {
      command_preview: command,
      authoritative: true,
      exit_code: exitCode,
      ...(opts?.receipt !== undefined ? { receipt: opts.receipt } : {}),
    },
  });
}

function completionDecision(seq: number, ts: string, allowed: boolean): string {
  return sessionLine({
    seq,
    ts,
    kind: 'completion_decision',
    fields: {
      requested_outcome: allowed ? 'completed' : 'blocked',
      final_outcome: allowed ? 'completed' : 'blocked',
      allowed,
      reason: allowed ? 'requested by model' : 'gate refused',
      evidence_refs: [],
      policy_version: 'v1',
    },
  });
}

function turnEnded(seq: number, ts: string, outcome: string): string {
  return sessionLine({
    seq,
    ts,
    kind: 'turn_ended',
    fields: { outcome, status: outcome === 'VERIFIED_COMPLETE' ? 'ok' : 'done' },
  });
}

function passingReceipt(): Record<string, unknown> {
  return {
    receiptId: nextId('receipt'),
    command: 'npm test',
    exitCode: 0,
    stale: false,
    boundRevision: {
      compositeTreeHash: 'deadbeef',
      gitCommitHash: null,
      fileHashes: {},
      capturedAt: 0,
    },
  };
}

// ─── Scenario composers ──────────────────────────────────────────────────────

/** Policy denies a verification command after a mutation; no completion boundary follows. */
export function verificationBlockedFiles(): FixtureFiles {
  resetFixtureIds();
  const t = ['2026-08-21T10:00:00Z', '2026-08-21T10:00:01Z'];
  return {
    'session-events.jsonl': toText([
      mutationBatch(0, t[0]!),
      sessionLine({ seq: 1, ts: t[1]!, kind: 'model_started' }),
    ]),
    'policy-events.jsonl': toText([
      policyLine({ atTurn: 1, kind: 'policy_deny', detail: "command denied: npm test --filter core", tool: 'shell' }),
    ]),
  };
}

/**
 * Completion allowed=true but no passing verifier anywhere; one failing
 * attempt with exit_code 1 → near_miss.
 */
export function unverifiedCompletionFiles(): FixtureFiles {
  resetFixtureIds();
  const t = ['2026-08-21T11:00:00Z', '2026-08-21T11:00:01Z', '2026-08-21T11:00:02Z'];
  return {
    'session-events.jsonl': toText([
      mutationBatch(0, t[0]!),
      verifierAttempt(1, t[1]!, 'npm test', 1),
      completionDecision(2, t[2]!, true),
    ]),
  };
}

/** Denial occurred early but run still finished VERIFIED_COMPLETE. */
export function succeededDespiteHarnessFiles(): FixtureFiles {
  resetFixtureIds();
  const t = ['2026-08-21T12:00:00Z', '2026-08-21T12:00:01Z', '2026-08-21T12:00:02Z', '2026-08-21T12:00:03Z'];
  return {
    'session-events.jsonl': toText([
      mutationBatch(0, t[0]!),
      verifierAttempt(1, t[2]!, 'npm test', 0, { receipt: passingReceipt() }),
      completionDecision(2, t[3]!, true),
      turnEnded(3, t[3]!, 'VERIFIED_COMPLETE'),
    ]),
    'policy-events.jsonl': toText([
      policyLine({ atTurn: 1, kind: 'policy_deny', detail: 'command denied: npm run full-suite', tool: 'shell' }),
    ]),
  };
}

/**
 * Retry storm dominated by model-side signals (stream_idle x4, settlements
 * failed) → MODEL weight should dominate ("probably not Babel").
 */
export function retryStormModelDominatedFiles(): FixtureFiles {
  resetFixtureIds();
  const lines: string[] = [];
  let seq = 0;
  const attempts = [2, 3, 4, 5];
  for (const attempt of attempts) {
    lines.push(sessionLine({
      seq: seq++,
      ts: `2026-08-21T13:00:0${attempt - 2}Z`,
      turnId: 'turn-1',
      kind: 'provider_retry_scheduled',
      fields: {
        provider: 'deepseek',
        model: 'm-fix',
        attempt,
        reason: 'stream_idle',
        backoff_ms: 500 * attempt,
      },
    }));
    lines.push(sessionLine({
      seq: seq++,
      ts: `2026-08-21T13:00:0${attempt - 2}Z`,
      turnId: 'turn-1',
      kind: 'provider_retry_settled',
      fields: { provider: 'deepseek', model: 'm-fix', attempt, outcome: 'failed' },
    }));
  }
  return { 'session-events.jsonl': toText(lines) };
}

/** Compaction followed by 3 re-reads of the same target in a nested chat-session dir. */
export function contextPressureFiles(): FixtureFiles {
  resetFixtureIds();
  const compaction = sessionLine({
    seq: 0,
    ts: '2026-08-21T14:00:00Z',
    kind: 'compaction_started',
    fields: {
      operation_id: 'op-cx-1',
      strategy: 'capsule',
      replaces_thread_seq_start: 0,
      replaces_thread_seq_end: 50,
      replaces_message_count: 20,
    },
  });
  const reads: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    reads.push(sessionLine({
      seq: i + 1,
      ts: `2026-08-21T14:00:1${i}Z`,
      kind: 'tool_completed',
      fields: {
        tool_call_id: `call-r${i}`,
        tool_name: 'read_file',
        idempotency_key: `key-r${i}`,
        target_summary: 'src/big-module.ts',
        exit_code: 0,
      },
    }));
  }
  return {
    'chat-sessions/chat-a/session-events.jsonl': toText([compaction, ...reads]),
  };
}

/** Two tool_parse_reject events against the same tool. */
export function toolMalformatFiles(): FixtureFiles {
  resetFixtureIds();
  return {
    'policy-events.jsonl': toText([
      policyLine({ atTurn: 2, kind: 'tool_parse_reject', detail: 'schema mismatch at .files[0]', tool: 'edit_file' }),
      policyLine({ atTurn: 3, kind: 'arg_validation_fail', detail: 'missing required arg: path', tool: 'edit_file' }),
    ]),
  };
}

/** Ten verification denials after one mutation → cap must limit findings to max. */
export function tenVerificationDenialsFiles(): FixtureFiles {
  resetFixtureIds();
  const sessionLines = [
    mutationBatch(0, '2026-08-21T15:00:00Z'),
    completionDecision(1, '2026-08-21T15:00:20Z', true),
  ];
  const policyLines: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    policyLines.push(
      policyLine({
        atTurn: 1 + Math.floor(i / 2),
        kind: 'policy_deny',
        detail: `command denied: npm test --variant-${i}`,
        tool: 'shell',
      }),
    );
  }
  return {
    'session-events.jsonl': toText(sessionLines),
    'policy-events.jsonl': toText(policyLines),
  };
}

/** Valid prefix then a corrupt line at line 3. */
export function corruptStreamFiles(): FixtureFiles {
  resetFixtureIds();
  return {
    'session-events.jsonl':
      sessionLine({ seq: 0, ts: '2026-08-21T16:00:00Z', kind: 'model_started' }) + '\n' +
      sessionLine({ seq: 1, ts: '2026-08-21T16:00:01Z', kind: 'user_submitted', fields: { task_preview: 'do thing' } }) + '\n' +
      '{NOT VALID JSON\n' +
      sessionLine({ seq: 2, ts: '2026-08-21T16:00:02Z', kind: 'model_started' }) + '\n',
  };
}

/** Benign run: mutation, failing verifier then passing receipt, verified complete. */
export function cleanRunFiles(): FixtureFiles {
  resetFixtureIds();
  const t = ['2026-08-21T17:00:00Z', '2026-08-21T17:00:01Z', '2026-08-21T17:00:02Z', '2026-08-21T17:00:03Z'];
  return {
    'session-events.jsonl': toText([
      mutationBatch(0, t[0]!),
      verifierAttempt(1, t[1]!, 'npm test', 1),
      verifierAttempt(2, t[2]!, 'npm test', 0, { receipt: passingReceipt() }),
      turnEnded(3, t[3]!, 'VERIFIED_COMPLETE'),
    ]),
  };
}
