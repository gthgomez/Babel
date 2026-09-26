import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicReviewJson } from './babelReviewQueue.js'
import {
  type CandidateProducerLineage,
  type HostReviewHandoffV3,
  type IndependentReviewEvidenceV3,
  type IndependentReviewIsolationProfile,
  type IndependentReviewRuntime,
  type IndependentReviewUsage,
  type ReviewActorIdentity,
  type ReviewExecutionPurpose,
  assertSafeChallengeId,
  validateHostReviewHandoffV3,
  validateIndependentReviewEvidenceV3,
} from './independentReviewEvidenceV3.js'
import { assertNoUnresolvedPriorBlock, recordUnresolvedBlock, settleIndependentReviewRound } from './independentReviewPolicy.js'
import type { CandidateEnvelope, HostReviewCandidate } from './hostReviewController.js'

export interface PersistentReviewChallenge {
  challenge_id: string
  status: 'ISSUED' | 'COMPLETED' | 'CONSUMED'
  candidate_digest: string
  repository: string
  pr_number: number
  base_sha: string
  head_sha: string
  diff_numstat_digest: string
  scope: string[]
  builder: ReviewActorIdentity
  reviewer: ReviewActorIdentity
  controller_run_id: string
  issued_at: string
  completed_at?: string
  consumed_at?: string
  verdict?: 'APPROVE' | 'BLOCK'
}

export function issueReviewChallenge(stateDir: string, challenge: PersistentReviewChallenge): void {
  assertSafeChallengeId(challenge.challenge_id)
  if (challenge.status !== 'ISSUED') {
    throw new Error(`CHALLENGE_MUST_BE_ISSUED_STATUS: ${challenge.status}`)
  }
  const challengesDir = join(stateDir, 'challenges')
  mkdirSync(challengesDir, { recursive: true, mode: 0o700 })
  const challengePath = join(challengesDir, `${challenge.challenge_id}.json`)
  if (existsSync(challengePath)) {
    throw new Error(`CHALLENGE_ALREADY_EXISTS: ${challenge.challenge_id}`)
  }
  atomicReviewJson(challengePath, challenge)
}

export function completeReviewChallenge(
  stateDir: string,
  challengeId: string,
  completion: {
    verdict: 'APPROVE' | 'BLOCK'
    completed_at?: string
  }
): void {
  assertSafeChallengeId(challengeId)
  const challengePath = join(stateDir, 'challenges', `${challengeId}.json`)
  if (!existsSync(challengePath)) {
    throw new Error(`CHALLENGE_NOT_FOUND: ${challengeId}`)
  }
  const raw = JSON.parse(readFileSync(challengePath, 'utf8')) as PersistentReviewChallenge
  if (raw.status !== 'ISSUED') {
    throw new Error(`CHALLENGE_NOT_IN_ISSUED_STATE: ${raw.status}`)
  }

  const updated: PersistentReviewChallenge = {
    ...raw,
    status: 'COMPLETED',
    verdict: completion.verdict,
    completed_at: completion.completed_at ?? new Date().toISOString(),
  }
  atomicReviewJson(challengePath, updated)
}

export function verifyAndConsumeChallenge(
  stateDir: string,
  challengeId: string,
  evidence: IndependentReviewEvidenceV3
): void {
  assertSafeChallengeId(challengeId)
  const challengePath = join(stateDir, 'challenges', `${challengeId}.json`)
  if (!existsSync(challengePath)) {
    throw new Error(`CHALLENGE_NOT_FOUND: ${challengeId}`)
  }
  const raw = JSON.parse(readFileSync(challengePath, 'utf8')) as PersistentReviewChallenge
  if (raw.status === 'CONSUMED') {
    throw new Error(`CHALLENGE_ALREADY_CONSUMED: ${challengeId}`)
  }
  if (raw.status !== 'COMPLETED') {
    throw new Error(`CHALLENGE_NOT_COMPLETED: ${raw.status}`)
  }

  // Exact bindings
  if (raw.challenge_id !== challengeId) throw new Error('CHALLENGE_ID_MISMATCH')
  if (raw.candidate_digest !== evidence.candidate_digest) throw new Error('CHALLENGE_CANDIDATE_DIGEST_MISMATCH')
  if (raw.repository !== evidence.repository) throw new Error('CHALLENGE_REPOSITORY_MISMATCH')
  if (raw.pr_number !== evidence.pr_number) throw new Error('CHALLENGE_PR_MISMATCH')
  if (raw.base_sha !== evidence.base_sha) throw new Error('CHALLENGE_BASE_SHA_MISMATCH')
  if (raw.head_sha !== evidence.head_sha) throw new Error('CHALLENGE_HEAD_SHA_MISMATCH')
  if (raw.diff_numstat_digest !== evidence.diff_numstat_digest) throw new Error('CHALLENGE_DIFF_DIGEST_MISMATCH')
  if (raw.controller_run_id !== evidence.controller_run_id) throw new Error('CHALLENGE_RUN_ID_MISMATCH')
  if (raw.verdict !== evidence.verdict) throw new Error('CHALLENGE_VERDICT_MISMATCH')

  // Identity bindings
  if (raw.builder.principal_id !== evidence.builder.principal_id || raw.builder.execution_id !== evidence.builder.execution_id) {
    throw new Error('CHALLENGE_BUILDER_IDENTITY_MISMATCH')
  }
  if (raw.reviewer.principal_id !== evidence.reviewer.principal_id || raw.reviewer.execution_id !== evidence.reviewer.execution_id) {
    throw new Error('CHALLENGE_REVIEWER_IDENTITY_MISMATCH')
  }

  // Atomically consume
  const updated: PersistentReviewChallenge = {
    ...raw,
    status: 'CONSUMED',
    consumed_at: new Date().toISOString(),
  }
  atomicReviewJson(challengePath, updated)
}

export interface IndependentReviewExecutionRequest {
  controller_id: string
  controller_run_id: string
  challenge_id: string
  candidate: Readonly<(CandidateEnvelope | HostReviewCandidate | (HostReviewCandidate & { candidate_digest: string })) & { lineage?: CandidateProducerLineage; producer_execution_id?: string }>
  builder: ReviewActorIdentity
  reviewer: ReviewActorIdentity
  review_mode: 'exact_diff'
  required_isolation: IndependentReviewIsolationProfile
  purpose?: ReviewExecutionPurpose
  /** Blocking findings the repair worker must address (repair only). */
  findings?: string[]
}

export interface IndependentReviewExecutionResult {
  status: 'COMPLETED' | 'FAILED'
  failure_reason?: string
  runtime?: IndependentReviewRuntime
  verdict?: 'APPROVE' | 'BLOCK'
  findings?: string[]
  blocking_findings?: string[]
  reviewed_at?: string
  scope?: string[]
  isolation?: IndependentReviewIsolationProfile
  execution_purpose?: ReviewExecutionPurpose
  usage?: IndependentReviewUsage
}

export interface IndependentReviewWorkerAdapter {
  readonly adapter_id: string
  readonly agent_kind: string
  launch(request: Readonly<IndependentReviewExecutionRequest>): Promise<IndependentReviewExecutionResult>
}

export interface AutonomousRepairResult {
  status: 'COMPLETED' | 'FAILED'
  failure_reason?: string
  modified: boolean
  original_head_sha: string
  new_head_sha?: string
  new_diff_numstat_digest?: string
  producer: ReviewActorIdentity
  commit_message?: string
  findings?: string[]
}

export interface AutonomousEngineeringWorkerAdapter extends IndependentReviewWorkerAdapter {
  repair?(request: Readonly<IndependentReviewExecutionRequest>): Promise<AutonomousRepairResult>
}

export function createAutonomousEngineeringAdapter(options: {
  adapter_id: string
  agent_kind: string
  reviewRunner?: (req: IndependentReviewExecutionRequest) => Promise<IndependentReviewExecutionResult>
  repairRunner?: (req: IndependentReviewExecutionRequest) => Promise<AutonomousRepairResult>
}): AutonomousEngineeringWorkerAdapter {
  return {
    adapter_id: options.adapter_id,
    agent_kind: options.agent_kind,
    async launch(request: Readonly<IndependentReviewExecutionRequest>): Promise<IndependentReviewExecutionResult> {
      if (!options.reviewRunner) {
        throw new Error('AUTONOMOUS_REVIEW_RUNNER_REQUIRED')
      }
      return options.reviewRunner(request)
    },
    async repair(request: Readonly<IndependentReviewExecutionRequest>): Promise<AutonomousRepairResult> {
      if (!options.repairRunner) {
        throw new Error('AUTONOMOUS_REPAIR_RUNNER_REQUIRED')
      }
      return options.repairRunner(request)
    },
  }
}

export interface IndependentReviewController {
  review(
    candidate: Readonly<(CandidateEnvelope | (HostReviewCandidate & { candidate_digest: string })) & { builder?: ReviewActorIdentity; producer_execution_id?: string }>,
    options?: {
      reviewCount?: 1 | 2
      builder?: ReviewActorIdentity
      purpose?: ReviewExecutionPurpose
    }
  ): Promise<HostReviewHandoffV3>
}

export function createIndependentReviewController(input: {
  controller_id: string
  state_dir?: string
  adapter: IndependentReviewWorkerAdapter
  create_id?: () => string
  now?: () => number
}): IndependentReviewController {
  const createId = input.create_id ?? randomUUID
  const now = input.now ?? Date.now

  const requiredIsolation: IndependentReviewIsolationProfile = Object.freeze({
    candidate_write: false,
    github_mutation: false,
    merge: false,
    controller_state_access: false,
  })

  return {
    async review(
      candidate: Readonly<(CandidateEnvelope | (HostReviewCandidate & { candidate_digest: string })) & { builder?: ReviewActorIdentity; producer_execution_id?: string }>,
      options?: {
        reviewCount?: 1 | 2
        builder?: ReviewActorIdentity
        purpose?: ReviewExecutionPurpose
      }
    ): Promise<HostReviewHandoffV3> {
      // 1. Prohibit approval shopping if a prior block was recorded
      if (input.state_dir) {
        assertNoUnresolvedPriorBlock(candidate.candidate_digest, input.state_dir)
      }

      const reviewCount = options?.reviewCount ?? 1
      if (reviewCount !== 1 && reviewCount !== 2) {
        throw new Error('INVALID_REVIEWER_COUNT')
      }

      const controllerRunId = createId()
      const prNumber = candidate.pr_number ?? 1
      const candidateProducer = (candidate as { lineage?: CandidateProducerLineage; producer_execution_id?: string }).lineage?.producer.execution_id ??
        (candidate as { producer_execution_id?: string }).producer_execution_id
      const candidateProducerPrincipal = (candidate as { lineage?: CandidateProducerLineage }).lineage?.producer.principal_id
      const purpose = options?.purpose ?? 'FINAL_CERTIFICATION'

      // Authoritative builder identity
      const candidateBuilder = candidate.builder
      const builderOpt = options?.builder ?? candidateBuilder
      if (!builderOpt && input.state_dir) {
        throw new Error('AUTHORITATIVE_BUILDER_IDENTITY_REQUIRED')
      }
      const builder: ReviewActorIdentity = builderOpt ?? {
        kind: 'unauthenticated',
        principal_id: candidate.builder_id || 'unauthenticated-builder',
        execution_id: `unauth-builder-${createId()}`,
      }

      const provenance = input.state_dir ? 'TRUSTED_CONTROLLER_EVIDENCE' : 'LOCAL_UNAUTHENTICATED'

      const usedPrincipals = new Set<string>()
      const usedExecutions = new Set<string>()

      const slotPromises = Array.from({ length: reviewCount }, async (_, i) => {
        const reviewerPrincipalId = createId()
        const reviewerExecutionId = createId()

        if (reviewerPrincipalId.toLowerCase() === builder.principal_id.toLowerCase() || usedPrincipals.has(reviewerPrincipalId.toLowerCase())) {
          throw new Error('REVIEWER_PRINCIPAL_NOT_INDEPENDENT')
        }
        if (reviewerExecutionId.toLowerCase() === builder.execution_id.toLowerCase() || usedExecutions.has(reviewerExecutionId.toLowerCase())) {
          throw new Error('REVIEWER_EXECUTION_NOT_DISTINCT')
        }
        if (candidateProducer && reviewerExecutionId.toLowerCase() === candidateProducer.toLowerCase()) {
          throw new Error('CANDIDATE_PRODUCER_CANNOT_CERTIFY')
        }
        if (candidateProducerPrincipal && reviewerPrincipalId.toLowerCase() === candidateProducerPrincipal.toLowerCase()) {
          throw new Error('CANDIDATE_PRODUCER_CANNOT_CERTIFY')
        }
        usedPrincipals.add(reviewerPrincipalId.toLowerCase())
        usedExecutions.add(reviewerExecutionId.toLowerCase())

        const reviewer: ReviewActorIdentity = {
          kind: input.adapter.agent_kind,
          principal_id: reviewerPrincipalId,
          execution_id: reviewerExecutionId,
        }

        const challengeId = createId()
        assertSafeChallengeId(challengeId)

        if (input.state_dir) {
          const challengeRecord: PersistentReviewChallenge = {
            challenge_id: challengeId,
            status: 'ISSUED',
            candidate_digest: candidate.candidate_digest,
            repository: candidate.repository,
            pr_number: prNumber,
            base_sha: candidate.base_sha,
            head_sha: candidate.head_sha,
            diff_numstat_digest: candidate.diff_numstat_digest,
            scope: [...candidate.scope],
            builder,
            reviewer,
            controller_run_id: controllerRunId,
            issued_at: new Date(now()).toISOString(),
          }
          issueReviewChallenge(input.state_dir, challengeRecord)
        }

        const request: IndependentReviewExecutionRequest = {
          controller_id: input.controller_id,
          controller_run_id: controllerRunId,
          challenge_id: challengeId,
          candidate,
          builder,
          reviewer,
          review_mode: 'exact_diff',
          required_isolation: requiredIsolation,
          purpose,
        }

        const result = await input.adapter.launch(request)
        if (result.status !== 'COMPLETED') {
          throw new Error(`REVIEW_EXECUTION_FAILED: ${result.failure_reason || 'Unknown adapter failure'}`)
        }

        // Fail closed on missing/invalid verdict (Repair A)
        if (result.verdict !== 'APPROVE' && result.verdict !== 'BLOCK') {
          throw new Error('REVIEW_EXECUTION_FAILED: Missing or invalid review verdict')
        }

        // Fail closed on purpose layer mismatch
        const resultPurpose = result.execution_purpose ?? purpose
        if (resultPurpose !== purpose) {
          throw new Error('PURPOSE_LAYER_MISMATCH')
        }
        if (result.runtime?.execution_purpose && result.runtime.execution_purpose !== purpose) {
          throw new Error('PURPOSE_LAYER_MISMATCH')
        }

        // Fail closed on missing/invalid reviewed_at (Repair F)
        if (!result.reviewed_at || typeof result.reviewed_at !== 'string') {
          throw new Error('REVIEW_EXECUTION_FAILED: Missing reviewed_at timestamp')
        }

        // Fail closed on missing/invalid scope (Repair F)
        if (!result.scope || !Array.isArray(result.scope)) {
          throw new Error('REVIEW_EXECUTION_FAILED: Missing review scope')
        }
        const candidateScopeSet = new Set(candidate.scope)
        if (result.scope.length !== candidate.scope.length || !result.scope.every((s) => candidateScopeSet.has(s))) {
          throw new Error('REVIEW_EXECUTION_FAILED: Scope mismatch')
        }

        // Fail closed on missing/unmet isolation (Repair F)
        if (!result.isolation) {
          throw new Error('REVIEW_EXECUTION_FAILED: Missing review isolation profile')
        }
        if (
          result.isolation.candidate_write !== false ||
          result.isolation.github_mutation !== false ||
          result.isolation.merge !== false ||
          result.isolation.controller_state_access !== false
        ) {
          throw new Error('REVIEW_EXECUTION_FAILED: Unmet isolation requirements')
        }

        // Fail closed on missing runtime (Repair F)
        if (!result.runtime) {
          throw new Error('REVIEW_EXECUTION_FAILED: Missing review runtime')
        }

        if (input.state_dir) {
          completeReviewChallenge(input.state_dir, challengeId, {
            verdict: result.verdict,
            completed_at: result.reviewed_at,
          })
        }

        const evidence: IndependentReviewEvidenceV3 = {
          schema_version: 3,
          kind: 'independent_agent_review_v3',
          provenance,
          repository: candidate.repository,
          pr_number: prNumber,
          base_sha: candidate.base_sha,
          head_sha: candidate.head_sha,
          candidate_digest: candidate.candidate_digest,
          diff_numstat_digest: candidate.diff_numstat_digest,
          task_id: candidate.task_id,
          task_hash: candidate.task_hash,
          builder,
          reviewer,
          controller_run_id: controllerRunId,
          challenge_id: challengeId,
          runtime: result.runtime,
          review_mode: 'exact_diff',
          execution_purpose: resultPurpose,
          reviewed_at: result.reviewed_at,
          scope: result.scope,
          verdict: result.verdict,
          findings: result.findings ?? [],
          blocking_findings: result.blocking_findings ?? [],
          isolation: result.isolation,
          ...(result.usage ? { usage: result.usage } : {}),
        }

        // Validate the evidence
        validateIndependentReviewEvidenceV3(evidence, {
          candidateScope: candidate.scope,
          now: now(),
          requireAuthoritative: Boolean(input.state_dir),
          producerExecutionId: candidateProducer,
          lineage: (candidate as { lineage?: CandidateProducerLineage }).lineage,
          purpose,
        })

        // Consume challenge
        if (input.state_dir) {
          verifyAndConsumeChallenge(input.state_dir, challengeId, evidence)
        }

        return { reviews: [evidence] as const }
      })

      const settled = await Promise.allSettled(slotPromises)
      const settledWrappers = settleIndependentReviewRound(settled)
      const reviews = settledWrappers.flatMap((w) => w.reviews)

      // If any settled verdict is BLOCK, record it
      for (const review of reviews) {
        if (review.verdict === 'BLOCK' && input.state_dir) {
          recordUnresolvedBlock(candidate.candidate_digest, input.state_dir, review)
        }
      }

      if (reviews.length === 0) {
        throw new Error('REVIEW_EXECUTION_FAILED: No reviews produced')
      }

      const handoffReviews = (reviews.length === 2
        ? [reviews[0], reviews[1]]
        : [reviews[0]]) as [IndependentReviewEvidenceV3] | [IndependentReviewEvidenceV3, IndependentReviewEvidenceV3]

      const handoff: HostReviewHandoffV3 = {
        schema_version: 3,
        kind: 'host_review_handoff_v3',
        provenance,
        repository: candidate.repository,
        pr_number: prNumber,
        base_sha: candidate.base_sha,
        head_sha: candidate.head_sha,
        candidate_digest: candidate.candidate_digest,
        diff_numstat_digest: candidate.diff_numstat_digest,
        task_id: candidate.task_id,
        task_hash: candidate.task_hash,
        controller_run_id: controllerRunId,
        reviews: handoffReviews,
      }

      validateHostReviewHandoffV3(handoff, {
        candidateDigest: candidate.candidate_digest,
        scope: candidate.scope,
        now: now(),
        requireAuthoritative: Boolean(input.state_dir),
        producerExecutionId: candidateProducer,
        lineage: (candidate as { lineage?: CandidateProducerLineage }).lineage,
        purpose,
      })

      return handoff
    },
  }
}
