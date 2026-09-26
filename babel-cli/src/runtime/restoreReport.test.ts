/**
 * P06 — restore report contract conformance (pure).
 *
 * Verifies the recovery classification, owner handoff, checkpoint cursor, bounds
 * and the compatibility boundary that automatic resume is disabled and unknown
 * evidence never becomes a success.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { OwnerRecordV1 } from './admissionContracts.js';
import { completeCompleteness, incompleteCompleteness } from './admissionContracts.js';
import {
  buildRestoreReport,
  classifyOperation,
  evaluateOwnerHandoff,
  RESTORE_REASONS,
  RESTORE_REPORT_VERSION,
  type BuildRestoreReportInput,
  type RestoreOperationEvidence,
} from './restoreReport.js';

function operation(overrides: Partial<RestoreOperationEvidence> = {}): RestoreOperationEvidence {
  return {
    operationId: 'op-1',
    commandId: 'cmd-1',
    admissionId: 'adm-1',
    effectClass: 'read_only',
    admissionState: 'claimed',
    outboxState: 'intent',
    effectState: 'none',
    evidenceRefs: ['adm-1'],
    ...overrides,
  };
}

function report(overrides: Partial<BuildRestoreReportInput> = {}) {
  const fixed = (): Date => new Date('2026-09-19T00:00:00.000Z');
  return buildRestoreReport({
    threadId: 'thread-1',
    interruptionClass: 'process_restart',
    now: fixed,
    ...overrides,
  });
}

test('P06: restore report is versioned and automatic resume is disabled by default', () => {
  const built = report();
  assert.equal(built.schemaVersion, RESTORE_REPORT_VERSION);
  assert.equal(built.automaticResume, false);
  assert.equal(built.interruptionClass, 'process_restart');
  assert.equal(built.generatedAt, '2026-09-19T00:00:00.000Z');
  assert.deepEqual(built.operations, []);
  assert.equal(built.degraded, false);
  assert.equal(built.cursor.complete, false);
  assert.deepEqual(built.cursor.reasons, [RESTORE_REASONS.NO_CHECKPOINT]);
});

test('P06: read-only and idempotent work recovers according to its adapter', () => {
  const readOnly = classifyOperation(operation({ effectClass: 'read_only' }));
  assert.equal(readOnly.recoveryClass, 'read_only');
  assert.equal(readOnly.action, 'retry_safe');
  assert.equal(readOnly.automaticRetryAllowed, true);
  assert.equal(readOnly.state, 'not_started');

  const idempotent = classifyOperation(
    operation({
      effectClass: 'idempotent',
      effectState: 'intent',
      reconciliation: 'retry_reconcilable',
      outboxState: 'intent',
    }),
  );
  assert.equal(idempotent.recoveryClass, 'idempotent');
  assert.equal(idempotent.action, 'retry_safe');
  assert.equal(idempotent.automaticRetryAllowed, true);
  assert.equal(idempotent.state, 'interrupted');
});

test('P06: a reconcilable mutation reconciles the workspace before retry and is never automatic', () => {
  const classification = classifyOperation(
    operation({
      effectClass: 'reconcilable_mutation',
      effectState: 'intent',
      reconciliation: 'retry_reconcilable',
    }),
  );
  assert.equal(classification.recoveryClass, 'reconcilable_mutation');
  assert.equal(classification.action, 'reconcile_workspace_before_retry');
  assert.equal(classification.automaticRetryAllowed, false);
});

test('P06: a workspace conflict becomes indeterminate and requires operator reconciliation', () => {
  const classification = classifyOperation(
    operation({
      effectClass: 'reconcilable_mutation',
      effectState: 'intent',
      reconciliation: 'workspace_conflict',
    }),
  );
  assert.equal(classification.state, 'indeterminate');
  assert.equal(classification.action, 'operator_reconciliation_required');
  assert.equal(classification.automaticRetryAllowed, false);
  assert.deepEqual(classification.reasons, [RESTORE_REASONS.WORKSPACE_CONFLICT]);
});

test('P06: an ambiguous mutating or external effect is never retried blindly', () => {
  for (const effectClass of ['non_idempotent_local_effect', 'external_side_effect'] as const) {
    const classification = classifyOperation(
      operation({ effectClass, effectState: 'intent', reconciliation: 'manual_review' }),
    );
    assert.equal(classification.action, 'operator_reconciliation_required');
    assert.equal(classification.automaticRetryAllowed, false);
    assert.ok(classification.reasons.includes(RESTORE_REASONS.AMBIGUOUS_NOT_RETRIED));
  }
});

test('P06: an untracked unknown effect stays unknown', () => {
  const classification = classifyOperation({
    operationId: 'op-1',
    effectClass: 'external_side_effect',
    unknownReasons: ['no_evidence'],
  });
  assert.equal(classification.state, 'indeterminate');
  assert.equal(classification.action, 'operator_reconciliation_required');
  assert.equal(classification.automaticRetryAllowed, false);
});

test('P06: an unsettled process tree blocks continuation of a local subprocess effect', () => {
  const classification = classifyOperation(
    operation({
      effectClass: 'non_idempotent_local_effect',
      effectState: 'intent',
      reconciliation: 'manual_review',
      processTreeSettled: false,
    }),
  );
  assert.equal(classification.action, 'await_process_tree_settle');
  assert.equal(classification.automaticRetryAllowed, false);
  assert.ok(classification.reasons.includes(RESTORE_REASONS.PROCESS_TREE_UNSETTLED));
});

test('P06: recovered post-image completes without a fabricated receipt', () => {
  const classification = classifyOperation(
    operation({
      effectClass: 'reconcilable_mutation',
      effectState: 'intent',
      reconciliation: 'recovered_complete',
    }),
  );
  assert.equal(classification.state, 'completed');
  assert.equal(classification.action, 'none_complete');
  assert.deepEqual(classification.reasons, [RESTORE_REASONS.EFFECT_APPLIED_WITHOUT_RECEIPT]);

  const built = report({
    operations: [
      operation({
        effectClass: 'reconcilable_mutation',
        effectState: 'intent',
        reconciliation: 'recovered_complete',
      }),
    ],
  });
  assert.equal(built.operatorActionRequired, true);
  assert.equal(built.terminal, undefined);
});

test('P06: explicit terminal commit with complete evidence is authoritative', () => {
  const classification = classifyOperation(
    operation({
      effectClass: 'reconcilable_mutation',
      admissionState: 'settled',
      outboxState: 'committed',
      effectState: 'completed',
      completeness: completeCompleteness(1),
    }),
  );
  assert.equal(classification.state, 'completed');
  assert.equal(classification.action, 'none_complete');
  assert.deepEqual(classification.reasons, [RESTORE_REASONS.TERMINAL_COMMITTED]);

  const built = report({
    operations: [
      operation({
        effectClass: 'reconcilable_mutation',
        admissionState: 'settled',
        outboxState: 'committed',
        effectState: 'completed',
        completeness: completeCompleteness(1),
      }),
    ],
    terminal: {
      outcome: 'UNVERIFIED_PATCH',
      status: 'terminal',
      evidenceRefs: ['adm-1'],
      authoritative: false,
    },
  });
  assert.equal(built.terminal?.outcome, 'UNVERIFIED_PATCH');
  assert.equal(built.operatorActionRequired, false);
});

test('P06: C1 — an incomplete admission cannot claim authoritative terminal completion', () => {
  const incomplete = incompleteCompleteness({
    reasons: ['evidence_refs_truncated'],
    admittedCount: 5,
    droppedCount: 3,
    evidenceRefsDropped: 2,
    truncated: true,
  });
  const evidence = operation({
    effectClass: 'reconcilable_mutation',
    admissionState: 'settled',
    outboxState: 'committed',
    effectState: 'completed',
    completeness: incomplete,
  });

  const classification = classifyOperation(evidence);
  assert.equal(classification.state, 'indeterminate');
  assert.equal(classification.action, 'operator_reconciliation_required');
  assert.equal(classification.automaticRetryAllowed, false);
  assert.deepEqual(classification.reasons, [RESTORE_REASONS.EVIDENCE_INCOMPLETE]);

  const built = report({ operations: [evidence] });
  assert.equal(built.operatorActionRequired, true);
  assert.ok(built.degraded);
  assert.ok(built.degradedReasons.includes(RESTORE_REASONS.EVIDENCE_INCOMPLETE));
});

test('P06 control: an incomplete admission must NOT be authoritative (unsafe assertion fails)', () => {
  const evidence = operation({
    effectClass: 'reconcilable_mutation',
    admissionState: 'settled',
    outboxState: 'committed',
    effectState: 'completed',
    completeness: incompleteCompleteness({
      reasons: ['conflicting_duplicate_fact'],
      admittedCount: 0,
      droppedCount: 1,
    }),
  });
  const classification = classifyOperation(evidence);
  // CONTROL: the old (unsafe) behavior claimed `restore_terminal_committed`.
  assert.throws(() => assert.deepEqual(classification.reasons, [RESTORE_REASONS.TERMINAL_COMMITTED]));
  // CANDIDATE: it is downgraded and requires an operator.
  assert.deepEqual(classification.reasons, [RESTORE_REASONS.EVIDENCE_INCOMPLETE]);
  assert.equal(classification.action, 'operator_reconciliation_required');
});

test('P06: an aborted admission is terminal-not-executed, not a retry', () => {
  const classification = classifyOperation(
    operation({ effectClass: 'reconcilable_mutation', admissionState: 'aborted', effectState: 'none' }),
  );
  assert.equal(classification.state, 'not_started');
  assert.equal(classification.action, 'none_complete');
  assert.deepEqual(classification.reasons, [RESTORE_REASONS.ADMISSION_ABORTED]);
});

test('P06: owner handoff fences stale generations and tokens', () => {
  const current: OwnerRecordV1 = { threadId: 'thread-1', generation: 5, token: 'token-5' };
  assert.equal(evaluateOwnerHandoff({ current, requesting: { generation: 4, token: 'x' } }).staleRequester, true);
  assert.equal(evaluateOwnerHandoff({ current, requesting: { generation: 4, token: 'x' } }).granted, false);
  assert.equal(
    evaluateOwnerHandoff({ current, requesting: { generation: 5, token: 'other' } }).staleRequester,
    true,
  );
  assert.equal(evaluateOwnerHandoff({ current, requesting: { generation: 5, token: 'token-5' } }).reason, 'same_owner');
  assert.equal(evaluateOwnerHandoff({ current, requesting: { generation: 6, token: 'token-6' } }).reason, 'owner_handoff');
  assert.equal(evaluateOwnerHandoff({ current, requesting: { generation: 6, token: 'token-6' } }).granted, true);
});

test('P06: TUI can attach read-only without owning the runtime', () => {
  const current: OwnerRecordV1 = { threadId: 'thread-1', generation: 5, token: 'token-5' };
  const built = report({
    attachMode: 'observe',
    ownerCurrent: current,
    ownerRequesting: { generation: 1, token: 'stale' },
  });
  assert.equal(built.owner.readOnly, true);
  assert.equal(built.owner.granted, true);
  assert.equal(built.owner.staleRequester, false);
  assert.equal(built.owner.toGeneration, 5);
  assert.equal(built.owner.reason, RESTORE_REASONS.READ_ONLY_ATTACH);
});

test('P06: a stale requesting owner degrades the report and cannot continue', () => {
  const built = report({
    ownerCurrent: { threadId: 'thread-1', generation: 5, token: 'token-5' },
    ownerRequesting: { generation: 3, token: 'old' },
    continuationRequested: true,
    budget: { turnsRemaining: 4, tokensRemaining: null, repairAttemptsRemaining: null, infraRetriesRemaining: null },
    cursor: { journal: 'admission', position: 1 },
    operations: [operation({ effectClass: 'read_only' })],
  });
  assert.equal(built.owner.granted, false);
  assert.equal(built.owner.staleRequester, true);
  assert.ok(built.degradedReasons.includes(RESTORE_REASONS.STALE_OWNER));
  assert.ok(built.missingAuthorities.includes('owner_lease'));
  assert.equal(built.operations[0]?.action, 'blocked_missing_authority');
  assert.equal(built.continuationBlocked, true);
});

test('P06: truncated or corrupt history is explicit and offers history only', () => {
  const truncated = report({
    history: { readable: true, truncated: true, corrupt: false, reasons: ['torn_tail'] },
    cursor: { journal: 'admission', position: 3 },
    operations: [operation({ effectClass: 'read_only' })],
  });
  assert.equal(truncated.historyReadable, true);
  assert.equal(truncated.cursor.complete, false);
  assert.ok(truncated.cursor.reasons.includes(RESTORE_REASONS.CURSOR_INCOMPLETE));
  assert.equal(truncated.operations[0]?.action, 'history_only');
  assert.equal(truncated.operations[0]?.automaticRetryAllowed, false);
  assert.ok(truncated.degraded);
  assert.ok(truncated.degradedReasons.includes('torn_tail'));

  const corrupt = report({
    history: { readable: false, truncated: false, corrupt: true, reasons: ['bad_json'] },
    operations: [operation({ effectClass: 'idempotent', effectState: 'intent' })],
  });
  assert.equal(corrupt.historyReadable, false);
  assert.ok(corrupt.missingAuthorities.includes('history'));
  assert.equal(corrupt.operations[0]?.action, 'history_only');
  assert.equal(corrupt.continuationBlocked, false);
});

test('P06: a missing task budget blocks continuation', () => {
  const built = report({
    continuationRequested: true,
    budget: null,
    cursor: { journal: 'admission', position: 1 },
    operations: [operation({ effectClass: 'read_only' })],
  });
  assert.equal(built.continuationBlocked, true);
  assert.equal(built.continuationBlockedReason, RESTORE_REASONS.BUDGET_MISSING);
  assert.ok(built.missingAuthorities.includes('task_budget'));
  assert.equal(built.operations[0]?.action, 'blocked_missing_budget');
});

test('P06: an exhausted budget blocks continuation', () => {
  const built = report({
    continuationRequested: true,
    budget: { turnsRemaining: 0, tokensRemaining: 100, repairAttemptsRemaining: null, infraRetriesRemaining: null },
    cursor: { journal: 'admission', position: 1 },
    operations: [operation({ effectClass: 'idempotent', effectState: 'intent' })],
  });
  assert.equal(built.continuationBlocked, true);
  assert.equal(built.continuationBlockedReason, RESTORE_REASONS.BUDGET_EXHAUSTED);
  assert.equal(built.operations[0]?.action, 'blocked_missing_budget');
});

test('P06: an entirely-unknown (all-null) budget blocks continuation', () => {
  const built = report({
    continuationRequested: true,
    budget: { turnsRemaining: null, tokensRemaining: null, repairAttemptsRemaining: null, infraRetriesRemaining: null },
    cursor: { journal: 'admission', position: 1 },
    operations: [operation({ effectClass: 'idempotent', effectState: 'intent' })],
  });
  assert.equal(built.continuationBlocked, true);
  assert.equal(built.continuationBlockedReason, RESTORE_REASONS.BUDGET_MISSING);
  assert.ok(built.missingAuthorities.includes('task_budget'));
  assert.equal(built.operations[0]?.action, 'blocked_missing_budget');
});

test('P06: restore report is bounded and deterministically ordered', () => {
  const operations = [
    operation({ operationId: 'op-c' }),
    operation({ operationId: 'op-a' }),
    operation({ operationId: 'op-b', effectClass: 'external_side_effect', effectState: 'intent' }),
  ];
  const built = report({ operations, maxOperations: 2 });
  assert.equal(built.operations.length, 2);
  assert.equal(built.bounded.truncated, true);
  assert.ok(built.degradedReasons.includes(RESTORE_REASONS.OPERATIONS_TRUNCATED));
  assert.deepEqual(
    built.operations.map((op) => op.operationId),
    ['op-a', 'op-b'],
  );

  const first = report({ operations });
  const second = report({ operations: [...operations].reverse() });
  assert.deepEqual(first, second);
});

test('P06: process-tree settle evidence is carried without being invented', () => {
  const built = report({
    processTree: { settled: false, observedPids: [4242], method: 'unknown', reasons: ['pid_reuse_possible'] },
  });
  assert.equal(built.processTree?.settled, false);
  assert.deepEqual(built.processTree?.observedPids, [4242]);
});
