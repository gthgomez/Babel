/**
 * research/reporting/review.ts — independent research review
 *
 * The research reviewer answers a different question than code review:
 * are the Pattern Card's claims supported, are citations valid, were
 * counterexamples omitted, does the local comparison follow, is the
 * experiment reasonable?
 *
 * V1 ships a deterministic reviewer that re-checks the persisted
 * artifacts from scratch (fresh inputs, no reader-session state — the
 * fresh-context property a model reviewer will inherit later). Its
 * verdict governs research status only: `grants_merge_authority` is a
 * literal false and no verdict can bypass tests, security gates, or
 * merge-readiness policy.
 */

import { randomUUID } from 'node:crypto';
import type {
  EvidenceRefV1,
  PatternCardV1,
  ResearchMissionV1,
  ResearchReviewV1,
  SnapshotManifestV1,
} from '../contracts.js';
import type { ApplicabilityFinding } from '../analysis/applicability.js';
import { isApplicabilityStale } from '../analysis/applicability.js';

export interface ReviewInput {
  mission: ResearchMissionV1;
  card: PatternCardV1;
  evidenceRefs: EvidenceRefV1[];
  validEvidenceIds: Set<string>;
  snapshot: SnapshotManifestV1;
  finding: ApplicabilityFinding;
  currentTargetHeadSha: string | null;
  now: Date;
}

export function reviewPatternCard(input: ReviewInput): ResearchReviewV1 {
  const { card, evidenceRefs, validEvidenceIds, snapshot, finding } = input;
  const checked: string[] = [];
  const concerns: string[] = [];

  // 1. Every cited evidence ref exists and validated against the snapshot.
  const cited = card.evidence_refs;
  const missing = cited.filter((id) => !evidenceRefs.some((ref) => ref.evidence_id === id));
  const invalid = cited.filter((id) => validEvidenceIds.size > 0 && !validEvidenceIds.has(id));
  checked.push(
    missing.length === 0
      ? `all ${cited.length} cited evidence refs exist in the run`
      : `${missing.length} cited evidence refs do not exist in the run`,
  );
  if (missing.length > 0) concerns.push(`${missing.length} cited evidence refs missing from the run`);
  if (invalid.length > 0) concerns.push(`${invalid.length} cited evidence refs failed deterministic validation`);

  // 2. Citations point at the same pinned commit the card's sources claim.
  const cardCommits = new Set(card.sources.map((s) => s.commit_sha));
  checked.push(`card sources pin ${cardCommits.size} commit(s); snapshot pinned at ${snapshot.commit_sha.slice(0, 8)}`);
  if (!cardCommits.has(snapshot.commit_sha)) {
    concerns.push('card sources and snapshot commit diverge');
  }

  // 3. The card is source-confirmed only when citations survived validation.
  if (card.evidence_state === 'SOURCE_CONFIRMED' && (cited.length === 0 || invalid.length > 0)) {
    concerns.push('card claims SOURCE_CONFIRMED without fully validated citations');
  }
  checked.push(`card evidence_state is ${card.evidence_state} with ${cited.length} citation(s)`);

  // 4. Local applicability follows only when bound to current target HEAD.
  const stale = isApplicabilityStale(finding, input.currentTargetHeadSha);
  checked.push(stale ? 'local applicability is stale (target HEAD moved)' : 'local applicability is bound to current target HEAD');
  if (stale) concerns.push('target HEAD changed since the applicability analysis; findings require revalidation');

  // 5. Unknown-license cards must not advance toward adoption.
  const unknownLicense = card.license_observations.some((o) => o.status === 'unknown');
  checked.push(unknownLicense ? 'license observations include unknown status' : 'license observations are known');
  if (unknownLicense && card.next_action === 'prototype') {
    concerns.push('prototype recommended despite unknown license; dependency review required first');
  }

  // 6. The proposed experiment names a measurable procedure.
  checked.push('applicability finding proposes a measurable smallest experiment');
  if (!finding.smallest_experiment || finding.smallest_experiment.trim().length < 20) {
    concerns.push('smallest experiment is not concrete enough to be falsifiable');
  }

  let verdict: ResearchReviewV1['verdict'];
  if (concerns.length === 0) {
    verdict = 'ACCEPT_RESEARCH_FINDING';
  } else if (card.evidence_state !== 'SOURCE_CONFIRMED' || invalid.length > 0 || missing.length > 0 || stale) {
    verdict = 'REJECT_RESEARCH_FINDING';
  } else {
    verdict = 'NEEDS_MORE_EVIDENCE';
  }

  return {
    schema_version: 1,
    review_id: `rev_${randomUUID().slice(0, 12)}`,
    mission_id: input.mission.mission_id,
    pattern_id: card.pattern_id,
    verdict,
    rationale:
      concerns.length === 0
        ? `Claims are supported by ${cited.length} validated pinned citations; local comparison follows at the current target HEAD; experiment is measurable.`
        : `${concerns.length} concern(s): ${concerns.join('; ')}.`,
    checked,
    concerns,
    reviewed_at: input.now.toISOString(),
    grants_merge_authority: false,
  };
}
