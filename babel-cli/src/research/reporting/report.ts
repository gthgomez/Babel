/**
 * research/reporting/report.ts — mission report and metrics
 *
 * Renders the human RESEARCH_REPORT.md and the machine-readable
 * candidate-experiments.json + final metrics.json from validated
 * artifacts only. The report describes research status; it never grants
 * implementation authority — a card that causes a code change enters
 * normal Babel governance.
 */

import { existsSync, readFileSync } from 'node:fs';
import { appendJsonl, readJsonl, writeJsonArtifact, type ResearchRunPaths } from '../artifacts.js';
import type { CandidateRecordV1, EvidenceRefV1, PatternCardV1, ResearchMissionV1, SnapshotManifestV1 } from '../contracts.js';
import { ExperimentProposalV1Schema, ResearchReviewV1Schema, type ExperimentProposalV1, type ResearchReviewV1 } from '../contracts.js';
import type { ApplicabilityFinding } from '../analysis/applicability.js';
import type { DeepAnalysisResult } from '../analysis/deepAnalysis.js';

export interface ReportInputs {
  mission: ResearchMissionV1;
  status: string;
  reason: string | null;
  candidates: CandidateRecordV1[];
  shortlistCount: number;
  deep: DeepAnalysisResult;
  findings: Array<{ patternId: string; finding: ApplicabilityFinding }>;
  proposals: ExperimentProposalV1[];
  reviews: ResearchReviewV1[];
  paths: ResearchRunPaths;
  budget: unknown;
}

export interface FinalMetrics {
  candidate_count: number;
  candidate_count_after_dedup: number;
  shortlist_count: number;
  deep_read_count: number;
  patterns_proposed: number;
  patterns_source_confirmed: number;
  patterns_rejected: number;
  invalid_evidence_refs: number;
  experiments_proposed: number;
  reviews_accepted: number;
  reviews_needs_more_evidence: number;
  reviews_rejected: number;
  remote_bytes: number;
  injection_policy_violations: number;
  tokens_per_accepted_pattern: null;
  status: string;
}

export function renderReportMarkdown(inputs: ReportInputs): string {
  const { mission, deep, proposals, reviews } = inputs;
  const lines: string[] = [];

  lines.push(`# Research Report — ${mission.mission_id}`);
  lines.push('');
  lines.push(`**Problem:** ${mission.problem.statement}`);
  lines.push(`**Status:** ${inputs.status}${inputs.reason ? ` — ${inputs.reason}` : ''}`);
  lines.push(`**Target:** \`${mission.target.project_root}\` @ ${mission.target.head_sha?.slice(0, 12) ?? 'no git'}`);
  lines.push('');
  lines.push('## Discovery');
  lines.push(`- candidates after dedup: ${inputs.candidates.length}`);
  lines.push(`- shortlist (deterministic triage + diversity): ${inputs.shortlistCount}`);
  lines.push(`- deep reads: ${deep.snapshots.length}`);
  lines.push('');
  lines.push('## Pattern Cards');
  if (deep.patterns.length === 0) {
    lines.push('_No pattern cards survived evidence validation._');
  }
  for (const card of deep.patterns) {
    lines.push(`### ${card.title} \`${card.pattern_id}\``);
    lines.push(`- evidence_state: **${card.evidence_state}** · next_action: ${card.next_action}`);
    lines.push(`- mechanism: ${card.mechanism}`);
    lines.push(`- sources: ${card.sources.map((s) => `${s.repository_id}@${s.commit_sha.slice(0, 8)}`).join(', ')}`);
    lines.push(`- citations: ${card.evidence_refs.length} validated evidence ref(s)`);
    const review = reviews.find((r) => r.pattern_id === card.pattern_id);
    if (review) lines.push(`- research review: **${review.verdict}** — ${review.rationale}`);
    const finding = inputs.findings.find((f) => f.patternId === card.pattern_id)?.finding;
    if (finding) {
      lines.push(`- applicability @ HEAD ${finding.head_sha?.slice(0, 12) ?? 'unknown'}:`);
      lines.push(`  - attach points: ${finding.attach_points.map((a) => `${a.path}:${a.start_line}`).join(', ') || 'none identified'}`);
      lines.push(`  - existing mechanisms: ${finding.existing_mechanisms.map((a) => `${a.path}:${a.start_line}`).join(', ') || 'none identified'}`);
      lines.push(`  - gaps: ${finding.gaps.join('; ') || 'none identified'}`);
      if (finding.conflicts.length > 0) lines.push(`  - conflicts: ${finding.conflicts.join('; ')}`);
    }
    lines.push('');
  }
  lines.push('## Experiment Proposals');
  if (proposals.length === 0) {
    lines.push('_No falsifiable experiment proposals were emitted._');
  }
  for (const proposal of proposals) {
    lines.push(`### ${proposal.pattern_id} → \`${proposal.proposal_id}\``);
    lines.push(`- hypothesis: ${proposal.hypothesis}`);
    lines.push(`- baseline: ${proposal.baseline}`);
    lines.push(`- experiment: ${proposal.experiment}`);
    lines.push(`- metrics: ${proposal.metrics.join(', ')}`);
    lines.push(`- promotion: ${proposal.promotion_criteria}`);
    lines.push('');
  }
  lines.push('## Governance boundary');
  lines.push(
    'Research review verdicts govern research status only. They do not authorize code changes: any implementation follows normal Babel tests, security gates, and merge-readiness policy.',
  );
  lines.push('');
  return lines.join('\n');
}

export function computeFinalMetrics(inputs: ReportInputs): FinalMetrics {
  const reviews = inputs.reviews;
  return {
    candidate_count: inputs.candidates.length,
    candidate_count_after_dedup: inputs.candidates.length,
    shortlist_count: inputs.shortlistCount,
    deep_read_count: inputs.deep.snapshots.length,
    patterns_proposed: inputs.deep.patterns.length,
    patterns_source_confirmed: inputs.deep.patterns.filter((p) => p.evidence_state === 'SOURCE_CONFIRMED').length,
    patterns_rejected: reviews.filter((r) => r.verdict === 'REJECT_RESEARCH_FINDING').length,
    invalid_evidence_refs: inputs.deep.invalidEvidenceCount,
    experiments_proposed: inputs.proposals.length,
    reviews_accepted: reviews.filter((r) => r.verdict === 'ACCEPT_RESEARCH_FINDING').length,
    reviews_needs_more_evidence: reviews.filter((r) => r.verdict === 'NEEDS_MORE_EVIDENCE').length,
    reviews_rejected: reviews.filter((r) => r.verdict === 'REJECT_RESEARCH_FINDING').length,
    remote_bytes: inputs.deep.snapshots.reduce((sum, s) => sum + s.manifest.total_bytes, 0),
    injection_policy_violations: inputs.deep.rejectionCount,
    tokens_per_accepted_pattern: null,
    status: inputs.status,
  };
}

export function writeReportArtifacts(inputs: ReportInputs): void {
  const { paths } = inputs;
  writeJsonArtifact(paths.metricsJson, computeFinalMetrics(inputs));
  writeJsonArtifact(`${paths.researchDir}/report/candidate-experiments.json`, {
    mission_id: inputs.mission.mission_id,
    proposals: inputs.proposals,
  });
  for (const review of inputs.reviews) {
    appendJsonl(`${paths.researchDir}/patterns/review.jsonl`, review);
  }
  writeJsonArtifact(`${paths.researchDir}/report/RESEARCH_REPORT.md`, {
    markdown: renderReportMarkdown(inputs),
  });
}

/**
 * Rehydrate validated artifacts from a persisted run (used by
 * `babel research inspect` and future phases). Strict-parses known
 * schemas; unknown records fail loudly.
 */
export function loadRunArtifacts(paths: ResearchRunPaths): {
  mission: ResearchMissionV1;
  candidates: CandidateRecordV1[];
  evidence: EvidenceRefV1[];
  snapshots: SnapshotManifestV1[];
  patterns: PatternCardV1[];
  proposals: ExperimentProposalV1[];
  reviews: ResearchReviewV1[];
} {
  const mission = JSON.parse(readFileSync(paths.missionJson, 'utf8')) as ResearchMissionV1;
  const proposalsPath = `${paths.researchDir}/report/candidate-experiments.json`;
  const proposals = existsSync(proposalsPath)
    ? (JSON.parse(readFileSync(proposalsPath, 'utf8')).proposals as unknown[]).map((p) =>
        ExperimentProposalV1Schema.parse(p),
      )
    : [];
  const reviews = readJsonl<unknown>(`${paths.researchDir}/patterns/review.jsonl`).map((r) =>
    ResearchReviewV1Schema.parse(r),
  );
  return {
    mission,
    candidates: readJsonl<CandidateRecordV1>(paths.candidatesJsonl),
    evidence: readJsonl<EvidenceRefV1>(paths.evidenceJsonl),
    snapshots: readJsonl<SnapshotManifestV1>(paths.snapshotManifestsJsonl),
    patterns: readJsonl<PatternCardV1>(paths.patternsJsonl),
    proposals,
    reviews,
  };
}
