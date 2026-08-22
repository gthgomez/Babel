/**
 * SearchEpisode V0 — candidate lineage + score receipts (SEARCH_EPISODES_V0 B1).
 *
 * Additive module: not wired into chat/pipeline behavior yet. Authority model
 * lives in docs/architecture/SEARCH_EPISODES_V0.md: agents propose candidates,
 * controllers promote them, and every evaluation binds immutable
 * VerifierReceiptV2 evidence. Candidate IDs are immutable after creation.
 */

import { randomUUID } from 'node:crypto';
import type { WorkspaceRevisionIdentity } from '../executor/contracts.js';

export const SEARCH_EPISODE_VERSION = 0 as const;

export type CandidateStatus =
  | 'working'
  | 'rejected'
  | 'promoted'
  | 'best'
  | 'superseded';

/** Runtime membership set for CandidateStatus (fold-time validation). */
export const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  'working',
  'rejected',
  'promoted',
  'best',
  'superseded',
];

/** Sentinel base ref for promoted_from edges when a candidate has no parent. */
export const LINEAGE_ROOT_REF = 'root' as const;

export interface ScoreVector {
  /** Named domain metrics, e.g. throughput_tops or tests_failed. */
  metrics: Record<string, number>;
  /** Direction per metric name; must cover every key in metrics. */
  higher_is_better: Record<string, boolean>;
}

/** Binds an evaluation of one candidate to immutable verifier evidence. */
export interface ScoreReceipt {
  schema_version: typeof SEARCH_EPISODE_VERSION;
  receipt_id: string;
  candidate_id: string;
  /** Receipt ids from the verifier kernel backing this score. */
  verifier_receipt_ids: string[];
  score_vector: ScoreVector;
  correct: boolean;
  evaluated_at: string;
  evaluator_profile: string;
}

export interface Candidate {
  schema_version: typeof SEARCH_EPISODE_VERSION;
  /** Immutable once created. */
  candidate_id: string;
  parent_candidate_id?: string;
  workspace_revision: WorkspaceRevisionIdentity | { compositeTreeHash: string };
  /** Diffs/patch refs relative to the parent revision. */
  mutation_refs: string[];
  hypothesis_id?: string;
  /** Every evaluation ever recorded for this candidate. */
  receipts: ScoreReceipt[];
  status: CandidateStatus;
  created_at: string;
}

/**
 * Dedicated lineage semantics — deliberately stricter than generic
 * derivation vocabularies (see SEARCH_EPISODES_V0 section 3.2).
 */
export type LineageEdgeKind =
  | 'parent_of'
  | 'forked_from'
  | 'promoted_from'
  | 'supersedes'
  | 'evaluated_by'
  | 'score_receipt'
  | 'rejected_because';

/** Runtime membership set for LineageEdgeKind (fold-time validation). */
export const LINEAGE_EDGE_KINDS: readonly LineageEdgeKind[] = [
  'parent_of',
  'forked_from',
  'promoted_from',
  'supersedes',
  'evaluated_by',
  'score_receipt',
  'rejected_because',
];

export interface LineageEdge {
  schema_version: typeof SEARCH_EPISODE_VERSION;
  edge_id: string;
  kind: LineageEdgeKind;
  from_ref: string;
  to_ref: string;
  reason?: string;
  created_at: string;
}

export interface HypothesisRecord {
  hypothesis_id: string;
  claim: string;
  /** Groups related hypotheses so basin lock-in is detectable. */
  family_id: string;
  evidence_for: string[];
  evidence_against: string[];
  disposition: 'open' | 'supported' | 'disproven' | 'abandoned';
}

export interface PlateauMetrics {
  consecutive_non_improving: number;
  best_score_age_evals: number;
  distinct_failure_mechanisms: string[];
  hypothesis_family_repeats: number;
  window_score_delta: number;
}

export interface SearchState {
  current_best?: string;
  current_strategy: string;
  bottleneck?: string;
  plateau_metrics: PlateauMetrics;
  unexplored_directions: string[];
}

export interface SupervisorDirection {
  rationale: string;
  evidence_refs: string[];
  falsification_experiment: string;
}

/** Read-only adviser output; carries no authority (see V0 section 5). */
export interface SupervisorEvent {
  event_id: string;
  created_at: string;
  diagnosis: string;
  directions: SupervisorDirection[];
}

export interface SearchBudget {
  max_evaluations?: number;
  max_wallclock_ms?: number;
}

export interface SearchEpisode {
  schema_version: typeof SEARCH_EPISODE_VERSION;
  episode_id: string;
  /** Links this episode to a frozen TaskContractV1. */
  task_contract_id: string;
  objective: string;
  knowledge_pack_refs: string[];
  budget: SearchBudget;
  candidates: Candidate[];
  lineage_edges: LineageEdge[];
  hypotheses: HypothesisRecord[];
  search_state: SearchState;
  supervisor_events: SupervisorEvent[];
  created_at: string;
}

export function newEpisodeId(): string {
  return `ep_${randomUUID()}`;
}

export function newCandidateId(): string {
  return `cand_${randomUUID()}`;
}

export function newScoreReceiptId(): string {
  return `sr_${randomUUID()}`;
}

export function newLineageEdgeId(): string {
  return `edge_${randomUUID()}`;
}

export function newHypothesisId(): string {
  return `hyp_${randomUUID()}`;
}

export function newSupervisorEventId(): string {
  return `sev_${randomUUID()}`;
}

export interface CreateSearchEpisodeInput {
  task_contract_id: string;
  objective: string;
  knowledge_pack_refs?: string[] | undefined;
  budget?: SearchBudget | undefined;
  current_strategy?: string | undefined;
}

export function createSearchEpisode(input: CreateSearchEpisodeInput): SearchEpisode {
  return {
    schema_version: SEARCH_EPISODE_VERSION,
    episode_id: newEpisodeId(),
    task_contract_id: input.task_contract_id,
    objective: input.objective,
    knowledge_pack_refs: input.knowledge_pack_refs ?? [],
    budget: input.budget ?? {},
    candidates: [],
    lineage_edges: [],
    hypotheses: [],
    search_state: {
      current_strategy: input.current_strategy ?? 'unassigned',
      plateau_metrics: {
        consecutive_non_improving: 0,
        best_score_age_evals: 0,
        distinct_failure_mechanisms: [],
        hypothesis_family_repeats: 0,
        window_score_delta: 0,
      },
      unexplored_directions: [],
    },
    supervisor_events: [],
    created_at: new Date().toISOString(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when every metric direction is declared and values are finite. */
export function validateScoreVector(sv: ScoreVector): string[] {
  if (!isPlainObject(sv)) return ['score vector payload is not an object'];
  if (!isPlainObject(sv.metrics)) {
    return ['score vector metrics must be an object'];
  }
  if (!isPlainObject(sv.higher_is_better)) {
    return ['score vector higher_is_better must be an object'];
  }
  const errors: string[] = [];
  for (const [name, value] of Object.entries(sv.metrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`metric ${name} is not finite`);
    }
    if (typeof sv.higher_is_better[name] !== 'boolean') {
      errors.push(`metric ${name} has no declared direction`);
    }
  }
  return errors;
}

export function validateScoreReceipt(r: ScoreReceipt): string[] {
  if (!isPlainObject(r)) return ['score receipt payload is not an object'];
  if (r.schema_version !== SEARCH_EPISODE_VERSION) {
    return ['schema_version mismatch'];
  }
  const errors: string[] = [];
  if (typeof r.receipt_id !== 'string' || r.receipt_id.length === 0) {
    errors.push('receipt_id required');
  }
  if (typeof r.candidate_id !== 'string' || r.candidate_id.length === 0) {
    errors.push('candidate_id required');
  }
  if (
    !Array.isArray(r.verifier_receipt_ids) ||
    r.verifier_receipt_ids.length === 0
  ) {
    errors.push('at least one verifier receipt id is required');
  } else if (
    r.verifier_receipt_ids.some(
      (id) => typeof id !== 'string' || id.length === 0,
    )
  ) {
    errors.push('verifier receipt ids must be non-empty strings');
  }
  if (typeof r.correct !== 'boolean') errors.push('correct must be boolean');
  if (typeof r.evaluated_at !== 'string' || r.evaluated_at.length === 0) {
    errors.push('evaluated_at required');
  }
  if (
    typeof r.evaluator_profile !== 'string' ||
    r.evaluator_profile.length === 0
  ) {
    errors.push('evaluator_profile required');
  }
  const vectorErrors = validateScoreVector(r.score_vector);
  if (vectorErrors.length > 0) {
    errors.push(...vectorErrors.map((e) => `score_vector: ${e}`));
  }
  return errors;
}

/**
 * current_best ↔ folded-status consistency invariant (Wave-A M1 fix).
 *
 * Report-only by contract: the fold replays records deterministically and
 * never throws on these findings; validateSearchEpisode surfaces them so a
 * dangling crown written by ANY writer (including pre-fix unconditional
 * rejectors replayed from JSONL) is detectable after load instead of
 * aborting mid-fold.
 *
 * Rules:
 * - current_best, when set, must reference a candidate whose folded status
 *   is 'best'.
 * - Every 'best'-status candidate must be exactly the candidate current_best
 *   points at (no rival crowns, no orphaned best).
 */
export function validateCurrentBestConsistency(ep: SearchEpisode): string[] {
  if (!isPlainObject(ep) || !isPlainObject(ep.search_state)) return [];
  const currentBest = ep.search_state.current_best;
  const candidates = Array.isArray(ep.candidates) ? ep.candidates : [];
  const bestIds: string[] = [];
  const statusById = new Map<string, CandidateStatus>();
  for (const c of candidates) {
    if (!isPlainObject(c) || typeof c.candidate_id !== 'string') continue;
    if (
      typeof c.status === 'string' &&
      CANDIDATE_STATUSES.includes(c.status as CandidateStatus)
    ) {
      statusById.set(c.candidate_id, c.status as CandidateStatus);
      if (c.status === 'best') bestIds.push(c.candidate_id);
    }
  }
  const problems: string[] = [];
  if (currentBest !== undefined) {
    const ref = String(currentBest);
    const status = statusById.get(ref);
    if (status !== undefined && status !== 'best') {
      problems.push(
        `current_best ${ref} references candidate with status '${status}', expected 'best'`,
      );
    }
    for (const id of bestIds) {
      if (id !== ref) {
        problems.push(
          `candidate ${id} has status 'best' but current_best is ${ref}`,
        );
      }
    }
  } else {
    for (const id of bestIds) {
      problems.push(
        `candidate ${id} has status 'best' but search_state.current_best is unset`,
      );
    }
  }
  return problems;
}

export function validateSearchEpisode(ep: SearchEpisode): string[] {
  if (!isPlainObject(ep)) return ['search episode payload is not an object'];
  if (ep.schema_version !== SEARCH_EPISODE_VERSION) {
    return ['unsupported schema_version'];
  }
  const errors: string[] = [];
  if (typeof ep.episode_id !== 'string' || ep.episode_id.length === 0) {
    errors.push('episode_id required');
  }
  if (
    typeof ep.task_contract_id !== 'string' ||
    ep.task_contract_id.length === 0
  ) {
    errors.push('task_contract_id required');
  }
  if (typeof ep.objective !== 'string' || ep.objective.length === 0) {
    errors.push('objective required');
  }
  if (
    !Array.isArray(ep.candidates) ||
    !Array.isArray(ep.lineage_edges) ||
    !Array.isArray(ep.hypotheses) ||
    !Array.isArray(ep.supervisor_events)
  ) {
    errors.push('episode collections must be arrays');
    return errors;
  }

  const byId = new Map<string, Candidate>();
  const receiptIds = new Set<string>();
  for (const c of ep.candidates) {
    if (!isPlainObject(c)) {
      errors.push('candidate entries must be objects');
      continue;
    }
    if (typeof c.candidate_id !== 'string' || c.candidate_id.length === 0) {
      errors.push('candidate_id required');
      continue;
    }
    if (byId.has(c.candidate_id)) {
      errors.push(`duplicate candidate ${c.candidate_id}`);
    } else {
      byId.set(c.candidate_id, c);
    }
    if (!CANDIDATE_STATUSES.includes(c.status)) {
      errors.push(`candidate ${c.candidate_id} has unknown status`);
    }
    if (!Array.isArray(c.receipts)) {
      errors.push(`candidate ${c.candidate_id} receipts must be an array`);
      continue;
    }
    for (const r of c.receipts) {
      for (const e of validateScoreReceipt(r)) {
        errors.push(`candidate ${c.candidate_id} receipt: ${e}`);
      }
      if (isPlainObject(r) && r.receipt_id !== undefined) {
        if (receiptIds.has(r.receipt_id as string)) {
          errors.push(`duplicate score receipt ${String(r.receipt_id)}`);
        }
        receiptIds.add(r.receipt_id as string);
        if (r.candidate_id !== c.candidate_id) {
          errors.push(
            `candidate ${c.candidate_id} holds receipt for ${String(r.candidate_id)}`,
          );
        }
      }
    }
    if (
      c.status === 'working' &&
      Array.isArray(c.receipts) &&
      c.receipts.some((r) => r.correct === false)
    ) {
      errors.push(`candidate ${c.candidate_id} is working despite failed evaluation`);
    }
  }
  for (const c of ep.candidates) {
    if (!isPlainObject(c)) continue;
    if (
      c.parent_candidate_id !== undefined &&
      !byId.has(c.parent_candidate_id)
    ) {
      errors.push(`candidate ${c.candidate_id} references unknown parent`);
    }
  }
  // Parent chains must be acyclic: walk each chain with a path-local set.
  for (const c of ep.candidates) {
    if (!isPlainObject(c)) continue;
    const chain = new Set<string>([c.candidate_id]);
    let cur = c.parent_candidate_id;
    while (cur !== undefined) {
      if (chain.has(cur)) {
        errors.push(`candidate ${c.candidate_id} parent chain contains a cycle at ${cur}`);
        break;
      }
      chain.add(cur);
      cur = byId.get(cur)?.parent_candidate_id;
    }
  }

  const edgeIds = new Set<string>();
  for (const e of ep.lineage_edges) {
    if (!isPlainObject(e)) {
      errors.push('lineage edge entries must be objects');
      continue;
    }
    if (typeof e.edge_id !== 'string' || e.edge_id.length === 0) {
      errors.push('lineage edge edge_id required');
      continue;
    }
    if (edgeIds.has(e.edge_id)) {
      errors.push(`duplicate lineage edge ${e.edge_id}`);
    }
    edgeIds.add(e.edge_id);
    if (!LINEAGE_EDGE_KINDS.includes(e.kind)) {
      errors.push(`lineage edge ${e.edge_id} has unknown kind`);
      continue;
    }
    if (
      typeof e.from_ref !== 'string' ||
      e.from_ref.length === 0 ||
      typeof e.to_ref !== 'string' ||
      e.to_ref.length === 0
    ) {
      errors.push(`lineage edge ${e.edge_id} requires non-empty refs`);
      continue;
    }
    switch (e.kind) {
      case 'parent_of':
      case 'forked_from':
        if (!byId.has(e.from_ref) || !byId.has(e.to_ref)) {
          errors.push(`lineage edge ${e.edge_id} references unknown candidate`);
        }
        break;
      case 'promoted_from':
        if (!byId.has(e.from_ref)) {
          errors.push(
            `lineage edge ${e.edge_id} references unknown promoted candidate ${e.from_ref}`,
          );
        }
        if (e.to_ref !== LINEAGE_ROOT_REF && !byId.has(e.to_ref)) {
          errors.push(
            `lineage edge ${e.edge_id} references unknown promotion base ${e.to_ref}`,
          );
        }
        break;
      case 'supersedes': {
        const target = byId.get(e.to_ref);
        if (target === undefined) {
          errors.push(
            `supersedes edge ${e.edge_id} references unknown displaced candidate ${e.to_ref}`,
          );
        } else if (
          target.status !== 'best' &&
          target.status !== 'superseded' &&
          target.status !== 'promoted'
        ) {
          errors.push(
            `supersedes edge ${e.edge_id} targets non-promoted candidate ${e.to_ref}`,
          );
        }
        if (!byId.has(e.from_ref)) {
          errors.push(
            `supersedes edge ${e.edge_id} references unknown successor ${e.from_ref}`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  if (
    isPlainObject(ep.search_state) &&
    ep.search_state.current_best !== undefined &&
    !byId.has(ep.search_state.current_best)
  ) {
    errors.push('current_best references unknown candidate');
  }
  errors.push(...validateCurrentBestConsistency(ep));
  for (const ev of ep.supervisor_events) {
    if (!isPlainObject(ev)) {
      errors.push('supervisor event entries must be objects');
      continue;
    }
    if (!Array.isArray(ev.directions) || ev.directions.length < 2 || ev.directions.length > 5) {
      errors.push(`supervisor event ${String(ev.event_id)} must propose 2-5 directions`);
    }
  }
  return errors;
}

/**
 * Deterministic partial-order dominance used by controller promotion policy.
 *
 * Wave-1 rule (documented in SEARCH_EPISODES_V0 "Wave-1 hardening notes"):
 * compare over the UNION of metric names. `a` dominates `b` only when every
 * metric is at least as good under its declared direction and at least one is
 * strictly better. A metric missing from either side, an undeclared direction,
 * or a non-finite value makes the pair incomparable (returns false) rather
 * than being silently ignored. Ties dominate nothing; empty vectors are
 * incomparable with everything.
 */
export function scoreDominates(a: ScoreVector, b: ScoreVector): boolean {
  const names = new Set([
    ...Object.keys(a.metrics),
    ...Object.keys(b.metrics),
  ]);
  let anyBetter = false;
  for (const name of names) {
    const av = a.metrics[name];
    const bv = b.metrics[name];
    if (av === undefined || bv === undefined) return false;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
    const higherA = a.higher_is_better[name];
    const higherB = b.higher_is_better[name];
    if (typeof higherA !== 'boolean' || typeof higherB !== 'boolean' || higherA !== higherB) {
      return false;
    }
    if (higherA ? av < bv : av > bv) return false;
    if (higherA ? av > bv : av < bv) anyBetter = true;
  }
  return anyBetter;
}
