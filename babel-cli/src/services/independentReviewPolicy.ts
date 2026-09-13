import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicReviewJson } from './babelReviewQueue.js'

export interface IndependentReviewPlan {
  reviewerCount: 1 | 2
}

/**
 * Resolves the independent review plan.
 * Default is 1 independent reviewer. Explicit escalation allows 2 reviewers.
 */
export function resolveIndependentReviewPlan(options?: {
  reviewerCount?: number | string
  hasExistingSecondReview?: boolean
}): IndependentReviewPlan {
  const raw = options?.reviewerCount
  let count: 1 | 2 = 1
  if (raw !== undefined) {
    const num = typeof raw === 'string' ? Number(raw) : raw
    if (num !== 1 && num !== 2) {
      throw new Error('INVALID_REVIEWER_COUNT')
    }
    count = num as 1 | 2
  } else if (options?.hasExistingSecondReview) {
    count = 2
  }
  return { reviewerCount: count }
}

/**
 * Inspects a value or object graph for prior blocking verdicts.
 * Throws PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR if any blocking verdict or blocking findings exist.
 */
export function assertNoPriorBlockInRecord(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (
    record['verdict'] === 'BLOCK' ||
    (Array.isArray(record['blocking_findings']) && record['blocking_findings'].length > 0)
  ) {
    throw new Error('PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR')
  }
  if (record['verdict'] && typeof record['verdict'] === 'object') {
    assertNoPriorBlockInRecord(record['verdict'])
  }
  if (record['evidence'] && typeof record['evidence'] === 'object') {
    assertNoPriorBlockInRecord(record['evidence'])
  }
  if (Array.isArray(record['reviews'])) {
    for (const review of record['reviews']) {
      assertNoPriorBlockInRecord(review)
    }
  }
}

/**
 * Retained private artifacts cannot be approval-shopped by retrying an unchanged candidate.
 * If a candidate digest has a recorded BLOCK in state, this check fails closed.
 */
export function assertNoUnresolvedPriorBlock(candidateDigest: string, stateDir?: string): void {
  if (!stateDir) return
  const jobDir = join(stateDir, 'jobs', candidateDigest)
  if (!existsSync(jobDir)) return

  const retainedBlockPath = join(jobDir, 'retained-block.json')
  if (existsSync(retainedBlockPath)) {
    const data = JSON.parse(readFileSync(retainedBlockPath, 'utf8'))
    assertNoPriorBlockInRecord(data)
    throw new Error('PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR')
  }

  for (const name of readdirSync(jobDir)) {
    if (name.endsWith('.json') && !name.includes('cache-rejected') && !name.includes('running')) {
      try {
        const content = JSON.parse(readFileSync(join(jobDir, name), 'utf8'))
        assertNoPriorBlockInRecord(content)
      } catch (err: unknown) {
        if ((err as Error).message === 'PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR') {
          throw err
        }
      }
    }
  }
}

/**
 * Persists an unresolved blocking review for a candidate digest so any subsequent
 * retry without code repair fails closed.
 */
export function recordUnresolvedBlock(candidateDigest: string, stateDir: string, evidence: unknown): void {
  const jobDir = join(stateDir, 'jobs', candidateDigest)
  mkdirSync(jobDir, { recursive: true, mode: 0o700 })
  const retainedBlockPath = join(jobDir, 'retained-block.json')
  atomicReviewJson(retainedBlockPath, {
    recorded_at: new Date().toISOString(),
    candidate_digest: candidateDigest,
    evidence,
  })
}

/**
 * Settles an independent review execution round:
 * - A valid BLOCK must reach GitHub even if a peer reviewer failed.
 * - If any reviewer failed and NO reviewer returned BLOCK, the round fails
 *   (REVIEW_EXECUTION_FAILED) so a fresh reviewer can be attempted.
 * - Partial success can NEVER publish approval.
 */
export function settleIndependentReviewRound<T extends { reviews: readonly { verdict: string }[] }>(
  settled: PromiseSettledResult<T>[]
): T[] {
  const rejected = settled.find(r => r.status === 'rejected')
  const reviews = settled.flatMap(r => r.status === 'fulfilled' ? [r.value] : [])
  const hasBlock = reviews.some(h => h.reviews.some(r => r.verdict === 'BLOCK'))

  if (rejected) {
    if (hasBlock) {
      // Substantive block takes priority: return the fulfilled block so it is retained and published
      return reviews
    }
    // Execution failure with no block -> throw the failure so it can be retried fresh
    throw rejected.reason
  }

  return reviews
}
