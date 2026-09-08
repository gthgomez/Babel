import { randomUUID } from 'node:crypto'

/** Immutable review tuple collected by the trusted host before worker launch. */
export interface HostReviewCandidate {
  repository: string
  pr_number?: number
  task_id: string
  task_hash: string
  base_sha: string
  head_sha: string
  builder_id: string
  diff_numstat_digest: string
  /** Exact paths supplied by the trusted controller; it must not infer this list. */
  scope: string[]
}

/**
 * This is an adapter contract, not an operating-system security claim. A
 * trusted host must enforce either text-only/no-tools execution or a real
 * read-only sandbox before it gives an adapter to this controller.
 */
export interface HostReviewIsolationProfile {
  mode: 'text_only_no_tools' | 'readonly_sandbox'
  candidate_write: false
  github_mutation: false
  merge: false
  controller_state_access: false
}

/** Observed provider usage from the one bounded text-only inference. */
export interface HostReviewUsage {
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  latency_ms: number | null
}

/** Controller-owned request delivered to a single read-only worker launch. */
export interface HostReviewExecutionRequest {
  controller_id: string
  controller_run_id: string
  execution_id: string
  candidate: Readonly<HostReviewCandidate>
  reviewer_class: 'independent_readonly_ai'
  review_mode: 'exact_diff'
  required_isolation: HostReviewIsolationProfile
}

/** Observed completion returned by the trusted worker-launch adapter. */
export interface HostReviewExecutionResult {
  controller_id: string
  controller_run_id: string
  execution_id: string
  status: 'COMPLETED' | 'FAILED'
  reviewed_candidate: HostReviewCandidate
  reviewer_id: string
  review_provider: string
  reviewer_model: string
  reviewed_at: string
  scope: string[]
  verdict: 'APPROVE' | 'BLOCK'
  findings: string[]
  blocking_findings: string[]
  isolation: HostReviewIsolationProfile
  usage?: HostReviewUsage
}

/** Adapter implemented by the controller-owned Astra/Codex worker launcher. */
/** Launches a worker from the host controller's private capability boundary. */
export interface HostReviewWorkerAdapter {
  launch(request: Readonly<HostReviewExecutionRequest>): Promise<HostReviewExecutionResult>
}

/** Normalized, unsigned review evidence that GitHub later authenticates by publisher identity. */
export interface AutonomousReviewEvidenceV2 {
  schema_version: 2
  kind: 'autonomous_review_evidence_v2'
  repository: string
  pr_number?: number
  base_sha: string
  head_sha: string
  task_id: string
  task_hash: string
  builder_id: string
  diff_numstat_digest: string
  reviewer_id: string
  reviewer_class: 'independent_readonly_ai'
  execution_id: string
  review_provider: string
  reviewer_model: string
  review_mode: 'exact_diff'
  reviewed_at: string
  scope: string[]
  verdict: 'APPROVE' | 'BLOCK'
  findings: string[]
  blocking_findings: string[]
  isolation: HostReviewIsolationProfile
  usage?: HostReviewUsage
}

/** One controller-owned review round suitable for a single GitHub handoff comment. */
export interface HostReviewHandoffV2 {
  schema_version: 2
  kind: 'host_review_handoff_v2'
  repository: string
  pr_number?: number
  base_sha: string
  head_sha: string
  task_id: string
  task_hash: string
  controller_run_id: string
  reviews: [AutonomousReviewEvidenceV2] | [AutonomousReviewEvidenceV2, AutonomousReviewEvidenceV2]
}

/** Serializes controller-owned worker completions into a normalized handoff. */
export interface HostReviewController {
  review(candidate: Readonly<HostReviewCandidate>, risk?: 'GREEN' | 'RED'): Promise<HostReviewHandoffV2>
}

interface HostReviewLaunchRecord {
  controller_run_id: string
  candidate: HostReviewCandidate
  serialized: boolean
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`Host review requires ${field}.`)
}

function assertSha(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`Host review ${field} must be a full SHA.`)
}

function assertDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`Host review ${field} must be a SHA-256 digest.`)
}

function assertScope(scope: string[]): void {
  if (scope.length === 0) throw new Error('Host review file scope cannot be empty.')
  if (scope.some((path) => {
    return !path.trim() || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  })) {
    throw new Error('Host review file scope contains an unsafe path.')
  }
}

function assertCandidate(candidate: Readonly<HostReviewCandidate>): void {
  for (const field of ['repository', 'task_id', 'task_hash', 'base_sha', 'head_sha', 'builder_id', 'diff_numstat_digest'] as const) {
    requireText(candidate[field], field)
  }
  if (candidate.pr_number !== undefined && (!Number.isInteger(candidate.pr_number) || candidate.pr_number < 1)) throw new Error('Host review pr_number must be positive.')
  assertDigest(candidate.task_hash, 'task_hash')
  assertSha(candidate.base_sha, 'base_sha')
  assertSha(candidate.head_sha, 'head_sha')
  assertDigest(candidate.diff_numstat_digest, 'diff_numstat_digest')
  assertScope(candidate.scope)
}

function assertIsolation(isolation: HostReviewIsolationProfile): void {
  if ((isolation.mode !== 'text_only_no_tools' && isolation.mode !== 'readonly_sandbox') || isolation.candidate_write !== false || isolation.github_mutation !== false || isolation.merge !== false || isolation.controller_state_access !== false) {
    throw new Error('Host review worker did not satisfy the required isolation contract.')
  }
}

function assertAttribution(value: string, field: string): void {
  requireText(value, field)
  if (value.trim().toLowerCase() === 'unknown') throw new Error(`Host review ${field} cannot be UNKNOWN.`)
}

function snapshotScope(scope: readonly string[]): string[] {
  return Object.freeze([...scope]) as unknown as string[]
}

function snapshotCandidate(candidate: Readonly<HostReviewCandidate>): HostReviewCandidate {
  return Object.freeze({ ...candidate, scope: snapshotScope(candidate.scope) }) as HostReviewCandidate
}

function snapshotIsolation(isolation: HostReviewIsolationProfile): HostReviewIsolationProfile {
  return Object.freeze({
    mode: isolation.mode,
    candidate_write: isolation.candidate_write,
    github_mutation: isolation.github_mutation,
    merge: isolation.merge,
    controller_state_access: isolation.controller_state_access,
  })
}

function snapshotUsage(usage: HostReviewUsage): HostReviewUsage {
  return Object.freeze({ ...usage })
}

function scopesMatch(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function candidatesMatch(left: HostReviewCandidate, right: HostReviewCandidate): boolean {
  return left.repository === right.repository && left.pr_number === right.pr_number && left.task_id === right.task_id && left.task_hash === right.task_hash && left.base_sha === right.base_sha && left.head_sha === right.head_sha && left.builder_id === right.builder_id && left.diff_numstat_digest === right.diff_numstat_digest && scopesMatch(left.scope, right.scope)
}

function assertResult(record: HostReviewLaunchRecord, controllerId: string, executionId: string, result: HostReviewExecutionResult, now: number, maxReviewAgeMs: number): void {
  if (record.serialized) throw new Error('Host review execution has already been serialized.')
  if (result.controller_id !== controllerId || result.controller_run_id !== record.controller_run_id || result.execution_id !== executionId) {
    throw new Error('Host review result was not produced for this controller launch.')
  }
  if (result.status !== 'COMPLETED') throw new Error('Host review execution did not complete successfully.')
  assertCandidate(result.reviewed_candidate)
  if (!candidatesMatch(result.reviewed_candidate, record.candidate)) throw new Error('Host review result exact candidate binding mismatch.')
  if (result.reviewer_id === record.candidate.builder_id) throw new Error('Host review reviewer must be distinct from builder.')
  requireText(result.reviewer_id, 'reviewer_id')
  assertAttribution(result.review_provider, 'review_provider')
  assertAttribution(result.reviewer_model, 'reviewer_model')
  requireText(result.reviewed_at, 'reviewed_at')
  const reviewedAt = Date.parse(result.reviewed_at)
  if (Number.isNaN(reviewedAt) || reviewedAt > now || now - reviewedAt > maxReviewAgeMs) throw new Error('Host review result is stale or has an invalid reviewed_at timestamp.')
  if (result.verdict !== 'APPROVE' && result.verdict !== 'BLOCK') throw new Error('Host review verdict is invalid.')
  if (result.verdict === 'APPROVE' && result.blocking_findings.length > 0) throw new Error('Host review APPROVE cannot contain blocking findings.')
  assertScope(result.scope)
  if (!scopesMatch(result.scope, record.candidate.scope)) throw new Error('Host review result scope does not match the controller request.')
  assertIsolation(result.isolation)
}

/**
 * Create the host-owned controller boundary for an Astra/Codex reviewer.
 * The private launch registry admits only its own completed adapter launches;
 * it does not claim to sandbox a host that supplies an unsafe adapter.
 */
export function createHostReviewController(input: {
  controller_id: string
  adapter: HostReviewWorkerAdapter
  create_id?: () => string
  now?: () => number
  max_review_age_ms?: number
}): HostReviewController {
  requireText(input.controller_id, 'controller_id')
  const createId = input.create_id ?? randomUUID
  const now = input.now ?? Date.now
  const maxReviewAgeMs = input.max_review_age_ms ?? 15 * 60 * 1000
  if (!Number.isSafeInteger(maxReviewAgeMs) || maxReviewAgeMs < 1) throw new Error('Host review max_review_age_ms must be positive.')
  const launches = new Map<string, HostReviewLaunchRecord>()
  const requiredIsolation: HostReviewIsolationProfile = Object.freeze({
    mode: 'text_only_no_tools',
    candidate_write: false,
    github_mutation: false,
    merge: false,
    controller_state_access: false,
  })

  return Object.freeze({
    async review(candidate: Readonly<HostReviewCandidate>, risk: 'GREEN' | 'RED' = 'GREEN'): Promise<HostReviewHandoffV2> {
      const candidateSnapshot = snapshotCandidate(candidate)
      assertCandidate(candidateSnapshot)
      if (risk !== 'GREEN' && risk !== 'RED') throw new Error('Host review risk must be GREEN or RED.')
      const controllerRunId = createId()
      if (!controllerRunId) throw new Error('Host review controller generated an invalid controller run identifier.')
      const reviewCount = risk === 'RED' ? 2 : 1
      const reviews: AutonomousReviewEvidenceV2[] = []
      const reviewerIds = new Set<string>()
      for (let index = 0; index < reviewCount; index += 1) {
        const executionId = createId()
        if (!executionId || executionId === controllerRunId || launches.has(executionId)) throw new Error('Host review controller generated an invalid execution identifier.')
        const record: HostReviewLaunchRecord = { controller_run_id: controllerRunId, candidate: candidateSnapshot, serialized: false }
        launches.set(executionId, record)
        const request: HostReviewExecutionRequest = Object.freeze({
          controller_id: input.controller_id,
          controller_run_id: controllerRunId,
          execution_id: executionId,
          candidate: record.candidate,
          reviewer_class: 'independent_readonly_ai',
          review_mode: 'exact_diff',
          required_isolation: requiredIsolation,
        })
        const result = await input.adapter.launch(request)
        assertResult(record, input.controller_id, executionId, result, now(), maxReviewAgeMs)
        if (reviewerIds.has(result.reviewer_id)) throw new Error('Host review RED lane requires distinct reviewer identities.')
        reviewerIds.add(result.reviewer_id)
        record.serialized = true
        reviews.push(Object.freeze({
          schema_version: 2,
          kind: 'autonomous_review_evidence_v2',
          repository: record.candidate.repository,
          ...(record.candidate.pr_number !== undefined ? { pr_number: record.candidate.pr_number } : {}),
          base_sha: record.candidate.base_sha,
          head_sha: record.candidate.head_sha,
          task_id: record.candidate.task_id,
          task_hash: record.candidate.task_hash,
          builder_id: record.candidate.builder_id,
          diff_numstat_digest: record.candidate.diff_numstat_digest,
          reviewer_id: result.reviewer_id,
          reviewer_class: 'independent_readonly_ai',
          execution_id: executionId,
          review_provider: result.review_provider,
          reviewer_model: result.reviewer_model,
          review_mode: 'exact_diff',
          reviewed_at: result.reviewed_at,
          scope: snapshotScope(result.scope),
          verdict: result.verdict,
          findings: snapshotScope(result.findings),
          blocking_findings: snapshotScope(result.blocking_findings),
          isolation: snapshotIsolation(result.isolation),
          ...(result.usage ? { usage: snapshotUsage(result.usage) } : {}),
        }))
      }
      const handoffReviews = (risk === 'RED'
        ? [reviews[0], reviews[1]]
        : [reviews[0]]) as [AutonomousReviewEvidenceV2] | [AutonomousReviewEvidenceV2, AutonomousReviewEvidenceV2]
      return Object.freeze({
        schema_version: 2,
        kind: 'host_review_handoff_v2',
        repository: candidateSnapshot.repository,
        ...(candidateSnapshot.pr_number !== undefined ? { pr_number: candidateSnapshot.pr_number } : {}),
        base_sha: candidateSnapshot.base_sha,
        head_sha: candidateSnapshot.head_sha,
        task_id: candidateSnapshot.task_id,
        task_hash: candidateSnapshot.task_hash,
        controller_run_id: controllerRunId,
        reviews: Object.freeze(handoffReviews) as unknown as [AutonomousReviewEvidenceV2] | [AutonomousReviewEvidenceV2, AutonomousReviewEvidenceV2],
      })
    },
  })
}
