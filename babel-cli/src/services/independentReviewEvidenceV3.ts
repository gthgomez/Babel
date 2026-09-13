import { z } from 'zod'

export type ReviewEvidenceProvenance =
  | 'LOCAL_UNAUTHENTICATED'
  | 'TRUSTED_CONTROLLER_EVIDENCE'
  | 'OWNER_AUTHENTICATED_GITHUB_EVIDENCE'

export interface ReviewActorIdentity {
  /** Agent/runtime family: codex, claude-code, babel, gemini, etc. */
  kind: string
  /** Controller-issued identity for the specific agent context/principal. */
  principal_id: string
  /** Controller-issued identity for this exact execution. */
  execution_id: string
}

export type ModelAttribution = 'observed' | 'configured' | 'unavailable'

export interface IndependentReviewRuntime {
  /** Agent family: codex, claude-code, babel, gemini, etc. */
  agent_kind: string
  /** Controller adapter ID, e.g. codex-subagent-v1, claude-cli-v1, babel-chat-v1. */
  adapter_id: string
  /** Must equal reviewer.execution_id. */
  controller_execution_id: string
  source_sha?: string
  runtime_version?: string
  requested_provider?: string
  observed_provider?: string
  requested_model?: string
  observed_model?: string | null
  model_attribution?: ModelAttribution
  provider_execution_id?: string
  provider_session_id?: string
}

export interface IndependentReviewIsolationProfile {
  candidate_write: false
  github_mutation: false
  merge: false
  controller_state_access: false
}

export interface IndependentReviewUsage {
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  latency_ms: number | null
}

export interface IndependentReviewEvidenceV3 {
  schema_version: 3
  kind: 'independent_agent_review_v3'
  provenance?: ReviewEvidenceProvenance
  repository: string
  pr_number: number
  base_sha: string
  head_sha: string
  candidate_digest: string
  diff_numstat_digest: string
  task_id: string
  task_hash: string
  builder: ReviewActorIdentity
  reviewer: ReviewActorIdentity
  controller_run_id: string
  challenge_id: string
  runtime: IndependentReviewRuntime
  review_mode: 'exact_diff'
  reviewed_at: string
  scope: string[]
  verdict: 'APPROVE' | 'BLOCK'
  findings: string[]
  blocking_findings: string[]
  isolation: IndependentReviewIsolationProfile
  usage?: IndependentReviewUsage
}

export interface HostReviewHandoffV3 {
  schema_version: 3
  kind: 'host_review_handoff_v3'
  provenance?: ReviewEvidenceProvenance
  repository: string
  pr_number: number
  base_sha: string
  head_sha: string
  candidate_digest: string
  diff_numstat_digest: string
  task_id: string
  task_hash: string
  controller_run_id: string
  reviews: [IndependentReviewEvidenceV3] | [IndependentReviewEvidenceV3, IndependentReviewEvidenceV3]
}

// 23 hours fresh margin inside 24h boundary
export const REVIEW_V3_FRESH_MS = 23 * 60 * 60 * 1000

const text = z.string().min(1).refine(v => v.trim().toLowerCase() !== 'unknown', { message: 'FIELD_CANNOT_BE_UNKNOWN' })
const sha = z.string().regex(/^[a-f0-9]{40}$/i, { message: 'INVALID_SHA' })
const digest = z.string().regex(/^[a-f0-9]{64}$/i, { message: 'INVALID_DIGEST' })
const provenanceSchema = z.enum(['LOCAL_UNAUTHENTICATED', 'TRUSTED_CONTROLLER_EVIDENCE', 'OWNER_AUTHENTICATED_GITHUB_EVIDENCE'])

export const challengeIdSchema = z.string()
  .min(1, { message: 'EMPTY_CHALLENGE_ID' })
  .max(128, { message: 'CHALLENGE_ID_TOO_LONG' })
  .regex(/^[a-zA-Z0-9_-]+$/, { message: 'INVALID_CHALLENGE_ID_FORMAT' })
  .refine(v => !v.includes('..') && !v.includes('/') && !v.includes('\\') && !/^[A-Za-z]:/.test(v), { message: 'UNSAFE_CHALLENGE_ID_PATH' })

export function assertSafeChallengeId(id: string): void {
  if (
    !id ||
    typeof id !== 'string' ||
    id.trim() !== id ||
    id.length > 128 ||
    !/^[a-zA-Z0-9_-]+$/.test(id) ||
    id.includes('..') ||
    id.includes('/') ||
    id.includes('\\') ||
    /^[A-Za-z]:/.test(id)
  ) {
    throw new Error(`UNSAFE_CHALLENGE_ID: ${id}`)
  }
}

export const reviewActorIdentitySchema = z.object({
  kind: text,
  principal_id: text,
  execution_id: text,
}).strict()

export const independentReviewRuntimeSchema = z.object({
  agent_kind: text,
  adapter_id: text,
  controller_execution_id: text,
  source_sha: sha.optional(),
  runtime_version: z.string().min(1).optional(),
  requested_provider: z.string().min(1).optional(),
  observed_provider: z.string().min(1).optional(),
  requested_model: z.string().min(1).optional(),
  observed_model: z.string().nullable().optional(),
  model_attribution: z.enum(['observed', 'configured', 'unavailable']).optional(),
  provider_execution_id: z.string().min(1).optional(),
  provider_session_id: z.string().min(1).optional(),
}).strict()

export const independentReviewIsolationSchema = z.object({
  candidate_write: z.literal(false),
  github_mutation: z.literal(false),
  merge: z.literal(false),
  controller_state_access: z.literal(false),
}).strict()

export const independentReviewUsageSchema = z.object({
  prompt_tokens: z.number().finite().nonnegative().nullable(),
  completion_tokens: z.number().finite().nonnegative().nullable(),
  total_tokens: z.number().finite().nonnegative().nullable(),
  latency_ms: z.number().finite().nonnegative().nullable(),
}).strict()

export const independentReviewEvidenceV3Schema = z.object({
  schema_version: z.literal(3),
  kind: z.literal('independent_agent_review_v3'),
  provenance: provenanceSchema.optional(),
  repository: text,
  pr_number: z.number().int().positive(),
  base_sha: sha,
  head_sha: sha,
  candidate_digest: digest,
  diff_numstat_digest: digest,
  task_id: text,
  task_hash: digest,
  builder: reviewActorIdentitySchema,
  reviewer: reviewActorIdentitySchema,
  controller_run_id: text,
  challenge_id: challengeIdSchema,
  runtime: independentReviewRuntimeSchema,
  review_mode: z.literal('exact_diff'),
  reviewed_at: text,
  scope: z.array(text).min(1),
  verdict: z.enum(['APPROVE', 'BLOCK']),
  findings: z.array(z.string()),
  blocking_findings: z.array(z.string()),
  isolation: independentReviewIsolationSchema,
  usage: independentReviewUsageSchema.optional(),
}).strict()

export const hostReviewHandoffV3Schema = z.object({
  schema_version: z.literal(3),
  kind: z.literal('host_review_handoff_v3'),
  provenance: provenanceSchema.optional(),
  repository: text,
  pr_number: z.number().int().positive(),
  base_sha: sha,
  head_sha: sha,
  candidate_digest: digest,
  diff_numstat_digest: digest,
  task_id: text,
  task_hash: digest,
  controller_run_id: text,
  reviews: z.union([
    z.tuple([independentReviewEvidenceV3Schema]),
    z.tuple([independentReviewEvidenceV3Schema, independentReviewEvidenceV3Schema]),
  ]),
}).strict()

function assertSafePath(path: string): void {
  if (!path.trim() || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`UNSAFE_SCOPE_PATH: ${path}`)
  }
  const segments = path.split('/')
  if (segments.some(s => s === '' || s === '.' || s === '..')) {
    throw new Error(`UNSAFE_SCOPE_PATH_SEGMENTS: ${path}`)
  }
}

/**
 * Validates an IndependentReviewEvidenceV3 object against schema, exact candidate binding,
 * three-level actor independence, and adapter-specific rules.
 */
export function validateIndependentReviewEvidenceV3(
  value: unknown,
  expected?: Partial<IndependentReviewEvidenceV3> & { candidateScope?: string[] | undefined; now?: number | undefined; requireAuthoritative?: boolean | undefined }
): IndependentReviewEvidenceV3 {
  const parsed = independentReviewEvidenceV3Schema.parse(value)

  if (expected?.requireAuthoritative && parsed.provenance === 'LOCAL_UNAUTHENTICATED') {
    throw new Error('LOCAL_UNAUTHENTICATED_EVIDENCE_CANNOT_SATISFY_AUTHORITY')
  }

  // 1. Independence validation
  if (parsed.reviewer.principal_id.toLowerCase() === parsed.builder.principal_id.toLowerCase()) {
    throw new Error('REVIEWER_PRINCIPAL_NOT_INDEPENDENT')
  }
  if (parsed.reviewer.execution_id.toLowerCase() === parsed.builder.execution_id.toLowerCase()) {
    throw new Error('REVIEWER_EXECUTION_NOT_DISTINCT')
  }
  if (parsed.runtime.controller_execution_id !== parsed.reviewer.execution_id) {
    throw new Error('RUNTIME_EXECUTION_ID_MISMATCH')
  }

  // 2. Adapter-specific validation
  if (parsed.runtime.agent_kind === 'babel') {
    // Babel adapter invariants
    const provider = parsed.runtime.observed_provider ?? parsed.runtime.requested_provider
    if (provider !== 'opencode-go') {
      throw new Error('BABEL_REVIEWER_MUST_USE_OPENCODE_GO')
    }
    if (!parsed.runtime.runtime_version || !/^[a-f0-9]{64}$/i.test(parsed.runtime.runtime_version)) {
      throw new Error('BABEL_REVIEWER_INVALID_VERSION_DIGEST')
    }
  } else {
    // External adapter invariants: must NOT claim to be Babel or use Babel-internal provider
    const provider = parsed.runtime.observed_provider ?? parsed.runtime.requested_provider
    if (provider === 'opencode-go') {
      throw new Error('EXTERNAL_REVIEWER_CANNOT_CLAIM_OPENCODE_GO')
    }
    if (parsed.runtime.adapter_id.startsWith('babel-')) {
      throw new Error('EXTERNAL_REVIEWER_CANNOT_CLAIM_BABEL_ADAPTER')
    }
  }

  // 3. Verdict consistency
  if (parsed.verdict === 'APPROVE' && parsed.blocking_findings.length > 0) {
    throw new Error('APPROVE_VERDICT_CANNOT_HAVE_BLOCKING_FINDINGS')
  }

  // 4. Scope verification
  const seenPaths = new Set<string>()
  for (const p of parsed.scope) {
    assertSafePath(p)
    if (seenPaths.has(p)) throw new Error(`DUPLICATE_SCOPE_PATH: ${p}`)
    seenPaths.add(p)
  }
  if (expected?.candidateScope) {
    const sortedEvidenceScope = [...parsed.scope].sort()
    const sortedExpectedScope = [...expected.candidateScope].sort()
    if (JSON.stringify(sortedEvidenceScope) !== JSON.stringify(sortedExpectedScope)) {
      throw new Error('SCOPE_MISMATCH')
    }
  }

  // 5. Freshness
  const now = expected?.now ?? Date.now()
  const reviewTime = Date.parse(parsed.reviewed_at)
  if (Number.isNaN(reviewTime)) throw new Error('INVALID_REVIEWED_AT')
  const age = now - reviewTime
  if (age < 0 || age > REVIEW_V3_FRESH_MS) {
    throw new Error('REVIEW_EVIDENCE_STALE_OR_FUTURE')
  }

  // 6. Expected candidate bindings
  if (expected) {
    for (const key of [
      'repository', 'pr_number', 'base_sha', 'head_sha',
      'candidate_digest', 'diff_numstat_digest', 'task_id', 'task_hash',
      'controller_run_id', 'challenge_id'
    ] as const) {
      if (expected[key] !== undefined && parsed[key] !== expected[key]) {
        throw new Error(`CANDIDATE_BINDING_MISMATCH: ${key}`)
      }
    }
    if (expected.builder) {
      if (
        expected.builder.kind !== parsed.builder.kind ||
        expected.builder.principal_id !== parsed.builder.principal_id ||
        expected.builder.execution_id !== parsed.builder.execution_id
      ) {
        throw new Error('BUILDER_IDENTITY_MISMATCH')
      }
    }
  }

  return parsed as IndependentReviewEvidenceV3
}

/**
 * Validates a HostReviewHandoffV3 bundle and all contained reviews.
 */
export function validateHostReviewHandoffV3(
  value: unknown,
  expected?: {
    candidateDigest?: string
    repository?: string
    prNumber?: number
    baseSha?: string
    headSha?: string
    controllerRunId?: string
    scope?: string[]
    now?: number
    requireAuthoritative?: boolean
  }
): HostReviewHandoffV3 {
  const parsed = hostReviewHandoffV3Schema.parse(value)

  if (expected?.requireAuthoritative && parsed.provenance === 'LOCAL_UNAUTHENTICATED') {
    throw new Error('LOCAL_UNAUTHENTICATED_EVIDENCE_CANNOT_SATISFY_AUTHORITY')
  }

  if (expected?.repository && parsed.repository !== expected.repository) throw new Error('HANDOFF_REPOSITORY_MISMATCH')
  if (expected?.prNumber && parsed.pr_number !== expected.prNumber) throw new Error('HANDOFF_PR_MISMATCH')
  if (expected?.baseSha && parsed.base_sha !== expected.baseSha) throw new Error('HANDOFF_BASE_SHA_MISMATCH')
  if (expected?.headSha && parsed.head_sha !== expected.headSha) throw new Error('HANDOFF_HEAD_SHA_MISMATCH')
  if (expected?.candidateDigest && parsed.candidate_digest !== expected.candidateDigest) throw new Error('HANDOFF_CANDIDATE_DIGEST_MISMATCH')
  if (expected?.controllerRunId && parsed.controller_run_id !== expected.controllerRunId) throw new Error('HANDOFF_RUN_ID_MISMATCH')

  const reviewerPrincipals = new Set<string>()
  const reviewerExecutions = new Set<string>()
  const challengeIds = new Set<string>()

  for (const review of parsed.reviews) {
    validateIndependentReviewEvidenceV3(review, {
      repository: parsed.repository,
      pr_number: parsed.pr_number,
      base_sha: parsed.base_sha,
      head_sha: parsed.head_sha,
      candidate_digest: parsed.candidate_digest,
      diff_numstat_digest: parsed.diff_numstat_digest,
      task_id: parsed.task_id,
      task_hash: parsed.task_hash,
      controller_run_id: parsed.controller_run_id,
      candidateScope: expected?.scope,
      now: expected?.now,
      requireAuthoritative: expected?.requireAuthoritative,
    })

    if (reviewerPrincipals.has(review.reviewer.principal_id)) {
      throw new Error('DUPLICATE_REVIEWER_PRINCIPAL')
    }
    if (reviewerExecutions.has(review.reviewer.execution_id)) {
      throw new Error('DUPLICATE_REVIEWER_EXECUTION')
    }
    if (challengeIds.has(review.challenge_id)) {
      throw new Error('DUPLICATE_CHALLENGE_ID')
    }
    reviewerPrincipals.add(review.reviewer.principal_id)
    reviewerExecutions.add(review.reviewer.execution_id)
    challengeIds.add(review.challenge_id)
  }

  return parsed as HostReviewHandoffV3
}

/**
 * Strips host-private or local provenance for GitHub publication while keeping all V3 contract fields.
 */
export function publicIndependentReviewHandoffV3(handoff: HostReviewHandoffV3): Record<string, unknown> {
  const { provenance: _hp, ...rest } = handoff as unknown as Record<string, unknown>
  const reviews = (handoff.reviews as IndependentReviewEvidenceV3[]).map((review) => {
    const { provenance: _rp, ...reviewRest } = review as unknown as Record<string, unknown>
    return reviewRest
  })
  return { ...rest, reviews }
}
