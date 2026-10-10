/**
 * Packet A4 — event-replay-based chat resume.
 *
 * Rebuilds the hydrated resume state for a conversation from the A2 runtime
 * EventLog (`runtime/eventLog.ts`) instead of artifact-availability
 * heuristics. The log is the single replayable source of runtime facts; this
 * module reads it with A2's fail-closed reader (a torn tail is discarded,
 * never surfaced), orders it with `replayEventLogRecords`, and projects the
 * ordered facts into a deterministic, hash-addressed state.
 *
 * Responsibilities:
 *   - Hydrate the resume state (runs, turns, operations, checkpoints,
 *     terminal decision) from EventLog facts, deterministically. Two resumes
 *     from the same log produce the identical `stateHash`.
 *   - Fenced pre-compaction context: P11 checkpoint capsules are validated
 *     through the existing lineage fencing
 *     (`validateContextCheckpointInstalledLineage`) before their context is
 *     surfaced; a stale receipt in a capsule appears as an explicit gap, and
 *     an unproven lineage blocks the capsule (never silently promotes it).
 *   - Indeterminate effects are surfaced through the P06 recovery
 *     classification (`buildRestoreReport`): `automaticResume` stays false,
 *     ambiguous effects stay operator-gated.
 *
 * This module never executes tools, retries operations, or enables automatic
 * resume. It is read-only over durable records.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sha256Canonical } from '../acceptance/canonical.js';
import type { ToolEffectClass } from '../executor/contracts.js';
import {
  readRuntimeEventLog,
  replayEventLogRecords,
  RUNTIME_EVENT_LOG_FILENAME,
  type RuntimeEventLogReadResult,
} from '../runtime/eventLog.js';
import type {
  FactPayload,
  PrunedMessageRange,
  RuntimeCompletionDecision,
  RuntimeFactV1,
} from '../runtime/events.js';
import {
  validateContextCheckpointInstalledLineage,
  type ContextCheckpointLineageEvidenceV1,
  type ContextCheckpointV1,
  type ContextCheckpointValidationReasonV1,
} from '../runtime/contextCheckpoints.js';
import {
  buildRestoreReport,
  type InterruptionClass,
  type RestoreOperationEvidence,
  type RestoreReport,
} from '../runtime/restoreReport.js';

/** Version of the hydrated resume-replay state contract. */
export const RESUME_REPLAY_STATE_VERSION = 1 as const;

/**
 * Fallback-retention flag for the pre-A4 artifact-availability heuristic in
 * `resumeExecution`. The heuristic fallback is retained (flag-guarded): it is
 * enabled unless this environment variable is set to `off`. Replay always
 * takes precedence when a valid EventLog exists.
 */
export const RESUME_HEURISTIC_FALLBACK_FLAG = 'BABEL_RESUME_HEURISTIC_FALLBACK';

/** Whether the legacy artifact-availability heuristic may still answer resume. */
export function resumeHeuristicFallbackEnabled(): boolean {
  try {
    return process.env?.[RESUME_HEURISTIC_FALLBACK_FLAG] !== 'off';
  } catch {
    return true;
  }
}

// ─── Hydrated state ─────────────────────────────────────────────────────────

/** One operation observed in the fact stream (prepared/settled/indeterminate). */
export interface ResumeReplayOperationV1 {
  readonly operationId: string;
  readonly operationDigest: string;
  readonly prepared: boolean;
  readonly toolName: string | null;
  readonly effectClass: string | null;
  /** Receipt id when the operation settled; null while pending/indeterminate. */
  readonly settledReceiptId: string | null;
  readonly settledStatus: string | null;
  /** Reason from an `operation.indeterminate` fact; null otherwise. */
  readonly indeterminateReason: string | null;
}

/**
 * Deterministic hydration of one conversation's fact stream. Field order is
 * stable; `stateHash` covers every field except itself, so two resumes from
 * the same log produce an identical hash.
 */
export interface ResumeReplayStateV1 {
  readonly schemaVersion: typeof RESUME_REPLAY_STATE_VERSION;
  readonly threadId: string;
  /** Run identities in first-seen order. */
  readonly runIds: readonly string[];
  /** Turn identities in first-seen order. */
  readonly turnIds: readonly string[];
  /** Highest fact cursor sequence replayed (the resume cursor). */
  readonly lastCursorSequence: number;
  /** Authoritative terminal decision, when the log records one. */
  readonly completion: RuntimeCompletionDecision | null;
  readonly operations: readonly ResumeReplayOperationV1[];
  /** Checkpoint ids committed via `context.committed` facts, in order. */
  readonly checkpointIds: readonly string[];
  /** `context.degraded` reasons, in order, deduplicated. */
  readonly degradedReasons: readonly string[];
  /**
   * Packet A5: condensation facts observed in the stream, in started order.
   * A record with `open: true` is a started fact with no completed pair —
   * the fail-closed signature of an interrupted compaction, surfaced here
   * and never repaired.
   */
  readonly condensations: readonly ResumeCondensationV1[];
  /** Digest of every field above except this one. */
  readonly stateHash: string;
}

/** One condensation observed in the fact stream (packet A5). */
export interface ResumeCondensationV1 {
  readonly compactionId: string;
  readonly path: string;
  /** Cursor sequence of the started fact. */
  readonly startedSequence: number;
  readonly countBefore: number | null;
  readonly countAfter: number | null;
  readonly prunedMessageRanges: ReadonlyArray<PrunedMessageRange>;
  /** P11 checkpoint capsule id fenced by the completed compaction, if any. */
  readonly capsuleCheckpointId: string | null;
  /** True when no completed fact followed the started fact (visible gap). */
  readonly open: boolean;
}

const EFFECT_CLASSES: ReadonlySet<string> = new Set<ToolEffectClass>([
  'read_only',
  'idempotent',
  'reconcilable_mutation',
  'non_idempotent_local_effect',
  'external_side_effect',
]);

/**
 * Project ordered facts into the hydrated state. Pure: same input facts, same
 * output state and hash, regardless of clock or environment.
 */
export function hydrateResumeStateFromFacts(facts: readonly RuntimeFactV1[]): ResumeReplayStateV1 {
  const runIds: string[] = [];
  const turnIds: string[] = [];
  const seenRuns = new Set<string>();
  const seenTurns = new Set<string>();
  const operations = new Map<string, ResumeReplayOperationV1>();
  const operationOrder: string[] = [];
  const checkpointIds: string[] = [];
  const degradedReasons: string[] = [];
  const condensations: ResumeCondensationV1[] = [];
  const condensationIndex = new Map<string, ResumeCondensationV1>();
  let lastCursorSequence = -1;
  let completion: RuntimeCompletionDecision | null = null;
  let threadId = '';

  const operationKey = (payload: FactPayload): string => {
    if ('operationId' in payload && typeof payload.operationId === 'string' && payload.operationId.length > 0) {
      return payload.operationId;
    }
    if ('operationDigest' in payload) return `digest:${payload.operationDigest}`;
    if ('receiptId' in payload) return `receipt:${payload.receiptId}`;
    return '';
  };

  for (const fact of facts) {
    if (threadId === '' && fact.threadId.length > 0) threadId = fact.threadId;
    if (fact.runId.length > 0 && !seenRuns.has(fact.runId)) {
      seenRuns.add(fact.runId);
      runIds.push(fact.runId);
    }
    if (fact.turnId.length > 0 && !seenTurns.has(fact.turnId)) {
      seenTurns.add(fact.turnId);
      turnIds.push(fact.turnId);
    }
    const seq = typeof fact.cursor?.sequence === 'number' ? fact.cursor.sequence : -1;
    if (seq > lastCursorSequence) lastCursorSequence = seq;

    const payload = fact.payload;
    if (payload.type === 'operation.prepared' || payload.type === 'operation.settled' || payload.type === 'operation.indeterminate') {
      const key = operationKey(payload);
      if (key.length === 0) continue;
      const existing = operations.get(key);
      const operation: ResumeReplayOperationV1 = {
        operationId: existing?.operationId ?? ('operationId' in payload && payload.operationId ? payload.operationId : key),
        operationDigest:
          'operationDigest' in payload ? payload.operationDigest : (existing?.operationDigest ?? ''),
        prepared: payload.type === 'operation.prepared' || (existing?.prepared ?? false),
        toolName:
          payload.type === 'operation.prepared' && payload.toolName
            ? payload.toolName
            : (existing?.toolName ?? null),
        effectClass:
          payload.type === 'operation.prepared' && payload.effectClass
            ? payload.effectClass
            : (existing?.effectClass ?? null),
        settledReceiptId:
          payload.type === 'operation.settled' ? payload.receiptId : (existing?.settledReceiptId ?? null),
        settledStatus:
          payload.type === 'operation.settled' && payload.status
            ? payload.status
            : (existing?.settledStatus ?? null),
        indeterminateReason:
          payload.type === 'operation.indeterminate'
            ? payload.reason
            : (existing?.indeterminateReason ?? null),
      };
      if (!operations.has(key)) operationOrder.push(key);
      operations.set(key, operation);
      continue;
    }
    if (payload.type === 'context.committed') {
      if (!checkpointIds.includes(payload.checkpointId)) checkpointIds.push(payload.checkpointId);
      continue;
    }
    if (payload.type === 'context.degraded') {
      if (!degradedReasons.includes(payload.reason)) degradedReasons.push(payload.reason);
      continue;
    }
    // Packet A5: project condensation facts; an unpaired started fact stays
    // open (fail-closed), it is never dropped or silently closed.
    if (payload.type === 'context.condensation.started') {
      const record: ResumeCondensationV1 = {
        compactionId: payload.compactionId,
        path: payload.path,
        startedSequence: seq,
        countBefore: payload.countBefore,
        countAfter: null,
        prunedMessageRanges: [],
        capsuleCheckpointId: null,
        open: true,
      };
      condensations.push(record);
      condensationIndex.set(payload.compactionId, record);
      continue;
    }
    if (payload.type === 'context.condensation.completed') {
      const existing = condensationIndex.get(payload.compactionId);
      if (existing) {
        const closed: ResumeCondensationV1 = {
          ...existing,
          countAfter: payload.countAfter,
          prunedMessageRanges: [...payload.prunedMessageRanges],
          capsuleCheckpointId: payload.capsuleCheckpointId ?? null,
          open: false,
        };
        const index = condensations.indexOf(existing);
        if (index >= 0) condensations[index] = closed;
        condensationIndex.set(payload.compactionId, closed);
      }
      continue;
    }
    if (payload.type === 'completion.decided' && fact.authority === 'authoritative') {
      completion = payload.decision;
    }
  }

  const withoutHash: Omit<ResumeReplayStateV1, 'stateHash'> = {
    schemaVersion: RESUME_REPLAY_STATE_VERSION,
    threadId,
    runIds,
    turnIds,
    lastCursorSequence,
    completion,
    operations: operationOrder.map((key) => operations.get(key)!),
    checkpointIds,
    degradedReasons,
    condensations,
  };
  return {
    ...withoutHash,
    stateHash: sha256Canonical(withoutHash),
  };
}

// ─── P06 recovery classification over replayed facts ────────────────────────

export interface ResumeReplayReportOptions {
  readonly threadId?: string;
  readonly interruptionClass?: InterruptionClass;
  /** True when the log read discarded a torn/corrupt tail line. */
  readonly tornTail?: boolean;
  readonly logReadable?: boolean;
  readonly now?: () => Date;
}

/**
 * Surface indeterminate/pending effects from the replayed state through the
 * existing P06 recovery classification. The report always keeps
 * `automaticResume: false`; an ambiguous mutation stays
 * `operator_reconciliation_required`.
 */
export function buildResumeReplayRestoreReport(
  state: ResumeReplayStateV1,
  options: ResumeReplayReportOptions = {},
): RestoreReport {
  const operations: RestoreOperationEvidence[] = state.operations.map((operation) => {
    const effectClass = (operation.effectClass && EFFECT_CLASSES.has(operation.effectClass)
      ? operation.effectClass
      : 'unknown') as ToolEffectClass;
    const indeterminate = operation.indeterminateReason !== null;
    return {
      operationId: operation.operationId,
      effectClass,
      // Only an explicit settled receipt (an `operation.settled` fact) would
      // count as settled evidence; the hydrated state keeps such facts in
      // `settledReceiptId` without minting admission authority, so nothing is
      // set here and `classifyOperation` decides fail-closed. An
      // `operation.indeterminate` fact becomes an explicit unknown reason.
      unknownReasons: indeterminate ? [`operation_indeterminate:${operation.indeterminateReason}`] : [],
      evidenceRefs: operation.settledReceiptId ? [`receipt:${operation.settledReceiptId}`] : [],
    };
  });
  const readable = options.logReadable !== false;
  const tornTail = options.tornTail === true;
  return buildRestoreReport({
    threadId: options.threadId ?? state.threadId,
    interruptionClass: options.interruptionClass ?? 'process_restart',
    history: {
      readable,
      truncated: tornTail,
      corrupt: !readable,
      reasons: tornTail ? ['runtime_event_log_torn_tail'] : [],
    },
    cursor: {
      journal: 'thread',
      position: state.lastCursorSequence,
    },
    operations,
    diagnostics: [
      ...state.degradedReasons.map((reason) => `context_degraded:${reason}`),
      ...state.checkpointIds.map((id) => `checkpoint_committed:${id}`),
    ],
    ...(options.now ? { now: options.now } : {}),
  });
}

// ─── P11 capsule context (fenced pre-compaction context) ────────────────────

export interface ResumeCapsuleGapV1 {
  readonly kind: 'stale_receipt' | 'incomplete_workspace' | 'incomplete_population' | 'pending_operation';
  readonly ref: string;
  readonly detail: string;
}

export type ResumeCapsuleContextResultV1 =
  | {
      status: 'ready';
      checkpointId: string;
      contextEpoch: string;
      workingState: ContextCheckpointV1['workingStateSnapshot']['state'];
      workspace: ContextCheckpointV1['workspace'];
      observations: ContextCheckpointV1['observation_manifest'];
      gaps: readonly ResumeCapsuleGapV1[];
    }
  | {
      status: 'blocked';
      checkpointId: string | null;
      reasons: readonly ContextCheckpointValidationReasonV1[];
    };

/**
 * Surface the fenced pre-compaction context of a P11 checkpoint capsule for
 * resume. Lineage fencing is delegated to the existing P11 validator — a
 * capsule without a proven installed lineage is blocked, never promoted.
 * Stale receipts and other capsule-internal gaps are surfaced explicitly;
 * they are never silently dropped or repaired here.
 */
export function resumeCapsuleContext(
  capsule: ContextCheckpointV1,
  lineageEvidence?: ContextCheckpointLineageEvidenceV1,
): ResumeCapsuleContextResultV1 {
  const reasons = validateContextCheckpointInstalledLineage(capsule, lineageEvidence);
  if (reasons.length > 0) {
    return { status: 'blocked', checkpointId: capsule.checkpointId ?? null, reasons };
  }

  const gaps: ResumeCapsuleGapV1[] = [];
  // Existing P11 behavior preserved: a receipt the capsule itself marks stale
  // is a gap on resume, not evidence.
  for (const receipt of capsule.receipts ?? []) {
    if (receipt.stale) {
      gaps.push({
        kind: 'stale_receipt',
        ref: receipt.receipt_id,
        detail: `receipt ${receipt.receipt_id} (scope ${receipt.scope}) is marked stale in the capsule`,
      });
    }
  }
  if (capsule.workspace && !capsule.workspace.capture_complete) {
    gaps.push({
      kind: 'incomplete_workspace',
      ref: capsule.workspace.current_snapshot_revision ?? 'none',
      detail: 'capsule workspace capture is incomplete',
    });
  }
  for (const error of capsule.population?.errors ?? []) {
    gaps.push({ kind: 'incomplete_population', ref: 'population', detail: error });
  }
  for (const pending of capsule.pending ?? []) {
    if (pending.state !== 'settled') {
      gaps.push({
        kind: 'pending_operation',
        ref: pending.handle_id,
        detail: `pending ${pending.kind} in state ${pending.state}`,
      });
    }
  }

  return {
    status: 'ready',
    checkpointId: capsule.checkpointId,
    contextEpoch: capsule.contextEpoch,
    workingState: capsule.workingStateSnapshot?.state ?? null,
    workspace: capsule.workspace ?? null,
    observations: capsule.observation_manifest ?? [],
    gaps,
  };
}

// ─── Packet A5: pre-compaction view reconstruction ──────────────────────────

export type PreCompactionReconstructionV1 =
  | {
      status: 'ready';
      compactionId: string;
      /** Real token count recorded by the started fact. */
      countBefore: number;
      /** Real token count recorded by the completed fact. */
      countAfter: number;
      /** Inclusive message ranges the compaction pruned. */
      prunedMessageRanges: ReadonlyArray<PrunedMessageRange>;
      /**
       * Fenced P11 capsule context when the completed fact references a
       * capsule and the caller supplied it; lineage fencing is enforced by
       * the existing P11 validator (a blocked capsule is surfaced, never
       * promoted). `null` when the fact names no capsule or none was supplied.
       */
      capsule: ResumeCapsuleContextResultV1 | null;
      /** Capsule id the completed fact references, when one was fenced. */
      capsuleCheckpointId: string | null;
    }
  | {
      status: 'blocked';
      compactionId: string;
      reason: 'unknown_compaction' | 'incomplete_condensation';
      detail: string;
    };

/**
 * Reconstruct the context view that existed before a mid-run compaction from
 * the fact stream alone (packet A5 task 3). The started fact supplies the
 * pre-compaction token count and the completed fact supplies the pruned
 * ranges plus the fenced P11 capsule id; when the caller also supplies the
 * capsule object, its context is surfaced through the existing lineage
 * fencing. Fail-closed: an unknown compaction, or a started fact without its
 * completed pair (an interrupted compaction), blocks reconstruction instead
 * of approximating.
 */
export function reconstructPreCompactionView(
  facts: readonly RuntimeFactV1[],
  compactionId: string,
  capsule?: ContextCheckpointV1,
  lineageEvidence?: ContextCheckpointLineageEvidenceV1,
): PreCompactionReconstructionV1 {
  let started: Extract<FactPayload, { type: 'context.condensation.started' }> | null = null;
  let completed: Extract<FactPayload, { type: 'context.condensation.completed' }> | null = null;
  for (const fact of facts) {
    const payload = fact?.payload;
    if (payload?.type === 'context.condensation.started' && payload.compactionId === compactionId) {
      started = payload;
      continue;
    }
    if (payload?.type === 'context.condensation.completed' && payload.compactionId === compactionId) {
      completed = payload;
    }
  }
  if (!started) {
    return {
      status: 'blocked',
      compactionId,
      reason: 'unknown_compaction',
      detail: `No context.condensation.started fact for ${compactionId}.`,
    };
  }
  if (!completed) {
    return {
      status: 'blocked',
      compactionId,
      reason: 'incomplete_condensation',
      detail: `Condensation ${compactionId} has a started fact without a completed pair (interrupted compaction).`,
    };
  }
  return {
    status: 'ready',
    compactionId,
    countBefore: completed.countBefore,
    countAfter: completed.countAfter,
    prunedMessageRanges: [...completed.prunedMessageRanges],
    capsuleCheckpointId: completed.capsuleCheckpointId ?? null,
    capsule:
      capsule !== undefined && completed.capsuleCheckpointId !== undefined
        ? resumeCapsuleContext(capsule, lineageEvidence)
        : null,
  };
}

// ─── Log loading ────────────────────────────────────────────────────────────

export type ResumeReplayResultV1 =
  | {
      ok: true;
      path: string;
      state: ResumeReplayStateV1;
      /** Facts discarded by the fail-closed reader (torn/corrupt lines). */
      discarded: number;
      tornTail: boolean;
      restore: RestoreReport;
    }
  | { ok: false; path: string; reason: 'absent' | 'non_monotonic'; detail: string };

/**
 * Read one runtime EventLog, replay it, hydrate the resume state, and classify
 * it through P06. Never throws for log content: absent logs and non-monotonic
 * histories fail closed with `ok:false`; torn tails are discarded (A2
 * semantics) and reported, not surfaced as facts.
 */
export function resumeReplayFromLog(
  path: string,
  options: ResumeReplayReportOptions = {},
): ResumeReplayResultV1 {
  if (!existsSync(path)) {
    return { ok: false, path, reason: 'absent', detail: `No runtime EventLog at ${path}.` };
  }
  const read: RuntimeEventLogReadResult = readRuntimeEventLog(path);
  if (read.records.length === 0) {
    return {
      ok: false,
      path,
      reason: 'absent',
      detail: read.lastError ?? 'Runtime EventLog contains no valid records.',
    };
  }
  const replay = replayEventLogRecords(read.records);
  if (!replay.ok) {
    return { ok: false, path, reason: 'non_monotonic', detail: replay.reason };
  }
  const tornTail = read.tornTail || read.discarded > 0;
  const state = hydrateResumeStateFromFacts(replay.ordered);
  const restore = buildResumeReplayRestoreReport(state, {
    ...options,
    tornTail,
    logReadable: true,
  });
  return {
    ok: true,
    path,
    state,
    discarded: read.discarded,
    tornTail,
    restore,
  };
}

/**
 * Locate a runtime EventLog for a run directory. Bounded, non-recursive
 * probe: the run dir itself, then its `sessions/` and `session/` children.
 * Returns `null` when no log file exists — replay-first callers then fall
 * back (flag-guarded) instead of inventing state.
 */
export function findRuntimeEventLogInRunDir(runDir: string): string | null {
  if (typeof runDir !== 'string' || runDir.length === 0 || !existsSync(runDir)) return null;
  const direct = join(runDir, RUNTIME_EVENT_LOG_FILENAME);
  if (existsSync(direct)) return direct;
  let entries: string[] = [];
  try {
    entries = readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const name of ['sessions', 'session']) {
    if (!entries.includes(name)) continue;
    const child = join(runDir, name);
    const candidate = join(child, RUNTIME_EVENT_LOG_FILENAME);
    if (existsSync(candidate)) return candidate;
    try {
      for (const entry of readdirSync(child, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = join(child, entry.name, RUNTIME_EVENT_LOG_FILENAME);
        if (existsSync(nested)) return nested;
      }
    } catch {
      /* unreadable child: keep probing */
    }
  }
  return null;
}
