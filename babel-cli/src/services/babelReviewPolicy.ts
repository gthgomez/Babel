/** One independent Babel reviewer is the default; a second is explicit escalation. */
export function babelReviewModels(count: string | undefined, secondReviewExists = false): string[] {
  if (count !== undefined && count !== '1' && count !== '2') throw new Error('INVALID_REVIEWER_COUNT')
  // Never drop an existing second review when resuming the same candidate.
  return count === '2' || secondReviewExists ? ['mimo-v2.5', 'longcat-2.0'] : ['mimo-v2.5']
}

/** Retained private artifacts cannot be approval-shopped by retrying a candidate. */
export function assertNoPriorReviewBlock(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  if (record['verdict'] === 'BLOCK' || (Array.isArray(record['blocking_findings']) && record['blocking_findings'].length > 0)) {
    throw new Error('PRIOR_BLOCKING_REVIEW_REQUIRES_REPAIR')
  }
  if (record['verdict'] && typeof record['verdict'] === 'object') assertNoPriorReviewBlock(record['verdict'])
  if (Array.isArray(record['reviews'])) for (const review of record['reviews']) assertNoPriorReviewBlock(review)
}

/** Publish a validated BLOCK even after a peer fails; never partial approval. */
export function settledBabelReviews<T extends { reviews: readonly { verdict: string }[] }>(settled: PromiseSettledResult<T>[]): T[] {
  const rejected = settled.find(result => result.status === 'rejected')
  const reviews = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  if (rejected && !reviews.some(handoff => handoff.reviews.some(review => review.verdict === 'BLOCK'))) throw rejected.reason
  return reviews
}
