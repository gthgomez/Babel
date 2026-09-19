/**
 * P05 durable command admission — contracts.
 *
 * These types define the *record* of admission. They are not an authority
 * source: permission remains solely the authority PDP/wire path, and an
 * admission row is never consulted to allow an action. The admission store
 * exists so the runtime can answer "was this command already admitted, with
 * which semantic inputs, by which owner, and what did it decide?" without
 * repeating side effects.
 *
 * Pure module: no SQLite, no filesystem, no clock. The SQLite-backed store in
 * `admission.ts` consumes these contracts.
 */

import type { BabelMode, ToolEffectClass } from '../executor/contracts.js';
import { validateRuntimeFact, type RuntimeFactV1 } from './events.js';
import { canonicalDigest, cloneJsonSafe, type CloneBudget } from './canonical.js';

/** Version of the durable admission schema and its canonical digest preimage. */
export const ADMISSION_SCHEMA_VERSION = 1 as const;

/** Additive, stable reason codes. Never reordered/removed once published. */
export const ADMISSION_REASONS = {
  /** A record exists for (thread, command) but its canonical digest differs. */
  DIGEST_CONFLICT: 'ADMISSION_DIGEST_CONFLICT',
  /** The semantic inputs could not be canonically encoded; fail closed. */
  DIGEST_UNENCODABLE: 'ADMISSION_DIGEST_UNENCODABLE',
  /** A finalizer's (generation, token) no longer matches the current owner. */
  STALE_OWNER: 'ADMISSION_STALE_OWNER',
  /** No admission exists for (thread, command). */
  NOT_FOUND: 'ADMISSION_NOT_FOUND',
  /** A terminal state already exists and differs from the requested one. */
  ALREADY_SETTLED: 'ADMISSION_ALREADY_SETTLED',
  /** The store is locked, corrupt, unreadable, or from a newer schema. */
  UNAVAILABLE: 'ADMISSION_UNAVAILABLE',
  /** Caller-supplied input failed validation. */
  INVALID_INPUT: 'ADMISSION_INVALID_INPUT',
  /** An injected fault aborted a transaction (test seam; never production). */
  FAULT_INJECTED: 'ADMISSION_FAULT_INJECTED',
} as const;

export type AdmissionReasonCode = (typeof ADMISSION_REASONS)[keyof typeof ADMISSION_REASONS];

export type AdmissionState = 'claimed' | 'settled' | 'aborted' | 'indeterminate';

export type OutboxState = 'intent' | 'committed' | 'failed' | 'indeterminate';

/**
 * Explicit evidence-completeness metadata. An incomplete admission must never
 * yield an authoritative outcome; `complete` is the single fail-closed flag.
 */
export interface AdmissionCompletenessV1 {
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly reasons: readonly string[];
  readonly admittedCount: number;
  readonly droppedCount: number;
  readonly evidenceRefsDropped: number;
}

/** Durable owner of a thread; `(generation, token)` is the fencing key. */
export interface OwnerRecordV1 {
  readonly threadId: string;
  readonly generation: number;
  readonly token: string;
  readonly leaseId?: string;
  readonly baselineId?: string;
  readonly settledAt?: string;
}

/** One durable admission of one command. `outcome` is the serialized terminal response. */
export interface AdmissionRecordV1 {
  readonly admissionId: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly digest: string;
  readonly ownerGeneration: number;
  readonly state: AdmissionState;
  readonly outcome?: unknown;
  readonly completeness: AdmissionCompletenessV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One side effect staged atomically with its admission. */
export interface OutboxRecordV1 {
  readonly outboxId: string;
  readonly admissionId: string;
  readonly effectClass: ToolEffectClass;
  readonly operationId: string;
  readonly state: OutboxState;
  readonly preImageHashes?: Record<string, string>;
  readonly postImageHashes?: Record<string, string>;
  readonly error?: string;
}

/**
 * Semantic admission inputs. The canonical digest covers exactly these fields,
 * so two calls with the same semantic inputs dedupe and a changed payload under
 * the same command id is rejected. Must never include wall clock, nonce, pid, or
 * input ordering.
 */
export interface CommandDigestInput {
  readonly threadId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly mode: BabelMode;
  readonly resolvedOperationPolicy: unknown;
  readonly taskShapeClass: string;
  readonly targetRoot: string;
  readonly offeredToolSchemaVersion: string;
  readonly contextSnapshotId: string;
  /** Canonical encoding of the admitted command + facts. */
  readonly payload: unknown;
}

/**
 * Snapshot the semantic inputs into a detached, immutable JSON tree and compute
 * its canonical digest. Returns `null` when an input is not canonically
 * encodable (caller must reject `ADMISSION_DIGEST_UNENCODABLE` rather than
 * reuse a lossy key). The snapshot is what gets persisted — never a live object.
 */
export function snapshotAdmissionInput(
  input: CommandDigestInput,
): { ok: true; snapshot: unknown; digest: string } | { ok: false } {
  let snapshot: unknown;
  try {
    const budget: CloneBudget = { nodes: 0 };
    const cloned = cloneJsonSafe(
      {
        schemaVersion: ADMISSION_SCHEMA_VERSION,
        threadId: input.threadId,
        taskId: input.taskId,
        commandId: input.commandId,
        mode: input.mode,
        resolvedOperationPolicy: input.resolvedOperationPolicy,
        taskShapeClass: input.taskShapeClass,
        targetRoot: input.targetRoot,
        offeredToolSchemaVersion: input.offeredToolSchemaVersion,
        contextSnapshotId: input.contextSnapshotId,
        payload: input.payload,
      },
      new WeakSet(),
      0,
      budget,
    );
    if (!cloned.ok) return { ok: false };
    snapshot = cloned.value;
  } catch {
    return { ok: false };
  }
  const digest = canonicalDigest(snapshot);
  if (digest === null) return { ok: false };
  return { ok: true, snapshot, digest };
}

/**
 * SHA-256 over the injective canonical encoding of the semantic inputs, or
 * `null` when an input is not canonically encodable.
 */
export function computeAdmissionDigest(input: CommandDigestInput): string | null {
  const result = snapshotAdmissionInput(input);
  return result.ok ? result.digest : null;
}

/** A complete admission with no truncation and no dropped evidence. */
export function completeCompleteness(admittedCount: number): AdmissionCompletenessV1 {
  return {
    complete: true,
    truncated: false,
    reasons: [],
    admittedCount,
    droppedCount: 0,
    evidenceRefsDropped: 0,
  };
}

/** Build an explicit incomplete-completeness record. */
export function incompleteCompleteness(input: {
  reasons: readonly string[];
  admittedCount: number;
  droppedCount: number;
  evidenceRefsDropped?: number;
  truncated?: boolean;
}): AdmissionCompletenessV1 {
  return {
    complete: false,
    truncated: input.truncated ?? false,
    reasons: [...new Set(input.reasons)].sort(),
    admittedCount: input.admittedCount,
    droppedCount: input.droppedCount,
    evidenceRefsDropped: input.evidenceRefsDropped ?? 0,
  };
}

/** Merge two completeness records, taking the strictest (incomplete) union. */
export function mergeCompleteness(
  a: AdmissionCompletenessV1,
  b: AdmissionCompletenessV1,
): AdmissionCompletenessV1 {
  return {
    complete: a.complete && b.complete,
    truncated: a.truncated || b.truncated,
    reasons: [...new Set([...a.reasons, ...b.reasons])].sort(),
    admittedCount: a.admittedCount + b.admittedCount,
    droppedCount: a.droppedCount + b.droppedCount,
    evidenceRefsDropped: a.evidenceRefsDropped + b.evidenceRefsDropped,
  };
}

/** Whether an outcome derived from this admission may claim authority. */
export function isAuthoritativeAdmission(completeness: AdmissionCompletenessV1): boolean {
  return completeness.complete && !completeness.truncated;
}

// ─── Bounded, immutable fact admission ──────────────────────────────────────

/** Bound serialized fact admission before it reaches the reducer. */
export interface AdmissionFactBounds {
  readonly maxFacts: number;
  readonly maxTieGroup: number;
  readonly maxJsonNodes: number;
  readonly maxTotalJsonNodes: number;
  readonly maxEvidenceRefs: number;
}

export const DEFAULT_ADMISSION_FACT_BOUNDS: AdmissionFactBounds = {
  maxFacts: 100_000,
  maxTieGroup: 32,
  maxJsonNodes: 100_000,
  maxTotalJsonNodes: 2_000_000,
  maxEvidenceRefs: 10_000,
};

export interface BoundedFactsResult {
  /** Detached, validated snapshots in deterministic (sequence, id) order. */
  readonly facts: RuntimeFactV1[];
  readonly completeness: AdmissionCompletenessV1;
  /** Ids quarantined because a duplicate identity carried conflicting content. */
  readonly quarantinedFactIds: string[];
}

type SnapshotResult = { ok: true; fact: RuntimeFactV1; nodes: number } | { ok: false; reason: string };

/** Clone, bound, and ingress-validate one raw fact into an immutable snapshot. */
function snapshotAdmissionFact(raw: unknown, bounds: AdmissionFactBounds): SnapshotResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'fact_not_object' };
  try {
    const budget: CloneBudget = { nodes: 0 };
    const cloned = cloneJsonSafe(raw, new WeakSet(), 0, budget);
    if (!cloned.ok) return { ok: false, reason: 'unserializable_fact' };
    if (budget.nodes > bounds.maxJsonNodes) return { ok: false, reason: 'unserializable_fact' };
    const validation = validateRuntimeFact(cloned.value);
    if (!validation.ok) return { ok: false, reason: `invalid_fact:${validation.reason}` };
    return { ok: true, fact: validation.fact, nodes: budget.nodes };
  } catch {
    return { ok: false, reason: 'inaccessible_fact' };
  }
}

/**
 * Truncate an over-cap evidence-ref list. Returns the normalized fact and the
 * number of dropped refs, or `null` when the list is within bounds. A truncated
 * list demotes the fact to an observation so incomplete evidence can never claim
 * authority.
 */
function truncateEvidenceRefs(
  fact: RuntimeFactV1,
  max: number,
): { fact: RuntimeFactV1; dropped: number } | null {
  if (fact.payload.type !== 'completion.decided') return null;
  const refs = fact.payload.decision.evidenceRefs;
  if (refs.length <= max) return null;
  return {
    fact: {
      ...fact,
      authority: 'observation',
      payload: {
        ...fact.payload,
        decision: { ...fact.payload.decision, evidenceRefs: refs.slice(0, max) },
      },
    },
    dropped: refs.length - max,
  };
}

/**
 * Bound, validate and deduplicate facts at the admission boundary.
 *
 * Deterministic under input-order permutations: facts are grouped by the
 * projection's `(sequence, id)` identity, then each *whole* group is either kept
 * or quarantined. A group with conflicting content is dropped in full and its
 * ids are reported — the order-first winner is never allowed to keep authority
 * (this closes the P04 `dedupeByFactId` residual). Invalid, unserializable, or
 * over-budget facts are dropped and recorded in `completeness`; an over-cap
 * evidence-ref list is truncated and its fact is demoted to an observation so
 * no incomplete evidence can claim authority.
 */
export function boundAdmissionFacts(
  input: Iterable<RuntimeFactV1>,
  bounds: AdmissionFactBounds = DEFAULT_ADMISSION_FACT_BOUNDS,
): BoundedFactsResult {
  const reasons: string[] = [];
  const quarantined = new Set<string>();
  let admittedCount = 0;
  let droppedCount = 0;
  let evidenceRefsDropped = 0;
  let truncated = false;

  interface Group {
    readonly sequence: number;
    readonly id: string;
    readonly members: Array<{ fact: RuntimeFactV1; nodes: number }>;
    readonly contentKeys: Set<string>;
  }
  const groups = new Map<string, Group>();
  let seen = 0;
  try {
    for (const raw of input) {
      seen += 1;
      if (seen > bounds.maxFacts) {
        reasons.push('fact_count_exceeded');
        truncated = true;
        droppedCount += 1; // lower bound: the unread tail is unknown but non-empty here
        break;
      }
      const snapshot = snapshotAdmissionFact(raw, bounds);
      if (!snapshot.ok) {
        droppedCount += 1;
        reasons.push(snapshot.reason);
        continue;
      }
      let { fact, nodes } = snapshot;
      const truncatedRefs = truncateEvidenceRefs(fact, bounds.maxEvidenceRefs);
      if (truncatedRefs) {
        evidenceRefsDropped += truncatedRefs.dropped;
        reasons.push('evidence_refs_truncated');
        truncated = true;
        fact = truncatedRefs.fact;
      }
      const key = `${fact.sequence}\u0000${fact.id}`;
      const contentKey = canonicalDigest(fact);
      const group = groups.get(key);
      if (group) {
        group.members.push({ fact, nodes });
        if (contentKey !== null) group.contentKeys.add(contentKey);
      } else {
        groups.set(key, {
          sequence: fact.sequence,
          id: fact.id,
          members: [{ fact, nodes }],
          contentKeys: new Set(contentKey !== null ? [contentKey] : []),
        });
      }
    }
  } catch {
    reasons.push('fact_iteration_failed');
    truncated = true;
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const facts: RuntimeFactV1[] = [];
  let totalNodes = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const group = ordered[index]!;
    if (group.members.length > bounds.maxTieGroup) {
      reasons.push('tie_group_exceeded');
      quarantined.add(group.id);
      droppedCount += group.members.length;
      continue;
    }
    if (group.contentKeys.size > 1) {
      // Conflicting duplicate identity: quarantine the whole group so no
      // order-first winner keeps authority. Deterministic under permutations.
      reasons.push('conflicting_duplicate_fact');
      quarantined.add(group.id);
      droppedCount += group.members.length;
      continue;
    }
    const member = group.members[0]!;
    if (totalNodes + member.nodes > bounds.maxTotalJsonNodes) {
      reasons.push('projection_budget_exceeded');
      truncated = true;
      for (let rest = index; rest < ordered.length; rest += 1) {
        const restGroup = ordered[rest]!;
        droppedCount += restGroup.members.length;
        quarantined.add(restGroup.id);
      }
      break;
    }
    totalNodes += member.nodes;
    facts.push(member.fact);
    admittedCount += 1;
  }

  const completeness: AdmissionCompletenessV1 =
    reasons.length === 0
      ? completeCompleteness(admittedCount)
      : incompleteCompleteness({
          reasons,
          admittedCount,
          droppedCount,
          evidenceRefsDropped,
          truncated,
        });

  return {
    facts,
    completeness,
    quarantinedFactIds: [...quarantined].sort(),
  };
}
