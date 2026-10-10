/**
 * Packet A4 tests — event-replay-based chat resume.
 *
 * Covers the packet's acceptance criteria:
 *   - determinism: two hydrations from the same log produce identical state
 *     hashes;
 *   - torn-log resume: truncating the last physical line is discarded by the
 *     A2 reader and hydration still succeeds;
 *   - capsule fencing: a P11 capsule without a proven installed lineage is
 *     blocked, and stale receipts surface as gaps;
 *   - P06 classification: indeterminate operations are operator-gated and
 *     automatic resume stays disabled;
 *   - resumeExecution is replay-first with the heuristic fallback retained
 *     behind BABEL_RESUME_HEURISTIC_FALLBACK.
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRuntimeEventLog,
  RUNTIME_EVENT_LOG_FILENAME,
} from '../runtime/eventLog.js';
import type { RuntimeFactV1 } from '../runtime/events.js';
import { RESTORE_REASONS } from '../runtime/restoreReport.js';
import type { ContextCheckpointV1 } from '../runtime/contextCheckpoints.js';
import {
  findRuntimeEventLogInRunDir,
  RESUME_HEURISTIC_FALLBACK_FLAG,
  resumeCapsuleContext,
  resumeHeuristicFallbackEnabled,
  resumeReplayFromLog,
} from './resumeReplay.js';
import { resumeExecution } from './resumeExecution.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fact(overrides: Partial<RuntimeFactV1> = {}): RuntimeFactV1 {
  const sequence = typeof overrides['sequence'] === 'number' ? overrides['sequence'] : 1;
  return {
    schemaVersion: 1,
    id: `fact-${sequence}`,
    cursor: { stream: 'runtime-facts', sequence },
    threadId: 'thread-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    runId: 'run-1',
    sequence,
    causationId: 'cause-1',
    producer: 'legacy_adapter',
    authority: 'observation',
    timestamp: '2026-10-10T00:00:00.000Z',
    payload: { type: 'run.started', ownerGeneration: 1 },
    ...overrides,
  } as RuntimeFactV1;
}

/** Write a small conversation log (run → turn → ops → checkpoint → completion). */
function writeConversationLog(dir: string): string {
  const log = createRuntimeEventLog({ sessionDir: dir });
  const facts: RuntimeFactV1[] = [
    fact({ sequence: 1, payload: { type: 'run.started', ownerGeneration: 1 } }),
    fact({ sequence: 2, payload: { type: 'turn.admitted', commandId: 'cmd-1' } }),
    fact({
      sequence: 3,
      payload: {
        type: 'operation.prepared',
        operationDigest: 'digest-a',
        operationId: 'op-a',
        toolName: 'write_file',
        effectClass: 'reconcilable_mutation',
      },
    }),
    fact({
      sequence: 4,
      payload: { type: 'operation.settled', receiptId: 'receipt-a', operationId: 'op-a', status: 'completed' },
    }),
    fact({
      sequence: 5,
      payload: {
        type: 'operation.prepared',
        operationDigest: 'digest-b',
        operationId: 'op-b',
        toolName: 'bash',
        effectClass: 'external_side_effect',
      },
    }),
    fact({
      sequence: 6,
      payload: { type: 'operation.indeterminate', operationDigest: 'digest-b', operationId: 'op-b', reason: 'provider_timeout_mid_effect' },
    }),
    fact({ sequence: 7, payload: { type: 'context.committed', checkpointId: 'checkpoint-1' } }),
    fact({
      sequence: 8,
      authority: 'authoritative',
      payload: {
        type: 'completion.decided',
        decision: {
          requestedOutcome: 'COMPLETE',
          finalOutcome: 'COMPLETE',
          allowed: true,
          reason: 'verifier passed',
          evidenceRefs: ['receipt:receipt-a'],
          policyVersion: 'v1',
        },
      },
    }),
  ];
  for (const f of facts) assert.deepEqual(log.appendFact(f), { ok: true });
  assert.deepEqual(log.flush(), { ok: true });
  log.close();
  return join(dir, RUNTIME_EVENT_LOG_FILENAME);
}

test('A4: hydration is deterministic — two resumes from the same log hash identically', () => {
  const dir = tmpDir('babel-resume-replay-det-');
  try {
    const path = writeConversationLog(dir);
    const first = resumeReplayFromLog(path);
    const second = resumeReplayFromLog(path);
    assert.ok(first.ok && second.ok);
    assert.equal(first.state.stateHash, second.state.stateHash);
    assert.deepEqual(first.state, second.state);
    // And the state contents are what the facts say.
    assert.equal(first.state.threadId, 'thread-1');
    assert.deepEqual([...first.state.runIds], ['run-1']);
    assert.deepEqual([...first.state.turnIds], ['turn-1']);
    assert.equal(first.state.lastCursorSequence, 8);
    assert.equal(first.state.checkpointIds[0], 'checkpoint-1');
    assert.equal(first.state.completion?.finalOutcome, 'COMPLETE');
    const indeterminate = first.state.operations.find((op) => op.operationId === 'op-b');
    assert.equal(indeterminate?.indeterminateReason, 'provider_timeout_mid_effect');
    const settled = first.state.operations.find((op) => op.operationId === 'op-a');
    assert.equal(settled?.settledReceiptId, 'receipt-a');
    assert.equal(settled?.prepared, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A4: torn-log resume — the last fact is discarded and hydration still succeeds', () => {
  const dir = tmpDir('babel-resume-replay-torn-');
  try {
    const path = writeConversationLog(dir);
    // Simulate a crash mid-append: a partial, unparsable final line.
    appendFileSync(path, '{"recordVersion":1,"parent_fact_id":"","fact":{"schemaVer', 'utf-8');

    const result = resumeReplayFromLog(path);
    assert.ok(result.ok);
    assert.equal(result.tornTail, true);
    assert.equal(result.discarded, 1);
    // Hydration is identical to the log without the torn tail.
    const cleanDir = tmpDir('babel-resume-replay-clean-');
    try {
      const cleanPath = writeConversationLog(cleanDir);
      const clean = resumeReplayFromLog(cleanPath);
      assert.ok(clean.ok);
      assert.deepEqual(result.state, clean.state);
      assert.equal(result.state.stateHash, clean.state.stateHash);
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A4: absent and non-monotonic logs fail closed without fabricating state', () => {
  const dir = tmpDir('babel-resume-replay-absent-');
  try {
    const absent = resumeReplayFromLog(join(dir, RUNTIME_EVENT_LOG_FILENAME));
    assert.deepEqual(absent, {
      ok: false,
      path: join(dir, RUNTIME_EVENT_LOG_FILENAME),
      reason: 'absent',
      detail: absent.ok ? '' : absent.detail,
    });

    // Non-monotonic history: two facts sharing one cursor position fail the
    // A2 replay check rather than being silently collapsed.
    const logDir = tmpDir('babel-resume-replay-bad-');
    try {
      const path = join(logDir, RUNTIME_EVENT_LOG_FILENAME);
      const line = (seq: number, id: string): string =>
        `${JSON.stringify({
          recordVersion: 1,
          parent_fact_id: '',
          fact: fact({ sequence: seq, id }),
        })}\n`;
      writeFileSync(path, line(1, 'a') + line(1, 'b'), 'utf-8');
      const broken = resumeReplayFromLog(path);
      assert.equal(broken.ok, false);
      if (!broken.ok) assert.equal(broken.reason, 'non_monotonic');
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P11 capsule fencing ─────────────────────────────────────────────────────

function capsuleFixture(overrides: Partial<ContextCheckpointV1> = {}): ContextCheckpointV1 {
  return {
    schema_version: 1,
    checkpointId: 'checkpoint-1',
    threadId: 'thread-1',
    sessionId: 'session-1',
    turnId: null,
    contextEpoch: 'epoch-1',
    generation: 1,
    owner: { threadId: 'thread-1', generation: 1, token: 'token-1' },
    preparedAt: '2026-10-10T00:00:00.000Z',
    taskContractReference: null,
    workingStateSnapshot: { state: null, provenance: 'mixed', authoritative: false },
    workspace: {
      current_snapshot_revision: 'rev-1',
      capture_complete: true,
      coverage_ref: null,
      capture_provenance: 'current_capture',
      capture_epoch: 'epoch-1',
    },
    receipts: [
      { receipt_id: 'receipt-a', identity: 'test', scope: 'full_suite', stale: false, bound_revision: 'rev-1' },
      { receipt_id: 'receipt-stale', identity: 'test', scope: 'smoke', stale: true, bound_revision: 'rev-0' },
    ],
    budget: null,
    pending: [{ handle_id: 'handle-1', kind: 'operation', state: 'indeterminate' }],
    route: null,
    population: {
      schema_version: 1,
      status: 'populated',
      rows: [],
      errors: [],
      workspace_revision_current: true,
      workspace_matches_verifier_revision: false,
      installation_blocked_on: [],
      observation_manifest: [],
      install_authorized: true,
    },
    observation_manifest: [],
    observation_manifest_digest: 'digest',
    checkpoint_digest: 'digest',
    ...overrides,
  } as ContextCheckpointV1;
}

test('A4: capsule with proven installed lineage is ready; stale receipts appear as gaps', () => {
  const capsule = capsuleFixture({
    installed_lineage: {
      checkpoint_id: 'checkpoint-1',
      compaction_event_id: null,
      compaction_commit_event_id: null,
      compaction_digest: null,
      thread_event_boundary_seq: null,
    },
  });
  const context = resumeCapsuleContext(capsule);
  assert.equal(context.status, 'ready');
  if (context.status !== 'ready') return;
  assert.equal(context.checkpointId, 'checkpoint-1');
  assert.equal(context.contextEpoch, 'epoch-1');
  const gapKinds = context.gaps.map((gap) => gap.kind);
  assert.ok(gapKinds.includes('stale_receipt'));
  assert.ok(gapKinds.includes('pending_operation'));
  const stale = context.gaps.find((gap) => gap.kind === 'stale_receipt');
  assert.equal(stale?.ref, 'receipt-stale');
});

test('A4: capsule without an installed lineage is blocked, never promoted', () => {
  const context = resumeCapsuleContext(capsuleFixture());
  assert.equal(context.status, 'blocked');
  if (context.status !== 'blocked') return;
  assert.deepEqual([...context.reasons], ['lineage_missing']);
});

// ─── P06 recovery classification ─────────────────────────────────────────────

test('A4: indeterminate effects surface through P06 with automatic resume disabled', () => {
  const dir = tmpDir('babel-resume-replay-p06-');
  try {
    const path = writeConversationLog(dir);
    const result = resumeReplayFromLog(path);
    assert.ok(result.ok);
    const restore = result.restore;
    assert.equal(restore.automaticResume, false);
    const indeterminate = restore.operations.find((op) => op.operationId === 'op-b');
    assert.ok(indeterminate);
    assert.equal(indeterminate.state, 'indeterminate');
    assert.equal(indeterminate.action, 'operator_reconciliation_required');
    assert.ok(indeterminate.reasons.includes(RESTORE_REASONS.EVIDENCE_INCOMPLETE));
    assert.ok(
      indeterminate.reasons.some((reason) => reason.startsWith('operation_indeterminate:')),
    );
    assert.equal(restore.operatorActionRequired, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Run-dir discovery and fallback flag ─────────────────────────────────────

test('A4: findRuntimeEventLogInRunDir locates the log and fails closed when absent', () => {
  const dir = tmpDir('babel-resume-replay-find-');
  try {
    assert.equal(findRuntimeEventLogInRunDir(dir), null);
    const path = writeConversationLog(dir);
    assert.equal(findRuntimeEventLogInRunDir(dir), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A4: heuristic fallback retention is flag-guarded and defaults to enabled', () => {
  const previous = process.env[RESUME_HEURISTIC_FALLBACK_FLAG];
  try {
    delete process.env[RESUME_HEURISTIC_FALLBACK_FLAG];
    assert.equal(resumeHeuristicFallbackEnabled(), true);
    process.env[RESUME_HEURISTIC_FALLBACK_FLAG] = 'on';
    assert.equal(resumeHeuristicFallbackEnabled(), true);
    process.env[RESUME_HEURISTIC_FALLBACK_FLAG] = 'off';
    assert.equal(resumeHeuristicFallbackEnabled(), false);
  } finally {
    if (previous === undefined) {
      delete process.env[RESUME_HEURISTIC_FALLBACK_FLAG];
    } else {
      process.env[RESUME_HEURISTIC_FALLBACK_FLAG] = previous;
    }
  }
});

// ─── resumeExecution integration (replay-first) ─────────────────────────────

test('A4: resumeExecution attaches replay-first evidence for a run with a log', async () => {
  const runsDir = tmpDir('babel-resume-replay-runs-');
  const runDir = join(runsDir, 'run-1');
  mkdirSync(runDir, { recursive: true });
  try {
    writeConversationLog(runDir);
    // Terminal + execution reports make the legacy heuristic classify the run;
    // the replay evidence rides alongside either way.
    writeFileSync(
      join(runDir, 'terminal_status_summary.json'),
      `${JSON.stringify({ status: 'FAILED', failed_command: 'npm test' }, null, 2)}\n`,
      'utf-8',
    );
    writeFileSync(
      join(runDir, '04_execution_report.json'),
      `${JSON.stringify({ status: 'FAILED' }, null, 2)}\n`,
      'utf-8',
    );

    const result = await resumeExecution({ run: runDir });
    assert.ok(result.replay);
    assert.equal(result.replay.source, 'event_log');
    assert.equal(result.replay.automatic_resume, false);
    assert.equal(result.replay.torn_tail, false);
    assert.equal(result.replay.discarded_facts, 0);
    assert.ok(result.replay.state_hash.length > 0);
    assert.deepEqual(result.replay.checkpoints, ['checkpoint-1']);
    assert.deepEqual(result.replay.indeterminate_operations, ['op-b']);
    assert.equal(result.replay.operator_action_required, true);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('A4: fallback disabled + no replayable log fails closed with the flag reason', async () => {
  const previous = process.env[RESUME_HEURISTIC_FALLBACK_FLAG];
  process.env[RESUME_HEURISTIC_FALLBACK_FLAG] = 'off';
  const runsDir = tmpDir('babel-resume-replay-nofallback-');
  const runDir = join(runsDir, 'run-1');
  mkdirSync(runDir, { recursive: true });
  try {
    const result = await resumeExecution({ run: runDir });
    assert.equal(result.status, 'RESUME_NOT_RESUMABLE');
    assert.equal(result.replay, null);
    assert.ok(result.reason.includes(RESUME_HEURISTIC_FALLBACK_FLAG));
  } finally {
    if (previous === undefined) {
      delete process.env[RESUME_HEURISTIC_FALLBACK_FLAG];
    } else {
      process.env[RESUME_HEURISTIC_FALLBACK_FLAG] = previous;
    }
    rmSync(runsDir, { recursive: true, force: true });
  }
});
