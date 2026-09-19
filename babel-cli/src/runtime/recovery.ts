/**
 * P06 — recovery orchestrator.
 *
 * Reads the durable P05 `AdmissionStore` (the single control journal) and the
 * existing `executor/effectLedger` reconciliation, then produces a versioned,
 * bounded `RestoreReport`. This module creates **no** second store, journal, DB,
 * event log or permission path; it only reads what P05 committed and classifies
 * what may be safely continued.
 *
 * Default policy: automatic resume is disabled. A caller must ask for a
 * continuation explicitly, provide the owner identity it wants to use, and the
 * report will still route every ambiguous effect to operator reconciliation.
 */

import type { ToolEffectClass } from '../executor/contracts.js';
import {
  findInterruptedEffects,
  loadEffectLedger,
  reconcileInterruptedEffect,
  type EffectReconciliationDecision,
} from '../executor/effectLedger.js';
import {
  openAdmissionStore,
  type AdmissionStore,
  type AdmissionStoreOptions,
  type SettleAdmissionInput,
  type SettleDecision,
} from './admission.js';
import { ADMISSION_REASONS, type AdmissionRecordV1 } from './admissionContracts.js';
import {
  buildRestoreReport,
  DEFAULT_MAX_RESTORE_OPERATIONS,
  evaluateOwnerHandoff,
  type BuildRestoreReportInput,
  type CheckpointCursor,
  type InterruptionClass,
  type MissingAuthority,
  type ProcessTreeSettleEvidence,
  type RestoreBudgetEvidence,
  type RestoreHistoryEvidence,
  type RestoreOperationEvidence,
  type RestoreReport,
  type RestoreTerminalEvidence,
} from './restoreReport.js';

export type { InterruptionClass } from './restoreReport.js';

// ─── Interruption classification ─────────────────────────────────────────────

export interface InterruptionDetectionInput {
  /** A new runtime process is starting (not merely a client reconnecting). */
  readonly processStarted: boolean;
  /** The previous owner lease is still observed as live. */
  readonly ownerLeaseActive: boolean;
  /** A tool effect intent exists without a terminal record. */
  readonly hasUnfinishedEffect: boolean;
}

/**
 * Distinguish the three interruption classes explicitly. A process restart is
 * authoritative over the others; an unfinished effect marks a continuation;
 * otherwise the runtime is alive and this is a client reconnect.
 */
export function classifyInterruption(input: InterruptionDetectionInput): InterruptionClass {
  if (input.processStarted) return 'process_restart';
  if (input.hasUnfinishedEffect) return 'unfinished_tool_continuation';
  return 'client_reconnect';
}

// ─── Restore session ─────────────────────────────────────────────────────────

export interface RestoreInput {
  readonly authorizedRoot: string;
  readonly runDir: string;
  readonly threadId: string;
  readonly sessionId?: string;
  readonly interruptionClass: InterruptionClass;
  readonly attachMode?: 'observe' | 'own';
  readonly ownerRequesting?: { readonly generation: number; readonly token: string } | null;
  readonly history?: RestoreHistoryEvidence;
  readonly cursor?: CheckpointCursor | null;
  readonly budget?: RestoreBudgetEvidence | null;
  readonly currentImageHashes?: Record<string, string>;
  readonly processTree?: ProcessTreeSettleEvidence | null;
  readonly continuationRequested?: boolean;
  readonly knownMissingAuthorities?: readonly MissingAuthority[];
  readonly terminal?: RestoreTerminalEvidence | null;
  readonly maxOperations?: number;
  readonly now?: () => Date;
  readonly storeOptions?: Partial<Omit<AdmissionStoreOptions, 'authorizedRoot' | 'runDir'>>;
}

export interface RestoreSession {
  readonly report: RestoreReport;
  readonly store: AdmissionStore | null;
  /**
   * Attempt to create durable terminal state for a recovered operation. Fenced:
   * a stale requester is refused before the P05 store is consulted.
   */
  settle(input: SettleAdmissionInput): SettleDecision;
  close(): void;
}

function outboxStateToEffectState(
  state: 'intent' | 'committed' | 'failed' | 'indeterminate' | undefined,
): 'none' | 'intent' | 'completed' | 'failed' {
  switch (state) {
    case 'intent':
    case 'indeterminate':
      return 'intent';
    case 'committed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'none';
  }
}

function admissionToEvidence(
  store: AdmissionStore,
  record: AdmissionRecordV1,
  currentImageHashes: Record<string, string>,
): RestoreOperationEvidence {
  const unknownReasons: string[] = [];
  let outboxEffectClass: ToolEffectClass = 'external_side_effect';
  let outboxState: 'intent' | 'committed' | 'failed' | 'indeterminate' | null = null;
  let decision: EffectReconciliationDecision | undefined;

  const recovered = store.recoverAdmission({
    threadId: record.threadId,
    commandId: record.commandId,
    currentImageHashes,
  });
  if (recovered.kind === 'rejected') {
    unknownReasons.push(recovered.reasonCode);
    if (recovered.detail !== undefined) unknownReasons.push(recovered.detail);
  } else {
    decision = recovered.decision;
    if (recovered.outbox) {
      outboxEffectClass = recovered.outbox.effectClass;
      outboxState = recovered.outbox.state;
      if (recovered.outbox.state === 'indeterminate') {
        unknownReasons.push('outbox_indeterminate');
      }
    } else {
      unknownReasons.push('outbox_missing');
    }
  }

  return {
    operationId: record.commandId,
    commandId: record.commandId,
    admissionId: record.admissionId,
    effectClass: outboxEffectClass,
    admissionState: record.state,
    outboxState,
    effectState: outboxStateToEffectState(outboxState ?? undefined),
    ...(decision !== undefined ? { reconciliation: decision } : {}),
    ...(unknownReasons.length > 0 ? { unknownReasons } : {}),
    evidenceRefs: [record.admissionId],
  };
}

function ledgerEffectEvidence(
  effect: { operationId: string; effectClass: ToolEffectClass; preImageHashes: Record<string, string>; postImageHashes?: Record<string, string> },
  currentImageHashes: Record<string, string>,
): RestoreOperationEvidence {
  const decision = reconcileInterruptedEffect(
    {
      effectClass: effect.effectClass,
      preImageHashes: effect.preImageHashes,
      ...(effect.postImageHashes !== undefined ? { postImageHashes: effect.postImageHashes } : {}),
    },
    currentImageHashes,
  );
  return {
    operationId: effect.operationId,
    effectClass: effect.effectClass,
    effectState: 'intent',
    reconciliation: decision,
    evidenceRefs: [`effect:${effect.operationId}`],
  };
}

/**
 * Read committed state and produce a restore report. Never writes. The returned
 * `store` is owned by the caller until `close()`; pass it to `settle` only after
 * the report's owner handoff was granted.
 */
export function restoreFromCommittedState(input: RestoreInput): RestoreSession {
  const currentImageHashes = input.currentImageHashes ?? {};
  const diagnostics: string[] = [];
  const knownMissing = new Set<MissingAuthority>(input.knownMissingAuthorities ?? []);

  const openResult = openAdmissionStore({
    authorizedRoot: input.authorizedRoot,
    runDir: input.runDir,
    ...input.storeOptions,
  });

  const store = openResult.ok ? openResult.store : null;
  if (!openResult.ok) {
    diagnostics.push(`admission_store_unavailable:${openResult.reasonCode}:${openResult.detail}`);
    knownMissing.add('admission_store');
  }

  const ownerCurrent = store ? store.readOwner(input.threadId) : null;

  const operations: RestoreOperationEvidence[] = [];
  const knownOperationIds = new Set<string>();
  let admissionCount = 0;

  if (store) {
    const admissions = store.listAdmissions(input.threadId);
    admissionCount = admissions.length;
    for (const record of admissions) {
      const evidence = admissionToEvidence(store, record, currentImageHashes);
      operations.push(evidence);
      knownOperationIds.add(evidence.operationId);
    }
  }

  try {
    const interrupted = findInterruptedEffects(loadEffectLedger(input.runDir));
    for (const effect of interrupted) {
      if (knownOperationIds.has(effect.operationId)) continue;
      operations.push(ledgerEffectEvidence(effect, currentImageHashes));
      knownOperationIds.add(effect.operationId);
    }
  } catch (error) {
    diagnostics.push(`effect_ledger_unreadable:${errorText(error)}`);
    knownMissing.add('effect_ledger');
  }

  const cursor: CheckpointCursor | null =
    input.cursor ??
    (store
      ? { journal: 'admission', position: admissionCount, complete: true, reasons: [] }
      : null);

  const reportInput: BuildRestoreReportInput = {
    threadId: input.threadId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    interruptionClass: input.interruptionClass,
    ...(input.history !== undefined ? { history: input.history } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ownerCurrent,
    ownerRequesting: input.ownerRequesting ?? null,
    ...(input.attachMode !== undefined ? { attachMode: input.attachMode } : {}),
    operations,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
    ...(input.processTree !== undefined ? { processTree: input.processTree } : {}),
    continuationRequested: input.continuationRequested === true,
    knownMissingAuthorities: [...knownMissing],
    ...(input.terminal !== undefined ? { terminal: input.terminal } : {}),
    diagnostics,
    ...(input.maxOperations !== undefined ? { maxOperations: input.maxOperations } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  };
  const report = buildRestoreReport(reportInput);

  return {
    report,
    store,
    settle(settleInput: SettleAdmissionInput): SettleDecision {
      if (!store) {
        return {
          settled: false,
          reasonCode: ADMISSION_REASONS.UNAVAILABLE,
          detail: 'admission_store_unavailable',
        };
      }
      const current = store.readOwner(settleInput.threadId);
      const handoff = evaluateOwnerHandoff({
        current,
        requesting: {
          generation: settleInput.ownerGeneration,
          token: settleInput.ownerToken,
        },
        readOnly: false,
      });
      // Publishing terminal state requires being the *current* durable owner. A
      // higher generation is a handoff plan, not yet a lease: the caller must
      // first admit under that generation, then settle.
      const mayPublish =
        handoff.reason === 'same_owner' || handoff.reason === 'no_existing_owner';
      if (!handoff.granted || !mayPublish) {
        return {
          settled: false,
          reasonCode: ADMISSION_REASONS.STALE_OWNER,
          detail: handoff.granted ? 'owner_handoff_requires_admission' : handoff.reason,
        };
      }
      return store.settleAdmission(settleInput);
    },
    close(): void {
      store?.close();
    },
  };
}

/** Read-only convenience: build a report and close the store immediately. */
export function inspectCommittedState(input: RestoreInput): RestoreReport {
  const session = restoreFromCommittedState(input);
  try {
    return session.report;
  } finally {
    session.close();
  }
}

/** Default report bounds, re-exported so callers do not invent a different cap. */
export { DEFAULT_MAX_RESTORE_OPERATIONS };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}
