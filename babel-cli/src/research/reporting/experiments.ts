/**
 * research/reporting/experiments.ts — falsifiable experiment proposals
 *
 * Converts a reviewed/validated Pattern Card into an ExperimentProposalV1.
 * A proposal must name the uncertainty it tests (hypothesis), the
 * baseline it compares against, the measurement procedure, at least one
 * metric, and explicit promotion criteria — otherwise it is not a
 * proposal and is rejected here rather than emitted as a vague
 * recommendation.
 */

import { randomUUID } from 'node:crypto';
import { ExperimentProposalV1Schema, type ExperimentProposalV1, type PatternCardV1, type ResearchMissionV1 } from '../contracts.js';
import type { ApplicabilityFinding } from '../analysis/applicability.js';

export class NotFalsifiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFalsifiableError';
  }
}

export interface BuildProposalInput {
  mission: ResearchMissionV1;
  card: PatternCardV1;
  finding: ApplicabilityFinding;
  now: Date;
  /** Overrides for generated content; must keep the proposal falsifiable. */
  overrides?: Partial<Pick<ExperimentProposalV1, 'hypothesis' | 'baseline' | 'experiment' | 'metrics' | 'promotion_criteria'>>;
}

export function buildExperimentProposal(input: BuildProposalInput): ExperimentProposalV1 {
  const { card, finding, mission } = input;
  const gapFocus = finding.gaps[0] ?? card.problem;

  const proposal: ExperimentProposalV1 = {
    schema_version: 1,
    proposal_id: `exp_${randomUUID().slice(0, 12)}`,
    mission_id: mission.mission_id,
    pattern_id: card.pattern_id,
    hypothesis:
      input.overrides?.hypothesis ??
      `Applying ${card.title} (${card.mechanism}) to ${gapFocus} improves the target outcome at equal or lower cost.`,
    baseline:
      input.overrides?.baseline ??
      `Current target behavior at HEAD ${finding.head_sha?.slice(0, 12) ?? 'unknown'} (existing mechanisms: ${
        finding.existing_mechanisms.map((m) => m.path).join(', ') || 'none identified'
      }).`,
    experiment:
      input.overrides?.experiment ??
      `Prototype ${card.title} behind a feature flag on one affected flow; run the same workload against baseline and prototype.`,
    metrics: input.overrides?.metrics ?? ['task_success_rate', 'wall_clock_time', 'input_tokens'],
    promotion_criteria:
      input.overrides?.promotion_criteria ??
      'Promote only if quality metrics improve without unacceptable cost or regression on the remaining metrics.',
    target_head_sha: finding.head_sha,
    created_at: input.now.toISOString(),
  };

  // Falsifiability gate: an empty or content-free required field means the
  // "proposal" tests nothing and must not be emitted.
  const contentful = (value: string): boolean => value.trim().length > 0 && /[a-z]/i.test(value);
  if (
    !contentful(proposal.hypothesis) ||
    !contentful(proposal.baseline) ||
    !contentful(proposal.experiment) ||
    proposal.metrics.length === 0 ||
    !contentful(proposal.promotion_criteria)
  ) {
    throw new NotFalsifiableError(
      `pattern ${card.pattern_id} cannot yield a falsifiable experiment proposal`,
    );
  }

  return ExperimentProposalV1Schema.parse(proposal);
}
