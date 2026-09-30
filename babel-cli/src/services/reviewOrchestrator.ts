import { randomUUID } from 'node:crypto'
import type { CandidateEnvelope } from './hostReviewController.js'
import {
  createIndependentReviewController,
  type AutonomousEngineeringWorkerAdapter,
  type AutonomousRepairResult,
  type IndependentReviewController,
  type IndependentReviewExecutionRequest,
} from './independentReviewController.js'
import type {
  CandidateProducerLineage,
  HostReviewHandoffV3,
  IndependentReviewIsolationProfile,
  ReviewActorIdentity,
} from './independentReviewEvidenceV3.js'
import { resolveReviewPolicy, type ReviewRiskLane } from './reviewPolicy.js'

/** Machine-readable orchestration phases an external coding agent can act on. */
export type OrchestrationStatus =
  | 'COLLECTED'
  | 'REVIEWING'
  | 'BLOCKED'
  | 'REPAIRING'
  | 'RETESTING'
  | 'CERTIFYING'
  | 'WAITING_FOR_CI'
  | 'MERGE_READY'
  | 'ESCALATED'

export interface OrchestrationResult {
  status: OrchestrationStatus
  headSha: string
  candidateDigest: string
  /** Present when a round produced authoritative V3 evidence. */
  handoff?: HostReviewHandoffV3
  blockingFindings: string[]
  repairRounds: number
  message: string
}

export interface CollectCandidateOptions {
  headSha?: string
  lineage?: CandidateProducerLineage
  producerExecutionId?: string
}

export type CollectCandidate = (options: CollectCandidateOptions) => Promise<CandidateEnvelope>

const REQUIRED_ISOLATION: IndependentReviewIsolationProfile = Object.freeze({
  candidate_write: false,
  github_mutation: false,
  merge: false,
  controller_state_access: false,
})

/**
 * Bounded review -> repair -> fresh-certification loop.
 *
 * The certifying review for a head is always a fresh controller execution: when
 * a round blocks and a repair produces a new head, the previous round's approval
 * (and its challenge) is never reused, and the next round launches new reviewer
 * executions against the new candidate. The controller rejects a reviewer that
 * is the builder or the candidate producer (repair lineage), so a fixer cannot
 * certify the candidate it produced.
 */
export async function runReviewOrchestration(options: {
  adapter: AutonomousEngineeringWorkerAdapter
  collectCandidate: CollectCandidate
  stateDir: string
  builder: ReviewActorIdentity
  controllerId?: string
  maxRepairRounds?: number
  now?: () => number
  onStatus?: (status: OrchestrationStatus, detail?: string) => void
}): Promise<OrchestrationResult> {
  const controllerId = options.controllerId ?? 'orchestrated-review'
  const maxRepairRounds = options.maxRepairRounds ?? 3
  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 10) {
    throw new Error('INVALID_MAX_REPAIR_ROUNDS')
  }
  const emit = (status: OrchestrationStatus, detail?: string): void => {
    options.onStatus?.(status, detail)
  }

  const controller: IndependentReviewController = createIndependentReviewController({
    controller_id: controllerId,
    state_dir: options.stateDir,
    adapter: options.adapter,
    ...(options.now ? { now: options.now } : {}),
  })

  let candidate = await options.collectCandidate({})
  emit('COLLECTED', candidate.head_sha)
  let repairRounds = 0

  while (true) {
    emit('REVIEWING', candidate.head_sha)
    const policy = resolveReviewPolicy({
      riskLane: candidate.risk_tier as ReviewRiskLane,
      requireAuthoritative: true,
    })

    let handoff: HostReviewHandoffV3
    try {
      handoff = await controller.review(candidate, {
        reviewCount: policy.finalCertificationCount,
        builder: options.builder,
        purpose: 'FINAL_CERTIFICATION',
      })
    } catch (error) {
      // A controller failure (including anti-approval-shopping or a certification
      // independence violation) is an explicit escalation, never a merge.
      return {
        status: 'ESCALATED',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        blockingFindings: [],
        repairRounds,
        message: `controller_error:${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // Certification requires EVERY review to be an explicit APPROVE with no
    // blocking findings. A BLOCK verdict with an empty findings list must never
    // be read as approval (the verdict is authoritative, not the array).
    const blocking: string[] = handoff.reviews.flatMap((review) =>
      review.verdict === 'APPROVE'
        ? review.blocking_findings
        : review.blocking_findings.length > 0
          ? review.blocking_findings
          : [`reviewer ${review.reviewer.execution_id} returned BLOCK without blocking_findings`],
    )
    const allApproved = handoff.reviews.every((review) => review.verdict === 'APPROVE')
    if (allApproved && blocking.length === 0) {
      emit('MERGE_READY', candidate.head_sha)
      return {
        status: 'MERGE_READY',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        handoff,
        blockingFindings: [],
        repairRounds,
        message: 'certified',
      }
    }

    emit('BLOCKED', `${blocking.length} blocking finding(s)`)
    if (!options.adapter.repair) {
      // Blocked, awaiting repair by the orchestrating agent. This is not an
      // escalation: the caller is expected to repair and re-run certification.
      return {
        status: 'BLOCKED',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        handoff,
        blockingFindings: blocking,
        repairRounds,
        message: 'repair_not_supported',
      }
    }
    if (repairRounds >= maxRepairRounds) {
      return {
        status: 'ESCALATED',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        handoff,
        blockingFindings: blocking,
        repairRounds,
        message: 'max_repair_rounds_exhausted',
      }
    }

    repairRounds += 1
    emit('REPAIRING', `round ${repairRounds}`)
    const repairRequest: IndependentReviewExecutionRequest = {
      controller_id: controllerId,
      controller_run_id: randomUUID(),
      challenge_id: randomUUID(),
      candidate,
      builder: options.builder,
      reviewer: {
        kind: options.adapter.agent_kind,
        principal_id: randomUUID(),
        execution_id: randomUUID(),
      },
      review_mode: 'exact_diff',
      required_isolation: REQUIRED_ISOLATION,
      purpose: 'REVIEW_REPAIR',
      findings: blocking,
    }
    let repairResult: AutonomousRepairResult
    try {
      repairResult = await options.adapter.repair(repairRequest)
    } catch (error) {
      return {
        status: 'ESCALATED',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        handoff,
        blockingFindings: blocking,
        repairRounds,
        message: `repair_error:${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (repairResult.status !== 'COMPLETED' || !repairResult.modified || !repairResult.new_head_sha) {
      return {
        status: 'ESCALATED',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        handoff,
        blockingFindings: blocking,
        repairRounds,
        message: `repair_failed:${repairResult.failure_reason ?? 'unknown'}`,
      }
    }
    emit('RETESTING', repairResult.new_head_sha)
    const blockedDigest = candidate.diff_numstat_digest
    const lineage: CandidateProducerLineage = {
      parent_head_sha: candidate.head_sha,
      new_head_sha: repairResult.new_head_sha,
      producer: repairResult.producer,
      produced_at: new Date().toISOString(),
    }
    const nextCandidate = await options.collectCandidate({
      headSha: repairResult.new_head_sha,
      lineage,
      producerExecutionId: repairResult.producer.execution_id,
    })
    if (nextCandidate.head_sha !== repairResult.new_head_sha) {
      return {
        status: 'ESCALATED',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        handoff,
        blockingFindings: blocking,
        repairRounds,
        message: 'collect_candidate_head_mismatch',
      }
    }
    // Authoritative no-op-mutation guard: compare the re-collected candidate's
    // own diff digest to the blocked candidate, independent of any optional
    // adapter-supplied digest with a different normalization.
    if (nextCandidate.diff_numstat_digest === blockedDigest) {
      return {
        status: 'ESCALATED',
        headSha: candidate.head_sha,
        candidateDigest: candidate.candidate_digest,
        handoff,
        blockingFindings: blocking,
        repairRounds,
        message: 'repair_produced_no_diff_change',
      }
    }
    candidate = nextCandidate
    emit('CERTIFYING', candidate.head_sha)
  }
}
