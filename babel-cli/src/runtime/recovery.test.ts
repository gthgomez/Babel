/**
 * P06 — recovery orchestration conformance over the real P05 admission store.
 *
 * These fixtures exercise the real SQLite transaction boundary and the real
 * effect ledger. Crash points use the P05 test-only fault hook (no production
 * fault seam): a crash is a thrown error at the committed boundary followed by a
 * fresh store open, exactly what a restarted process sees.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openAdmissionStore, type AdmissionStore, type AdmissionStoreOptions } from './admission.js';
import type { CommandDigestInput } from './admissionContracts.js';
import { ADMISSION_FAULT_HOOK, type AdmissionFaultPoint } from './admissionTestHooks.js';
import { recordEffectIntent } from '../executor/effectLedger.js';
import { classifyInterruption, restoreFromCommittedState, type RestoreInput } from './recovery.js';
import { RESTORE_REASONS } from './restoreReport.js';

interface Fixture {
  readonly root: string;
  readonly runDir: string;
  cleanup(): void;
}

type TestStoreOptions = Partial<Omit<AdmissionStoreOptions, 'authorizedRoot' | 'runDir'>>;

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'babel-recovery-root-'));
  const runDir = join(root, 'runs', 'run-1');
  return {
    root,
    runDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function openStore(fixture: Fixture, options: TestStoreOptions = {}): AdmissionStore {
  const result = openAdmissionStore({ authorizedRoot: fixture.root, runDir: fixture.runDir, ...options });
  if (!result.ok) throw new Error(`open failed: ${result.reasonCode}: ${result.detail}`);
  return result.store;
}

function faultAt(point: AdmissionFaultPoint): TestStoreOptions {
  return {
    [ADMISSION_FAULT_HOOK]: (hit: AdmissionFaultPoint) => {
      if (hit === point) throw new Error(`injected crash at ${point}`);
    },
  };
}

function commandInput(overrides: Partial<CommandDigestInput> = {}): CommandDigestInput {
  return {
    threadId: 'thread-1',
    taskId: 'task-1',
    commandId: 'cmd-1',
    mode: 'chat',
    resolvedOperationPolicy: { mutation: 'normal' },
    taskShapeClass: 'edit',
    targetRoot: '/work',
    offeredToolSchemaVersion: 'tools-v1',
    contextSnapshotId: 'ctx-1',
    payload: { command: 'write', args: { path: 'a.txt' } },
    ...overrides,
  };
}

function restore(fixture: Fixture, overrides: Partial<RestoreInput> = {}) {
  return restoreFromCommittedState({
    authorizedRoot: fixture.root,
    runDir: fixture.runDir,
    threadId: 'thread-1',
    interruptionClass: 'process_restart',
    ...overrides,
  });
}

test('P06: crash after admission before effect is recoverable and never completes itself', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture, faultAt('after_admission_commit'));
    assert.throws(() =>
      store.admitCommand({
        digestInput: commandInput(),
        ownerGeneration: 1,
        ownerToken: 'token-1',
        effectClass: 'reconcilable_mutation',
        operationId: 'op-1',
        preImageHashes: { 'a.txt': 'before' },
        postImageHashes: { 'a.txt': 'after' },
      }),
    );
    store.close();

    const session = restore(fixture, { currentImageHashes: { 'a.txt': 'before' } });
    try {
      assert.equal(session.report.automaticResume, false);
      assert.equal(session.report.operations.length, 1);
      const operation = session.report.operations[0]!;
      assert.equal(operation.effectClass, 'reconcilable_mutation');
      assert.equal(operation.state, 'interrupted');
      assert.equal(operation.action, 'reconcile_workspace_before_retry');
      assert.equal(operation.automaticRetryAllowed, false);
      assert.equal(session.report.terminal, undefined);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: crash before effect (no ledger) recovers read-only work per its adapter', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-read' }),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-read',
    });
    store.close();
    assert.equal(existsSync(join(fixture.runDir, 'effect-ledger.jsonl')), false);

    const session = restore(fixture, { currentImageHashes: {} });
    try {
      const operation = session.report.operations[0]!;
      assert.equal(operation.effectClass, 'read_only');
      assert.equal(operation.action, 'retry_safe');
      assert.equal(operation.automaticRetryAllowed, true);
      assert.equal(session.report.operatorActionRequired, false);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: crash during effect with a partial write is a workspace conflict, not a blind retry', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'reconcilable_mutation',
      operationId: 'op-1',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    });
    store.close();

    const session = restore(fixture, { currentImageHashes: { 'a.txt': 'partial' } });
    try {
      const operation = session.report.operations[0]!;
      assert.equal(operation.state, 'indeterminate');
      assert.equal(operation.action, 'operator_reconciliation_required');
      assert.equal(operation.automaticRetryAllowed, false);
      assert.ok(operation.reasons.includes(RESTORE_REASONS.WORKSPACE_CONFLICT));
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: crash after effect before receipt recognizes completion without fabricating a receipt', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'reconcilable_mutation',
      operationId: 'op-1',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    });
    store.close();

    const session = restore(fixture, { currentImageHashes: { 'a.txt': 'after' } });
    try {
      const operation = session.report.operations[0]!;
      assert.equal(operation.state, 'completed');
      assert.equal(operation.action, 'none_complete');
      assert.ok(operation.reasons.includes(RESTORE_REASONS.EFFECT_APPLIED_WITHOUT_RECEIPT));
      assert.equal(session.report.terminal, undefined);
      assert.equal(session.report.operatorActionRequired, true);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: crash during verifier does not fabricate verified completion', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput({ commandId: 'cmd-verify' }),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'idempotent',
      operationId: 'op-verify',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    });
    store.close();

    const session = restore(fixture, { currentImageHashes: { 'a.txt': 'after' } });
    try {
      assert.equal(session.report.terminal, undefined);
      const operation = session.report.operations[0]!;
      assert.equal(operation.state, 'completed');
      assert.equal(operation.automaticRetryAllowed, false);
      assert.ok(!operation.reasons.includes(RESTORE_REASONS.TERMINAL_COMMITTED));
      assert.equal(session.report.operations.some((op) => op.state === 'completed' && op.automaticRetryAllowed), false);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: crash after terminal commit is the authoritative complete state', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'reconcilable_mutation',
      operationId: 'op-1',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    });
    const settled = store.settleAdmission({
      threadId: 'thread-1',
      commandId: 'cmd-1',
      ownerGeneration: 1,
      ownerToken: 'token-1',
      state: 'settled',
      outcome: { status: 'ok' },
      outbox: { state: 'committed', postImageHashes: { 'a.txt': 'after' } },
    });
    assert.equal(settled.settled, true);
    store.close();

    const session = restore(fixture, { currentImageHashes: { 'a.txt': 'after' } });
    try {
      const operation = session.report.operations[0]!;
      assert.equal(operation.state, 'completed');
      assert.equal(operation.action, 'none_complete');
      assert.deepEqual(operation.reasons, [RESTORE_REASONS.TERMINAL_COMMITTED]);
      assert.equal(session.report.operatorActionRequired, false);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: an interrupted effect ledger record is surfaced and never retried blindly', () => {
  const fixture = makeFixture();
  try {
    recordEffectIntent({
      runDir: fixture.runDir,
      sessionId: 'session-1',
      mutationBatchId: 'batch-1',
      effectClass: 'external_side_effect',
      toolName: 'mcp_request',
      targetPaths: [],
      preImageHashes: {},
    });
    appendFileSync(join(fixture.runDir, 'effect-ledger.jsonl'), '{"schemaVersion":1');

    const session = restore(fixture);
    try {
      assert.equal(session.report.operations.length, 1);
      const operation = session.report.operations[0]!;
      assert.equal(operation.effectClass, 'external_side_effect');
      assert.equal(operation.action, 'operator_reconciliation_required');
      assert.equal(operation.automaticRetryAllowed, false);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: truncated or corrupt history is explicit in the recovery report', () => {
  const fixture = makeFixture();
  try {
    const session = restore(fixture, {
      history: { readable: false, truncated: false, corrupt: true, reasons: ['bad_json_line'] },
      cursor: { journal: 'admission', position: 4, complete: true, reasons: [] },
    });
    try {
      assert.equal(session.report.historyReadable, false);
      assert.ok(session.report.missingAuthorities.includes('history'));
      assert.ok(session.report.degraded);
      assert.equal(session.report.cursor.complete, false);
      assert.ok(session.report.degradedReasons.includes('bad_json_line'));
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: an unsettled process tree blocks a subprocess continuation', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'non_idempotent_local_effect',
      operationId: 'op-shell',
    });
    store.close();

    const session = restore(fixture, {
      processTree: { settled: false, observedPids: [4242], method: 'unknown', reasons: ['pid_reuse_possible'] },
    });
    try {
      const operation = session.report.operations[0]!;
      assert.equal(operation.action, 'await_process_tree_settle');
      assert.equal(operation.automaticRetryAllowed, false);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: a missing task budget blocks continuation', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'idempotent',
      operationId: 'op-1',
    });
    store.close();

    const session = restore(fixture, { continuationRequested: true, budget: null });
    try {
      assert.equal(session.report.continuationBlocked, true);
      assert.equal(session.report.continuationBlockedReason, RESTORE_REASONS.BUDGET_MISSING);
      assert.ok(session.report.missingAuthorities.includes('task_budget'));
      assert.equal(session.report.operations[0]?.action, 'blocked_missing_budget');
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: a stale owner cannot publish terminal state', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 5,
      ownerToken: 'token-5',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    store.close();

    const session = restore(fixture, { ownerRequesting: { generation: 3, token: 'old' } });
    try {
      assert.equal(session.report.owner.staleRequester, true);
      assert.equal(session.report.owner.granted, false);
      const refused = session.settle({
        threadId: 'thread-1',
        commandId: 'cmd-1',
        ownerGeneration: 3,
        ownerToken: 'old',
        state: 'settled',
        outcome: { forged: true },
      });
      assert.equal(refused.settled, false);
      if (!refused.settled) assert.equal(refused.reasonCode, 'ADMISSION_STALE_OWNER');

      const store2 = openStore(fixture);
      try {
        assert.equal(store2.readAdmission('thread-1', 'cmd-1')?.state, 'claimed');
      } finally {
        store2.close();
      }
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: the current owner can settle a recovered operation', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 2,
      ownerToken: 'token-2',
      effectClass: 'idempotent',
      operationId: 'op-1',
    });
    store.close();

    const session = restore(fixture, { ownerRequesting: { generation: 2, token: 'token-2' } });
    try {
      const settled = session.settle({
        threadId: 'thread-1',
        commandId: 'cmd-1',
        ownerGeneration: 2,
        ownerToken: 'token-2',
        state: 'settled',
        outcome: { status: 'ok' },
        outbox: { state: 'committed' },
      });
      assert.equal(settled.settled, true);
      if (settled.settled) assert.equal(settled.replayed, false);
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: TUI can attach read-only without owning the runtime', () => {
  const fixture = makeFixture();
  try {
    const store = openStore(fixture);
    store.admitCommand({
      digestInput: commandInput(),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'read_only',
      operationId: 'op-1',
    });
    store.close();

    const session = restore(fixture, { attachMode: 'observe' });
    try {
      assert.equal(session.report.owner.readOnly, true);
      assert.equal(session.report.owner.granted, true);
      assert.equal(session.report.owner.staleRequester, false);
      assert.equal(session.report.owner.toGeneration, 1);
    } finally {
      session.close();
    }

    const verify = openStore(fixture);
    try {
      const owner = verify.readOwner('thread-1');
      assert.equal(owner?.generation, 1);
      assert.equal(owner?.token, 'token-1');
      assert.equal(owner?.settledAt, undefined);
    } finally {
      verify.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('P06: interruption classes are distinguished explicitly', () => {
  assert.equal(
    classifyInterruption({ processStarted: true, ownerLeaseActive: false, hasUnfinishedEffect: true }),
    'process_restart',
  );
  assert.equal(
    classifyInterruption({ processStarted: false, ownerLeaseActive: true, hasUnfinishedEffect: true }),
    'unfinished_tool_continuation',
  );
  assert.equal(
    classifyInterruption({ processStarted: false, ownerLeaseActive: true, hasUnfinishedEffect: false }),
    'client_reconnect',
  );
});

test('P06: an unavailable store fails closed and records the missing authority', () => {
  const fixture = makeFixture();
  try {
    const session = restoreFromCommittedState({
      authorizedRoot: fixture.root,
      runDir: join(fixture.root, '..', 'escaped-run'),
      threadId: 'thread-1',
      interruptionClass: 'process_restart',
    });
    try {
      assert.equal(session.store, null);
      assert.ok(session.report.missingAuthorities.includes('admission_store'));
      assert.equal(session.report.automaticResume, false);
      const refused = session.settle({
        threadId: 'thread-1',
        commandId: 'cmd-1',
        ownerGeneration: 1,
        ownerToken: 'x',
        state: 'settled',
      });
      assert.equal(refused.settled, false);
      if (!refused.settled) assert.equal(refused.reasonCode, 'ADMISSION_UNAVAILABLE');
    } finally {
      session.close();
    }
  } finally {
    fixture.cleanup();
  }
});
