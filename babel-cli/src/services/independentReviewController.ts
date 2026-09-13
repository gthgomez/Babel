import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicReviewJson } from './babelReviewQueue.js'
import {
  type HostReviewHandoffV3,
  type IndependentReviewEvidenceV3,
  type IndependentReviewIsolationProfile,
  type IndependentReviewRuntime,
  type IndependentReviewUsage,
  type ReviewActorIdentity,
  validateHostReviewHandoffV3,
  validateIndependentReviewEvidenceV3,
} from './independentReviewEvidenceV3.js'
import { assertNoUnresolvedPriorBlock, recordUnresolvedBlock } from './independentReviewPolicy.js'
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
  consumed_at?: string
}

export function issueReviewChallenge(stateDir: string, challenge: PersistentReviewChallenge): void {
  const challengesDir = join(stateDir, 'challenges')
  mkdirSync(challengesDir, { recursive: true, mode: 0o700 })
  const challengePath = join(challengesDir, `${challenge.challenge_id}.json`)
  if (existsSync(challengePath)) {
    throw new Error(`CHALLENGE_ALREADY_EXISTS: ${challenge.challenge_id}`)
  }
  atomicReviewJson(challengePath, challenge)
}

export function verifyAndConsumeChallenge(
  stateDir: string,
  challengeId: string,
  evidence: IndependentReviewEvidenceV3
): void {
  const challengePath = join(stateDir, 'challenges', `${challengeId}.json`)
  if (!existsSync(challengePath)) {
    throw new Error(`CHALLENGE_NOT_FOUND: ${challengeId}`)
  }
  const raw = JSON.parse(readFileSync(challengePath, 'utf8')) as PersistentReviewChallenge
  if (raw.status === 'CONSUMED') {
    throw new Error(`CHALLENGE_ALREADY_CONSUMED: ${challengeId}`)
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
  candidate: Readonly<CandidateEnvelope | HostReviewCandidate>
  builder: ReviewActorIdentity
  reviewer: ReviewActorIdentity
  review_mode: 'exact_diff'
  required_isolation: IndependentReviewIsolationProfile
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
  usage?: IndependentReviewUsage
}

export interface IndependentReviewWorkerAdapter {
  readonly adapter_id: string
  readonly agent_kind: string
  launch(request: Readonly<IndependentReviewExecutionRequest>): Promise<IndependentReviewExecutionResult>
}

export interface IndependentReviewController {
  review(
    candidate: Readonly<CandidateEnvelope | (HostReviewCandidate & { candidate_digest: string })>,
    options?: {
      reviewCount?: 1 | 2
      builder?: ReviewActorIdentity
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
      candidate: Readonly<CandidateEnvelope | (HostReviewCandidate & { candidate_digest: string })>,
      options?: {
        reviewCount?: 1 | 2
        builder?: ReviewActorIdentity
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
      const builder: ReviewActorIdentity = options?.builder ?? {
        kind: 'codex',
        principal_id: `builder-principal-${createId()}`,
        execution_id: `builder-exec-${createId()}`,
      }

      const reviews: IndependentReviewEvidenceV3[] = []
      const usedPrincipals = new Set<string>()
      const usedExecutions = new Set<string>()

      for (let i = 0; i < reviewCount; i++) {
        const reviewerPrincipalId = createId()
        const reviewerExecutionId = createId()

        if (reviewerPrincipalId === builder.principal_id || usedPrincipals.has(reviewerPrincipalId)) {
          throw new Error('REVIEWER_PRINCIPAL_NOT_INDEPENDENT')
        }
        if (reviewerExecutionId === builder.execution_id || usedExecutions.has(reviewerExecutionId)) {
          throw new Error('REVIEWER_EXECUTION_NOT_DISTINCT')
        }
        usedPrincipals.add(reviewerPrincipalId)
        usedExecutions.add(reviewerExecutionId)

        const reviewer: ReviewActorIdentity = {
          kind: input.adapter.agent_kind,
          principal_id: reviewerPrincipalId,
          execution_id: reviewerExecutionId,
        }

        const challengeId = createId()

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
        }

        const result = await input.adapter.launch(request)
        if (result.status !== 'COMPLETED') {
          throw new Error(`REVIEW_EXECUTION_FAILED: ${result.failure_reason || 'Unknown adapter failure'}`)
        }

        const runtime: IndependentReviewRuntime = result.runtime ?? {
          agent_kind: input.adapter.agent_kind,
          adapter_id: input.adapter.adapter_id,
          controller_execution_id: reviewerExecutionId,
        }

        const evidence: IndependentReviewEvidenceV3 = {
          schema_version: 3,
          kind: 'independent_agent_review_v3',
          provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
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
          runtime,
          review_mode: 'exact_diff',
          reviewed_at: result.reviewed_at ?? new Date(now()).toISOString(),
          scope: result.scope ?? [...candidate.scope],
          verdict: result.verdict ?? 'APPROVE',
          findings: result.findings ?? [],
          blocking_findings: result.blocking_findings ?? [],
          isolation: result.isolation ?? requiredIsolation,
          ...(result.usage ? { usage: result.usage } : {}),
        }

        // Validate the evidence
        validateIndependentReviewEvidenceV3(evidence, {
          candidateScope: candidate.scope,
          now: now(),
        })

        // Consume challenge
        if (input.state_dir) {
          verifyAndConsumeChallenge(input.state_dir, challengeId, evidence)
        }

        // If verdict is BLOCK, record it
        if (evidence.verdict === 'BLOCK' && input.state_dir) {
          recordUnresolvedBlock(candidate.candidate_digest, input.state_dir, evidence)
        }

        reviews.push(evidence)
      }

      const handoffReviews = (reviewCount === 2
        ? [reviews[0], reviews[1]]
        : [reviews[0]]) as [IndependentReviewEvidenceV3] | [IndependentReviewEvidenceV3, IndependentReviewEvidenceV3]

      const handoff: HostReviewHandoffV3 = {
        schema_version: 3,
        kind: 'host_review_handoff_v3',
        provenance: 'TRUSTED_CONTROLLER_EVIDENCE',
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
      })

      return handoff
    },
  }
}
