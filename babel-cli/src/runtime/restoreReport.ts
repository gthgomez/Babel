/**
 * P06 — restore report contracts and pure recovery classification.
 *
 * This module answers "what does the durable record prove, and what may the
 * runtime safely do next?" It is deliberately pure: no SQLite, no filesystem,
 * no clock. `recovery.ts` gathers evidence from the P05 `AdmissionStore` and the
 * existing `effectLedger` and hands it here.
 *
 * Non-negotiable properties:
 *  - automatic resume is **disabled** (`automaticResume: false` always);
 *  - an ambiguous/mutating effect is never retried blindly
 *    (`automaticRetryAllowed` is only ever true for read-only/idempotent work);
 *  - unknown stays unknown: absence of terminal evidence never fabricates a
 *    success or an authority;
 *  - the report is bounded and versioned.
 */

import type { ToolEffectClass } from '../executor/contracts.js';
import type {
  EffectLedgerStatus,
  EffectReconciliationDecision,
} from '../executor/effectLedger.js';
import {
  isAuthoritativeAdmission,
  type AdmissionCompletenessV1,
  type AdmissionState,
  type OutboxState,
  type OwnerRecordV1,
} from './admissionContracts.js';

/** Version of the restore-report contract (independent of the P05 journal schema). */
export const RESTORE_REPORT_VERSION = 1 as const;

/** Upper bound on operations included in one report. */
export const DEFAULT_MAX_RESTORE_OPERATIONS = 256;

/** Upper bound on evidence refs retained per operation. */
export const MAX_RESTORE_EVIDENCE_REFS = 64;

/** Additive, stable restore reason codes. Never reordered/removed once published. */
export const RESTORE_REASONS = {
  NO_CHECKPOINT: 'restore_no_checkpoint',
  HISTORY_TRUNCATED: 'restore_history_truncated',
  HISTORY_CORRUPT: 'restore_history_corrupt',
  HISTORY_UNREADABLE: 'restore_history_unreadable',
  CURSOR_INCOMPLETE: 'restore_cursor_incomplete',
  TERMINAL_COMMITTED: 'restore_terminal_committed',
  EFFECT_APPLIED_WITHOUT_RECEIPT: 'restore_effect_applied_without_receipt',
  ADMISSION_ABORTED: 'restore_admission_aborted',
  ADMISSION_WITHOUT_EFFECT: 'restore_admission_without_effect',
  EFFECT_TERMINAL_FAILURE: 'restore_effect_terminal_failure',
  IDEMPOTENT_RETRY: 'restore_idempotent_retry',
  PREIMAGE_RECONCILABLE: 'restore_preimage_reconcilable',
  WORKSPACE_CONFLICT: 'restore_workspace_conflict',
  AMBIGUOUS_NOT_RETRIED: 'restore_ambiguous_effect_not_retried',
  EVIDENCE_INCOMPLETE: 'restore_evidence_incomplete',
  PROCESS_TREE_UNSETTLED: 'restore_process_tree_unsettled',
  BUDGET_MISSING: 'restore_task_budget_missing',
  BUDGET_EXHAUSTED: 'restore_task_budget_exhausted',
  BUDGET_BLOCKS_CONTINUATION: 'restore_budget_blocks_continuation',
  MISSING_AUTHORITY_BLOCKS_CONTINUATION: 'restore_missing_authority_blocks_continuation',
  OPERATIONS_TRUNCATED: 'restore_operations_truncated',
  READ_ONLY_ATTACH: 'restore_read_only_attach',
  STALE_OWNER: 'restore_stale_owner',
} as const;

export type RestoreReasonCode = (typeof RESTORE_REASONS)[keyof typeof RESTORE_REASONS];

// ─── Interruption / recovery classes ────────────────────────────────────────

/**
 * Why the runtime is being restored. These are distinct on purpose; a client
 * reconnecting must never be treated as a process restart, and neither is proof
 * that an unfinished tool completed.
 */
export type InterruptionClass =
  | 'client_reconnect'
  | 'process_restart'
  | 'unfinished_tool_continuation';

/** Safe handling class for one pending/recovered operation. */
export type OperationRecoveryClass =
  | 'read_only'
  | 'idempotent'
  | 'reconcilable_mutation'
  | 'ambiguous_mutation'
  | 'external_side_effect'
  | 'unknown';

/** Observed state of one operation. `unknown` is a real, reportable outcome. */
export type OperationState =
  | 'completed'
  | 'not_started'
  | 'interrupted'
  | 'indeterminate'
  | 'unknown';

/** The explicit next step. Nothing is inferred silently from a status. */
export type RecoveryAction =
  | 'none_complete'
  | 'retry_safe'
  | 'reconcile_workspace_before_retry'
  | 'await_process_tree_settle'
  | 'operator_reconciliation_required'
  | 'blocked_missing_budget'
  | 'blocked_missing_authority'
  | 'history_only';

/** Authorities/evidence the restore could not establish. Never fabricated. */
export type MissingAuthority =
  | 'admission_store'
  | 'effect_ledger'
  | 'history'
  | 'task_budget'
  | 'task_contract'
  | 'instruction_manifest'
  | 'owner_lease'
  | 'provider_credentials'
  | 'workspace_revision'
  | 'verifier_receipt'
  | 'terminal_evidence';

/** Adapter behaviour for a recovery class. `never` is never auto-retried. */
export interface RecoveryAdapter {
  readonly recoveryClass: OperationRecoveryClass;
  readonly retry: 'safe' | 'reconcile' | 'never';
  readonly automatic: boolean;
}

/** Map a tool effect class to its adapter behaviour. */
export function recoveryAdapterFor(effectClass: ToolEffectClass): RecoveryAdapter {
  switch (effectClass) {
    case 'read_only':
      return { recoveryClass: 'read_only', retry: 'safe', automatic: true };
    case 'idempotent':
      return { recoveryClass: 'idempotent', retry: 'safe', automatic: true };
    case 'reconcilable_mutation':
      return { recoveryClass: 'reconcilable_mutation', retry: 'reconcile', automatic: false };
    case 'non_idempotent_local_effect':
      return { recoveryClass: 'ambiguous_mutation', retry: 'never', automatic: false };
    case 'external_side_effect':
      return { recoveryClass: 'external_side_effect', retry: 'never', automatic: false };
    default:
      return { recoveryClass: 'unknown', retry: 'never', automatic: false };
  }
}

/** Map a tool effect class to its recovery class only. */
export function recoveryClassForEffect(effectClass: ToolEffectClass): OperationRecoveryClass {
  return recoveryAdapterFor(effectClass).recoveryClass;
}

// ─── Checkpoint cursor ───────────────────────────────────────────────────────

export type CheckpointJournal = 'admission' | 'thread' | 'session' | 'effect_ledger';

/**
 * A resume cursor. `complete: false` means a gap/truncation was observed in the
 * backing journal, so a reader may only offer history, not execution.
 */
export interface CheckpointCursor {
  readonly journal: CheckpointJournal;
  readonly position: number;
  readonly digest?: string;
  readonly complete: boolean;
  readonly reasons: readonly string[];
}

/** Whether an action actually attempts to move execution forward. */
export function isExecutableAction(action: RecoveryAction): boolean {
  return (
    action === 'retry_safe' ||
    action === 'reconcile_workspace_before_retry' ||
    action === 'await_process_tree_settle'
  );
}

// ─── Owner handoff ───────────────────────────────────────────────────────────

export interface OwnerHandoffInput {
  readonly current: OwnerRecordV1 | null;
  readonly requesting?: { readonly generation: number; readonly token: string } | null;
  /** A read-only observer (e.g. TUI attach) never acquires ownership. */
  readonly readOnly?: boolean;
}

/**
 * `OwnerHandoff` records whether a caller may become/stay the owner. A read-only
 * attachment is granted observation without ownership; a stale generation/token
 * is never granted ownership, so it cannot publish terminal state.
 */
export interface OwnerHandoff {
  readonly fromGeneration: number | null;
  readonly toGeneration: number;
  readonly granted: boolean;
  readonly staleRequester: boolean;
  readonly readOnly: boolean;
  readonly reason: string;
}

export function evaluateOwnerHandoff(input: OwnerHandoffInput): OwnerHandoff {
  const current = input.current;
  const fromGeneration = current ? current.generation : null;
  if (input.readOnly) {
    return {
      fromGeneration,
      toGeneration: current ? current.generation : 0,
      granted: true,
      staleRequester: false,
      readOnly: true,
      reason: RESTORE_REASONS.READ_ONLY_ATTACH,
    };
  }
  const requesting = input.requesting;
  if (!requesting) {
    return {
      fromGeneration,
      toGeneration: current ? current.generation : 0,
      granted: false,
      staleRequester: false,
      readOnly: false,
      reason: 'no_owner_requested',
    };
  }
  if (!current) {
    return {
      fromGeneration: null,
      toGeneration: requesting.generation,
      granted: true,
      staleRequester: false,
      readOnly: false,
      reason: 'no_existing_owner',
    };
  }
  if (requesting.generation < current.generation) {
    return {
      fromGeneration,
      toGeneration: current.generation,
      granted: false,
      staleRequester: true,
      readOnly: false,
      reason: RESTORE_REASONS.STALE_OWNER,
    };
  }
  if (requesting.generation === current.generation && requesting.token !== current.token) {
    return {
      fromGeneration,
      toGeneration: current.generation,
      granted: false,
      staleRequester: true,
      readOnly: false,
      reason: RESTORE_REASONS.STALE_OWNER,
    };
  }
  if (requesting.generation === current.generation) {
    return {
      fromGeneration,
      toGeneration: requesting.generation,
      granted: true,
      staleRequester: false,
      readOnly: false,
      reason: 'same_owner',
    };
  }
  return {
    fromGeneration,
    toGeneration: requesting.generation,
    granted: true,
    staleRequester: false,
    readOnly: false,
    reason: 'owner_handoff',
  };
}

// ─── Operation classification ────────────────────────────────────────────────

export interface RestoreOperationEvidence {
  readonly operationId: string;
  readonly commandId?: string;
  readonly admissionId?: string;
  readonly effectClass: ToolEffectClass;
  readonly admissionState?: AdmissionState;
  readonly outboxState?: OutboxState | null;
  /** Effect-ledger state, when a ledger record exists for this operation. */
  readonly effectState?: 'none' | EffectLedgerStatus;
  /** Precomputed `effectLedger` decision, when the effect was interrupted. */
  readonly reconciliation?: EffectReconciliationDecision;
  /**
   * The admission's own evidence-completeness record. Terminal evidence may only
   * claim authority when this is complete and untruncated
   * (`isAuthoritativeAdmission`). Absent means unknown, not authoritative.
   */
  readonly completeness?: AdmissionCompletenessV1;
  /** Processes attributable to this operation that have not been settled. */
  readonly processTreeSettled?: boolean;
  readonly unknownReasons?: readonly string[];
  readonly evidenceRefs?: readonly string[];
}

export interface OperationClassification {
  readonly recoveryClass: OperationRecoveryClass;
  readonly state: OperationState;
  readonly action: RecoveryAction;
  readonly automaticRetryAllowed: boolean;
  readonly reasons: readonly string[];
}

/**
 * Classify one operation from observed evidence. Pure and conservative:
 * completion requires explicit terminal/reconciled evidence; ambiguity is never
 * converted into a retry.
 */
export function classifyOperation(evidence: RestoreOperationEvidence): OperationClassification {
  const recoveryClass = recoveryClassForEffect(evidence.effectClass);
  const unknownReasons = evidence.unknownReasons ?? [];
  const unknownEvidence = unknownReasons.length > 0;

  const admissionSettled = evidence.admissionState === 'settled';
  const outboxCommitted = evidence.outboxState === 'committed';
  const effectCompleted = evidence.effectState === 'completed';
  const reconciledComplete = evidence.reconciliation === 'recovered_complete';

  if (admissionSettled || outboxCommitted || effectCompleted || reconciledComplete) {
    const terminalEvidence = admissionSettled && outboxCommitted;
    const completenessAuthoritative =
      evidence.completeness !== undefined && isAuthoritativeAdmission(evidence.completeness);
    if (terminalEvidence && !completenessAuthoritative) {
      // A terminal record whose own completeness says the evidence was
      // truncated/incomplete may never claim authority (`isAuthoritativeAdmission`).
      return {
        recoveryClass,
        state: 'indeterminate',
        action: 'operator_reconciliation_required',
        automaticRetryAllowed: false,
        reasons: [RESTORE_REASONS.EVIDENCE_INCOMPLETE],
      };
    }
    const authoritative = terminalEvidence && completenessAuthoritative;
    const reasons: string[] = [
      authoritative
        ? RESTORE_REASONS.TERMINAL_COMMITTED
        : RESTORE_REASONS.EFFECT_APPLIED_WITHOUT_RECEIPT,
    ];
    if (!authoritative && evidence.completeness !== undefined && !completenessAuthoritative) {
      reasons.push(RESTORE_REASONS.EVIDENCE_INCOMPLETE);
    }
    return {
      recoveryClass,
      state: 'completed',
      action: 'none_complete',
      automaticRetryAllowed: false,
      reasons,
    };
  }

  if (evidence.admissionState === 'aborted') {
    return {
      recoveryClass,
      state: 'not_started',
      action: 'none_complete',
      automaticRetryAllowed: false,
      reasons: [RESTORE_REASONS.ADMISSION_ABORTED],
    };
  }

  if (evidence.admissionState === 'indeterminate' || unknownEvidence) {
    return {
      recoveryClass,
      state: 'indeterminate',
      action: 'operator_reconciliation_required',
      automaticRetryAllowed: false,
      reasons: [...unknownReasons, RESTORE_REASONS.EVIDENCE_INCOMPLETE],
    };
  }

  const ambiguous =
    recoveryClass === 'ambiguous_mutation' ||
    recoveryClass === 'external_side_effect' ||
    recoveryClass === 'unknown';
  if (ambiguous) {
    const started = evidence.effectState === 'intent' || evidence.admissionState === 'claimed';
    const processUnsettled =
      recoveryClass === 'ambiguous_mutation' && evidence.processTreeSettled === false;
    if (processUnsettled) {
      return {
        recoveryClass,
        state: started ? 'interrupted' : 'unknown',
        action: 'await_process_tree_settle',
        automaticRetryAllowed: false,
        reasons: [RESTORE_REASONS.PROCESS_TREE_UNSETTLED, RESTORE_REASONS.AMBIGUOUS_NOT_RETRIED],
      };
    }
    return {
      recoveryClass,
      state: started ? 'interrupted' : 'unknown',
      action: 'operator_reconciliation_required',
      automaticRetryAllowed: false,
      reasons: [RESTORE_REASONS.AMBIGUOUS_NOT_RETRIED],
    };
  }

  if (evidence.reconciliation === 'workspace_conflict') {
    return {
      recoveryClass,
      state: 'indeterminate',
      action: 'operator_reconciliation_required',
      automaticRetryAllowed: false,
      reasons: [RESTORE_REASONS.WORKSPACE_CONFLICT],
    };
  }

  const notStarted =
    evidence.effectState === undefined ||
    evidence.effectState === 'none' ||
    evidence.effectState === 'failed' ||
    evidence.effectState === 'cancelled';
  const terminalFailure =
    evidence.effectState === 'failed' || evidence.effectState === 'cancelled';
  if (notStarted) {
    const retry = recoveryClass === 'read_only' || recoveryClass === 'idempotent';
    return {
      recoveryClass,
      state: terminalFailure ? 'interrupted' : 'not_started',
      action: retry ? 'retry_safe' : 'reconcile_workspace_before_retry',
      automaticRetryAllowed: retry,
      reasons: [terminalFailure ? RESTORE_REASONS.EFFECT_TERMINAL_FAILURE : RESTORE_REASONS.ADMISSION_WITHOUT_EFFECT],
    };
  }

  if (recoveryClass === 'reconcilable_mutation') {
    return {
      recoveryClass,
      state: 'interrupted',
      action: 'reconcile_workspace_before_retry',
      automaticRetryAllowed: false,
      reasons: [RESTORE_REASONS.PREIMAGE_RECONCILABLE],
    };
  }

  return {
    recoveryClass,
    state: 'interrupted',
    action: 'retry_safe',
    automaticRetryAllowed: true,
    reasons: [RESTORE_REASONS.IDEMPOTENT_RETRY],
  };
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface RestoreOperationReport {
  readonly operationId: string;
  readonly commandId?: string;
  readonly admissionId?: string;
  readonly effectClass: ToolEffectClass;
  readonly recoveryClass: OperationRecoveryClass;
  readonly state: OperationState;
  readonly action: RecoveryAction;
  readonly automaticRetryAllowed: boolean;
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface RestoreHistoryEvidence {
  readonly readable: boolean;
  readonly truncated: boolean;
  readonly corrupt: boolean;
  readonly reasons: readonly string[];
}

export interface RestoreBudgetEvidence {
  readonly turnsRemaining: number | null;
  readonly tokensRemaining: number | null;
  readonly repairAttemptsRemaining: number | null;
  readonly infraRetriesRemaining: number | null;
}

export interface ProcessTreeSettleEvidence {
  readonly settled: boolean;
  readonly observedPids: readonly number[];
  readonly method: 'reaped' | 'absence_checked' | 'unknown';
  readonly reasons: readonly string[];
}

export interface RestoreTerminalEvidence {
  readonly outcome: string;
  readonly status: string;
  readonly evidenceRefs: readonly string[];
  /** Only the existing trusted completion path may set this true. */
  readonly authoritative: boolean;
}

export interface RestoreCursorInput {
  readonly journal: CheckpointJournal;
  readonly position: number;
  readonly digest?: string;
}

export interface BuildRestoreReportInput {
  readonly threadId: string;
  readonly sessionId?: string;
  readonly interruptionClass: InterruptionClass;
  readonly history?: RestoreHistoryEvidence;
  readonly cursor?: RestoreCursorInput | null;
  readonly ownerCurrent?: OwnerRecordV1 | null;
  readonly ownerRequesting?: { readonly generation: number; readonly token: string } | null;
  readonly attachMode?: 'observe' | 'own';
  readonly operations?: readonly RestoreOperationEvidence[];
  readonly budget?: RestoreBudgetEvidence | null;
  readonly processTree?: ProcessTreeSettleEvidence | null;
  readonly continuationRequested?: boolean;
  readonly knownMissingAuthorities?: readonly MissingAuthority[];
  readonly terminal?: RestoreTerminalEvidence | null;
  readonly diagnostics?: readonly string[];
  readonly maxOperations?: number;
  readonly now?: () => Date;
}

export interface RestoreReport {
  readonly schemaVersion: typeof RESTORE_REPORT_VERSION;
  readonly generatedAt: string;
  readonly threadId: string;
  readonly sessionId?: string;
  readonly interruptionClass: InterruptionClass;
  /** Always false: this campaign disables automatic resume. */
  readonly automaticResume: false;
  readonly operatorActionRequired: boolean;
  readonly historyReadable: boolean;
  readonly cursor: CheckpointCursor;
  readonly owner: OwnerHandoff;
  readonly terminal?: RestoreTerminalEvidence;
  readonly operations: readonly RestoreOperationReport[];
  readonly missingAuthorities: readonly MissingAuthority[];
  readonly processTree: ProcessTreeSettleEvidence | null;
  readonly continuationBlocked: boolean;
  readonly continuationBlockedReason?: string;
  readonly degraded: boolean;
  readonly degradedReasons: readonly string[];
  readonly bounded: {
    readonly maxOperations: number;
    readonly truncated: boolean;
  };
  readonly diagnostics: readonly string[];
}

const DEFAULT_HISTORY: RestoreHistoryEvidence = {
  readable: true,
  truncated: false,
  corrupt: false,
  reasons: [],
};

function normalizeHistory(history: RestoreHistoryEvidence | undefined): RestoreHistoryEvidence {
  return history ?? DEFAULT_HISTORY;
}

function normalizeCursor(
  cursor: RestoreCursorInput | null | undefined,
  history: RestoreHistoryEvidence,
): CheckpointCursor {
  if (!cursor) {
    return {
      journal: 'admission',
      position: -1,
      complete: false,
      reasons: [RESTORE_REASONS.NO_CHECKPOINT],
    };
  }
  const reasons: string[] = [];
  if (!history.readable) reasons.push(RESTORE_REASONS.HISTORY_UNREADABLE);
  if (history.corrupt) reasons.push(RESTORE_REASONS.HISTORY_CORRUPT);
  if (history.truncated) reasons.push(RESTORE_REASONS.HISTORY_TRUNCATED);
  const complete = reasons.length === 0;
  return {
    journal: cursor.journal,
    position: cursor.position,
    ...(cursor.digest !== undefined ? { digest: cursor.digest } : {}),
    complete,
    reasons: complete ? [] : [RESTORE_REASONS.CURSOR_INCOMPLETE, ...reasons],
  };
}

function budgetBlocksContinuation(budget: RestoreBudgetEvidence | null): {
  blocked: boolean;
  reason?: string;
} {
  // Missing or entirely-unknown budget cannot authorize a continuation.
  if (!budget) return { blocked: true, reason: RESTORE_REASONS.BUDGET_MISSING };
  const remaining = [
    budget.turnsRemaining,
    budget.tokensRemaining,
    budget.repairAttemptsRemaining,
    budget.infraRetriesRemaining,
  ].filter((value): value is number => value !== null);
  if (remaining.length === 0) return { blocked: true, reason: RESTORE_REASONS.BUDGET_MISSING };
  if (remaining.some((value) => value <= 0)) {
    return { blocked: true, reason: RESTORE_REASONS.BUDGET_EXHAUSTED };
  }
  return { blocked: false };
}

/** Bounded, versioned restore diagnostic. Never fabricates authority or success. */
export function buildRestoreReport(input: BuildRestoreReportInput): RestoreReport {
  const history = normalizeHistory(input.history);
  const now = input.now ?? (() => new Date());
  const maxOperations = Math.max(0, Math.floor(input.maxOperations ?? DEFAULT_MAX_RESTORE_OPERATIONS));
  const cursors = normalizeCursor(input.cursor, history);
  const readOnly = input.attachMode === 'observe';
  const owner = evaluateOwnerHandoff({
    current: input.ownerCurrent ?? null,
    requesting: input.ownerRequesting ?? null,
    readOnly,
  });

  const continuationRequested = input.continuationRequested === true;
  const budgetResult = budgetBlocksContinuation(input.budget ?? null);
  const budgetBlocked = continuationRequested && budgetResult.blocked;
  const historyBlocksExecution =
    history.readable === false || history.corrupt || history.truncated;

  const missingAuthorities = new Set<MissingAuthority>(input.knownMissingAuthorities ?? []);
  if (!history.readable || history.corrupt) missingAuthorities.add('history');
  if (budgetBlocked && budgetResult.reason === RESTORE_REASONS.BUDGET_MISSING) {
    missingAuthorities.add('task_budget');
  }
  if (continuationRequested && !owner.granted) missingAuthorities.add('owner_lease');

  const rawOperations = [...(input.operations ?? [])].sort((a, b) =>
    a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0,
  );
  const truncated = rawOperations.length > maxOperations;
  const boundedOperations = rawOperations.slice(0, maxOperations);

  const degradedReasons = new Set<string>(history.reasons);
  if (!history.readable) degradedReasons.add(RESTORE_REASONS.HISTORY_UNREADABLE);
  if (history.truncated) degradedReasons.add(RESTORE_REASONS.HISTORY_TRUNCATED);
  if (history.corrupt) degradedReasons.add(RESTORE_REASONS.HISTORY_CORRUPT);
  if (truncated) degradedReasons.add(RESTORE_REASONS.OPERATIONS_TRUNCATED);
  if (budgetBlocked && budgetResult.reason) degradedReasons.add(budgetResult.reason);
  if (owner.staleRequester) degradedReasons.add(RESTORE_REASONS.STALE_OWNER);

  let anyExecutableBlocked = false;
  let hasIncompleteEvidence = false;
  const operations: RestoreOperationReport[] = boundedOperations.map((rawEvidence) => {
    // A report-level process-tree observation applies to every operation unless
    // the evidence already carries a more specific value.
    const evidence =
      input.processTree && rawEvidence.processTreeSettled === undefined
        ? { ...rawEvidence, processTreeSettled: input.processTree.settled }
        : rawEvidence;
    const classification = classifyOperation(evidence);
    let action = classification.action;
    const reasons = [...classification.reasons];
    let automaticRetryAllowed = classification.automaticRetryAllowed;
    if (reasons.includes(RESTORE_REASONS.EVIDENCE_INCOMPLETE)) {
      hasIncompleteEvidence = true;
    }

    if (isExecutableAction(action)) {
      if (historyBlocksExecution) {
        action = 'history_only';
        automaticRetryAllowed = false;
        reasons.push(
          history.readable === false
            ? RESTORE_REASONS.HISTORY_UNREADABLE
            : history.corrupt
              ? RESTORE_REASONS.HISTORY_CORRUPT
              : RESTORE_REASONS.HISTORY_TRUNCATED,
        );
        anyExecutableBlocked = true;
      } else if (budgetBlocked) {
        action = 'blocked_missing_budget';
        automaticRetryAllowed = false;
        reasons.push(RESTORE_REASONS.BUDGET_BLOCKS_CONTINUATION);
        anyExecutableBlocked = true;
      } else if (continuationRequested && !owner.granted) {
        action = 'blocked_missing_authority';
        automaticRetryAllowed = false;
        reasons.push(RESTORE_REASONS.MISSING_AUTHORITY_BLOCKS_CONTINUATION);
        anyExecutableBlocked = true;
      }
    }

    const evidenceRefs = [...new Set(evidence.evidenceRefs ?? [])].slice(0, MAX_RESTORE_EVIDENCE_REFS);
    return {
      operationId: evidence.operationId,
      ...(evidence.commandId !== undefined ? { commandId: evidence.commandId } : {}),
      ...(evidence.admissionId !== undefined ? { admissionId: evidence.admissionId } : {}),
      effectClass: evidence.effectClass,
      recoveryClass: classification.recoveryClass,
      state: classification.state,
      action,
      automaticRetryAllowed,
      reasons: [...new Set(reasons)].sort(),
      evidenceRefs,
    };
  });

  const operatorActionRequired =
    operations.some((operation) =>
      (operation.action === 'none_complete' &&
        operation.reasons.includes(RESTORE_REASONS.EFFECT_APPLIED_WITHOUT_RECEIPT)) ||
      operation.action === 'operator_reconciliation_required' ||
      operation.action === 'await_process_tree_settle' ||
      operation.action === 'blocked_missing_budget' ||
      operation.action === 'blocked_missing_authority' ||
      operation.action === 'history_only',
    ) || owner.staleRequester;
  if (hasIncompleteEvidence) degradedReasons.add(RESTORE_REASONS.EVIDENCE_INCOMPLETE);

  const continuationBlocked =
    continuationRequested &&
    (budgetBlocked || historyBlocksExecution || anyExecutableBlocked || !owner.granted || !cursors.complete);
  let continuationBlockedReason: string | undefined;
  if (continuationBlocked) {
    continuationBlockedReason = budgetBlocked
      ? budgetResult.reason
      : historyBlocksExecution
        ? !history.readable
          ? RESTORE_REASONS.HISTORY_UNREADABLE
          : history.corrupt
            ? RESTORE_REASONS.HISTORY_CORRUPT
            : RESTORE_REASONS.HISTORY_TRUNCATED
        : !owner.granted
          ? RESTORE_REASONS.STALE_OWNER
          : !cursors.complete
            ? RESTORE_REASONS.CURSOR_INCOMPLETE
            : RESTORE_REASONS.MISSING_AUTHORITY_BLOCKS_CONTINUATION;
    degradedReasons.add(RESTORE_REASONS.MISSING_AUTHORITY_BLOCKS_CONTINUATION);
  }

  return {
    schemaVersion: RESTORE_REPORT_VERSION,
    generatedAt: now().toISOString(),
    threadId: input.threadId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    interruptionClass: input.interruptionClass,
    automaticResume: false,
    operatorActionRequired,
    historyReadable: history.readable,
    cursor: cursors,
    owner,
    ...(input.terminal ? { terminal: input.terminal } : {}),
    operations,
    missingAuthorities: [...missingAuthorities].sort(),
    processTree: input.processTree ?? null,
    continuationBlocked,
    ...(continuationBlockedReason !== undefined ? { continuationBlockedReason } : {}),
    degraded: degradedReasons.size > 0,
    degradedReasons: [...degradedReasons].sort(),
    bounded: { maxOperations, truncated },
    diagnostics: [...(input.diagnostics ?? [])],
  };
}
