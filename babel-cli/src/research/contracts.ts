/**
 * research/contracts.ts — Versioned Zod contracts for Repo Hunt research missions
 *
 * Slice A of the Repo Hunt campaign. Defines the durable research artifacts:
 * ResearchMissionV1, QueryPlan (search hypotheses), candidate records,
 * EvidenceRefV1, and PatternCardV1, plus the RepositoryResearchProvider
 * interface that keeps remote providers (GitHub first) from leaking into
 * the research domain.
 *
 * Trust model (see docs/adr/ADR-research-repo-hunt.md): remote repository
 * content is untrusted data. It enters the domain only as validated
 * structured records pinned to exact commits; it never becomes policy,
 * instructions, or authority. The evidence-state ladder is owned here —
 * a claim may only advance past SOURCE_CONFIRMED through deterministic
 * validation performed by host code (evidenceValidator, Slice C).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Evidence states
// ---------------------------------------------------------------------------

/**
 * Evidence-state ladder for research claims. Order matters: states are
 * listed in ascending authority. Transitions are host-enforced:
 * DISCOVERED -> SOURCE_CONFIRMED requires deterministic evidence
 * validation; later states are produced by dedicated stages (local
 * applicability, experiment runner, independent review), never inferred
 * by a model.
 */
export const EVIDENCE_STATES = [
  'DISCOVERED',
  'SOURCE_CONFIRMED',
  'LOCALLY_APPLICABLE_HYPOTHESIS',
  'EXPERIMENTALLY_SUPPORTED',
  'INDEPENDENTLY_REVIEWED',
] as const;

export const EvidenceStateSchema = z.enum(EVIDENCE_STATES);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

// ---------------------------------------------------------------------------
// Mission budgets
// ---------------------------------------------------------------------------

export const MissionBudgetSchema = z
  .object({
    max_search_queries: z.number().int().nonnegative(),
    max_candidates: z.number().int().nonnegative(),
    max_enriched_candidates: z.number().int().nonnegative(),
    max_deep_reads: z.number().int().nonnegative(),
    max_files_per_repo: z.number().int().nonnegative(),
    max_remote_bytes: z.number().int().nonnegative(),
    max_model_calls: z.number().int().nonnegative(),
  })
  .strict();
export type MissionBudget = z.infer<typeof MissionBudgetSchema>;

/** Named budget presets resolved at mission creation and recorded in the receipt. */
export const BUDGET_PRESETS = ['low', 'normal', 'deep'] as const;
export type BudgetPresetName = (typeof BUDGET_PRESETS)[number];

export const BUDGET_PRESET_VALUES: Record<BudgetPresetName, MissionBudget> = {
  low: {
    max_search_queries: 8,
    max_candidates: 150,
    max_enriched_candidates: 20,
    max_deep_reads: 3,
    max_files_per_repo: 8,
    max_remote_bytes: 2_000_000,
    max_model_calls: 8,
  },
  normal: {
    max_search_queries: 16,
    max_candidates: 500,
    max_enriched_candidates: 50,
    max_deep_reads: 10,
    max_files_per_repo: 15,
    max_remote_bytes: 10_000_000,
    max_model_calls: 20,
  },
  deep: {
    max_search_queries: 32,
    max_candidates: 1200,
    max_enriched_candidates: 120,
    max_deep_reads: 25,
    max_files_per_repo: 30,
    max_remote_bytes: 40_000_000,
    max_model_calls: 45,
  },
};

// ---------------------------------------------------------------------------
// ResearchMissionV1
// ---------------------------------------------------------------------------

export const ResearchMissionProblemSchema = z
  .object({
    statement: z.string().min(1),
    /** Populated by the model-side mission refinement in a later slice; empty at deterministic creation. */
    desired_outcome: z.string(),
    failure_modes: z.array(z.string()),
    constraints: z.array(z.string()),
    non_goals: z.array(z.string()),
  })
  .strict();

export const ResearchMissionTargetSchema = z
  .object({
    project_root: z.string().min(1),
    head_sha: z.string().nullable(),
    repo_map_digest: z.string().nullable(),
  })
  .strict();

export const MissionSourcePolicySchema = z
  .object({
    providers: z.array(z.literal('github')).min(1),
    execute_foreign_code: z.literal(false),
    allow_repository_mutation: z.literal(false),
  })
  .strict();

export const ResearchMissionV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    mission_id: z.string().min(1),
    mission_kind: z.literal('solution_hunt'),
    created_at: z.string().min(1),
    problem: ResearchMissionProblemSchema,
    target: ResearchMissionTargetSchema,
    budget: MissionBudgetSchema,
    budget_preset: z.enum(BUDGET_PRESETS),
    source_policy: MissionSourcePolicySchema,
  })
  .strict();
export type ResearchMissionV1 = z.infer<typeof ResearchMissionV1Schema>;

// ---------------------------------------------------------------------------
// Query plan
// ---------------------------------------------------------------------------

export const SEARCH_HYPOTHESIS_CATEGORIES = [
  'direct_terminology',
  'mechanism',
  'failure_symptom',
  'architectural_analogue',
  'source_signature',
] as const;

export const SearchHypothesisSchema = z
  .object({
    id: z.string().min(1),
    query: z.string().min(1),
    category: z.enum(SEARCH_HYPOTHESIS_CATEGORIES),
    rationale: z.string().min(1),
    expected_signal: z.string().min(1),
    exclusions: z.array(z.string()),
  })
  .strict();
export type SearchHypothesis = z.infer<typeof SearchHypothesisSchema>;

export const QueryPlanV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    mission_id: z.string().min(1),
    hypotheses: z.array(SearchHypothesisSchema).min(1),
  })
  .strict();
export type QueryPlanV1 = z.infer<typeof QueryPlanV1Schema>;

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** Stable identity for a discovered repository. Never key dedup on full_name alone. */
export const RepositoryIdentitySchema = z
  .object({
    /** Provider-assigned stable id (GitHub repository id / node id). */
    provider_repo_id: z.string().min(1),
    provider: z.literal('github'),
    observed_full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    /** Source repo for forks; null when the repo is not a fork. */
    parent_provider_repo_id: z.string().nullable(),
    default_branch: z.string().nullable(),
    observed_at: z.string().min(1),
  })
  .strict();
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;

/** A repository discovered by one or more hypotheses, before/after triage. */
export const CandidateRecordV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    candidate_id: z.string().min(1),
    identity: RepositoryIdentitySchema,
    /** Hypothesis ids that surfaced this candidate (query-hit coverage). */
    matched_hypothesis_ids: z.array(z.string()).min(1),
    description: z.string().nullable(),
    language: z.string().nullable(),
    topics: z.array(z.string()),
    archived: z.boolean(),
    /** Weak ranking context only — never the primary signal. */
    stars: z.number().int().nonnegative(),
    forks: z.number().int().nonnegative(),
    pushed_at: z.string().nullable(),
    license_spdx_id: z.string().nullable(),
    is_fork: z.boolean(),
  })
  .strict();
export type CandidateRecordV1 = z.infer<typeof CandidateRecordV1Schema>;

/**
 * Deterministic triage output. Every score contribution is retained so
 * `babel research inspect` can explain why a candidate survived.
 */
export const TriageScoreBreakdownSchema = z
  .object({
    candidate_id: z.string().min(1),
    /** Named contribution -> points. Sums to the total before penalties. */
    contributions: z.array(z.object({ factor: z.string().min(1), points: z.number() }).strict()),
    penalties: z.array(z.object({ factor: z.string().min(1), points: z.number() }).strict()),
    total: z.number(),
  })
  .strict();
export type TriageScoreBreakdown = z.infer<typeof TriageScoreBreakdownSchema>;

// ---------------------------------------------------------------------------
// EvidenceRefV1
// ---------------------------------------------------------------------------

export const ACQUISITION_METHODS = ['github_contents', 'github_blob', 'partial_clone'] as const;

export const EvidenceRefV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    evidence_id: z.string().min(1),
    repository_id: z.string().min(1),
    repository_full_name: z.string().min(1),
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/, 'commit_sha must be a full 40-hex SHA'),
    path: z.string().min(1),
    blob_sha: z.string().optional(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    /** Hash of the exact referenced content (blob or bounded excerpt). */
    content_hash: z.string().min(1),
    acquisition_method: z.enum(ACQUISITION_METHODS),
    observed_at: z.string().min(1),
  })
  .strict()
  .refine(
    (data) =>
      data.start_line === undefined || data.end_line === undefined || data.start_line <= data.end_line,
    { message: 'start_line must be <= end_line', path: ['start_line'] },
  );
export type EvidenceRefV1 = z.infer<typeof EvidenceRefV1Schema>;

export const EvidenceValidationEntryV1Schema = z.object({
  evidence_id: z.string().min(1),
  valid: z.boolean(),
  reasons: z.array(z.string()),
}).strict();
export type EvidenceValidationEntryV1 = z.infer<typeof EvidenceValidationEntryV1Schema>;

// ---------------------------------------------------------------------------
// PatternCardV1
// ---------------------------------------------------------------------------

export const PATTERN_NEXT_ACTIONS = [
  'ignore',
  'gather_more_evidence',
  'prototype',
  'dependency_review',
  'watch',
] as const;

export const PatternCardV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    pattern_id: z.string().min(1),
    mission_id: z.string().min(1),
    title: z.string().min(1),
    problem: z.string().min(1),
    mechanism: z.string().min(1),
    preconditions: z.array(z.string()),
    tradeoffs: z.array(z.string()),
    evidence_refs: z.array(z.string()).min(1),
    sources: z
      .array(
        z
          .object({
            repository_id: z.string().min(1),
            commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
          })
          .strict(),
      )
      .min(1),
    license_observations: z.array(
      z
        .object({
          repository_id: z.string().min(1),
          spdx_id: z.string().nullable(),
          status: z.enum(['known', 'unknown']),
        })
        .strict(),
    ),
    applicability: z
      .object({
        target_head_sha: z.string().nullable(),
        local_evidence_refs: z.array(z.string()),
        hypothesis: z.string(),
        integration_risks: z.array(z.string()),
      })
      .strict(),
    next_action: z.enum(PATTERN_NEXT_ACTIONS),
    evidence_state: EvidenceStateSchema,
  })
  .strict();
export type PatternCardV1 = z.infer<typeof PatternCardV1Schema>;

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

export interface RepositorySearchOptions {
  perPage?: number;
  /** Additional provider-side qualifiers, e.g. language:typescript. */
  qualifiers?: string[];
}

export interface RepositorySearchPage {
  repositories: Array<{
    identity: RepositoryIdentity;
    description: string | null;
    language: string | null;
    topics: string[];
    archived: boolean;
    stars: number;
    forks: number;
    pushed_at: string | null;
    license_spdx_id: string | null;
    is_fork: boolean;
  }>;
  /** Provider-reported total and whether more pages remain. */
  totalCount: number;
  hasMore: boolean;
}

export interface ResolvedRevision {
  identity: RepositoryIdentity;
  commitSha: string;
  ref: string | null;
}

export interface RepositoryTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size: number | null;
  blobSha: string | null;
}

export interface RepositoryTree {
  revision: ResolvedRevision;
  entries: RepositoryTreeEntry[];
  /** Explicit truncated state — a truncated tree is not a complete snapshot. */
  truncated: boolean;
}

export interface RepositoryFile {
  revision: ResolvedRevision;
  path: string;
  content: string;
  blobSha: string | null;
  contentHash: string;
  truncated: boolean;
}

export interface CodeSearchResult {
  identity: RepositoryIdentity;
  path: string;
  blobSha: string | null;
}

/**
 * Provider boundary for repository research. Implementations perform
 * network acquisition only; they hold credentials (host-owned, never
 * exposed to models) and never receive mutation authority over either
 * the target project or discovered repositories.
 */
export interface RepositoryResearchProvider {
  readonly name: string;
  searchRepositories(query: string, options?: RepositorySearchOptions): Promise<RepositorySearchPage>;
  resolveRevision(repo: RepositoryIdentity, ref?: string): Promise<ResolvedRevision>;
  getTree(revision: ResolvedRevision): Promise<RepositoryTree>;
  readTextFile(revision: ResolvedRevision, path: string): Promise<RepositoryFile>;
  searchCode?(query: string, scope?: RepositoryIdentity): Promise<CodeSearchResult[]>;
}

// ---------------------------------------------------------------------------
// SnapshotManifestV1 (Slice C)
// ---------------------------------------------------------------------------

/** One fetched file inside an immutable repository snapshot. */
export const SnapshotFileEntrySchema = z
  .object({
    path: z.string().min(1),
    blob_sha: z.string().nullable(),
    content_hash: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    /** Why this file was selected (manifest | license | docs | term_match | test). */
    selection_reason: z.string().min(1),
    truncated: z.boolean(),
  })
  .strict();
export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntrySchema>;

export const SnapshotManifestV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    snapshot_id: z.string().min(1),
    mission_id: z.string().min(1),
    repository_id: z.string().min(1),
    repository_full_name: z.string().min(1),
    /** Resolved and recorded before any evidence collection. */
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
    created_at: z.string().min(1),
    tree_truncated: z.boolean(),
    files: z.array(SnapshotFileEntrySchema),
    total_bytes: z.number().int().nonnegative(),
    byte_budget: z.number().int().nonnegative(),
    budget_exhausted: z.boolean(),
  })
  .strict();
export type SnapshotManifestV1 = z.infer<typeof SnapshotManifestV1Schema>;

// ---------------------------------------------------------------------------
// RepoReaderReportV1 (Slice C) — the only channel out of quarantine
// ---------------------------------------------------------------------------

export const ReaderObservationSchema = z
  .object({
    claim: z.string().min(1),
    evidence_ref_ids: z.array(z.string()),
    kind: z.enum(['source_observed', 'inferred', 'local_hypothesis']),
  })
  .strict();
export type ReaderObservation = z.infer<typeof ReaderObservationSchema>;

export const ReaderPatternSchema = z
  .object({
    name: z.string().min(1),
    mechanism: z.string().min(1),
    tradeoffs: z.array(z.string()),
  })
  .strict();
export type ReaderPattern = z.infer<typeof ReaderPatternSchema>;

export const RepoReaderReportV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    repository: z.string().min(1),
    commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
    problem_match: z.string(),
    observations: z.array(ReaderObservationSchema),
    patterns: z.array(ReaderPatternSchema),
    missing_evidence: z.array(z.string()),
  })
  .strict();
export type RepoReaderReportV1 = z.infer<typeof RepoReaderReportV1Schema>;

// ---------------------------------------------------------------------------
// ExperimentProposalV1 + ResearchReviewV1 (Slice D)
// ---------------------------------------------------------------------------

export const ExperimentProposalV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    proposal_id: z.string().min(1),
    mission_id: z.string().min(1),
    pattern_id: z.string().min(1),
    /** The uncertainty the experiment tests — a proposal without one is not falsifiable. */
    hypothesis: z.string().min(1),
    baseline: z.string().min(1),
    experiment: z.string().min(1),
    metrics: z.array(z.string().min(1)).min(1),
    promotion_criteria: z.string().min(1),
    /** Bound to the target HEAD the experiment was designed against. */
    target_head_sha: z.string().nullable(),
    created_at: z.string().min(1),
  })
  .strict();
export type ExperimentProposalV1 = z.infer<typeof ExperimentProposalV1Schema>;

export const RESEARCH_REVIEW_VERDICTS = [
  'ACCEPT_RESEARCH_FINDING',
  'NEEDS_MORE_EVIDENCE',
  'REJECT_RESEARCH_FINDING',
] as const;

export const ResearchReviewV1Schema = z
  .object({
    schema_version: z.literal(1).default(1),
    review_id: z.string().min(1),
    mission_id: z.string().min(1),
    pattern_id: z.string().min(1),
    verdict: z.enum(RESEARCH_REVIEW_VERDICTS),
    /** Evidence-backed reasoning; the reviewer sees validated artifacts only. */
    rationale: z.string().min(1),
    checked: z.array(z.string()).min(1),
    concerns: z.array(z.string()),
    reviewed_at: z.string().min(1),
    /** Research review never substitutes for code review/merge governance. */
    grants_merge_authority: z.literal(false),
  })
  .strict();
export type ResearchReviewV1 = z.infer<typeof ResearchReviewV1Schema>;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Parse a durable research artifact, rejecting unknown fields. */
export function parseResearchArtifact<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid ${label}: ${issues}`);
  }
  return result.data;
}
