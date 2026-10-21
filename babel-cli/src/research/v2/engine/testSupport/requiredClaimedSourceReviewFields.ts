/** Synthetic review fields required by SemanticSupportReviewOutputSchema (deterministic tests). */
export function requiredClaimedSourceReviewFields(
  sourceSlots: readonly string[],
  attribution:
    | 'matches_admitted_citations'
    | 'names_unfetched_or_unread_source'
    | 'not_assessed' = 'matches_admitted_citations',
): {
  claimed_source_attribution: typeof attribution
  claimed_source_slots: string[]
} {
  return {
    claimed_source_attribution: attribution,
    claimed_source_slots: [...sourceSlots],
  }
}
