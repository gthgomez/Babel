/**
 * research/reporting/report.ts — mission report and metrics
 *
 * Renders the human RESEARCH_REPORT.md and the machine-readable
 * candidate-experiments.json + final metrics.json from validated
 * artifacts only. The report describes research status; it never grants
 * implementation authority — a card that causes a code change enters
 * normal Babel governance.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendJsonl, readJsonl, writeJsonArtifact, type ResearchRunPaths } from '../artifacts.js';
import type { CandidateRecordV1, EvidenceRefV1, PatternCardV1, ResearchMissionV1, SnapshotManifestV1 } from '../contracts.js';
import { CandidateRecordV1Schema, EvidenceRefV1Schema, EvidenceValidationEntryV1Schema, ExperimentProposalV1Schema, PatternCardV1Schema, ResearchApplicabilityRecordV1Schema, ResearchMissionV1Schema, ResearchReviewV1Schema, SnapshotManifestV1Schema, TriageScoreBreakdownSchema, type ExperimentProposalV1, type ResearchApplicabilityRecordV1, type ResearchReviewV1 } from '../contracts.js';
import type { ApplicabilityFinding } from '../analysis/applicability.js';
import type { DeepAnalysisResult } from '../analysis/deepAnalysis.js';
import { z } from 'zod';

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
  metrics?: { candidate_count: number; candidate_count_after_dedup: number; candidate_count_after_triage: number; shortlist_count: number; queries_executed: number; fork_family_collapsed: number; duplicate_discoveries: number };
  deepStatus?: string;
  deepReason?: string | null;
  localScanBudget?: { maxFiles: number; maxBytes: number; filesScanned: number; bytesScanned: number; exhausted: boolean; occurrencesTruncated: boolean };
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
  reason: string | null;
  deep_analysis_status: string | null;
  deep_analysis_reason: string | null;
  budget: unknown;
  discovery: ReportInputs['metrics'];
  local_scan_budget: ReportInputs['localScanBudget'] | null;
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
      const localEvidence = [...finding.attach_points, ...finding.existing_mechanisms];
      if (localEvidence.length > 0) {
        lines.push(`  - local content SHA-256: ${localEvidence.map((ref) => `${ref.path}:${ref.start_line}=${ref.content_hash}`).join(', ')}`);
      }
      if (finding.scan_budget_exhausted || finding.occurrences_truncated) {
        lines.push('  - local scan: partial; a finite scan limit was reached');
      }
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
    ...inputs.metrics,
    candidate_count: inputs.metrics?.candidate_count ?? inputs.candidates.length,
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
    reason: inputs.reason,
    deep_analysis_status: inputs.deepStatus ?? null,
    deep_analysis_reason: inputs.deepReason ?? null,
    budget: inputs.budget,
    discovery: inputs.metrics,
    local_scan_budget: inputs.localScanBudget ?? null,
  };
}

export function writeReportArtifacts(inputs: ReportInputs): void {
  const { paths } = inputs;
  const patternRecords = inputs.deep.patterns.map((card) => PatternCardV1Schema.parse(card));
  writeJsonlAtomic(paths.patternsJsonl, patternRecords);
  const applicabilityPath = `${paths.researchDir}/patterns/applicability.jsonl`;
  const applicabilityRecords = inputs.findings.map(({ patternId, finding }) =>
    ResearchApplicabilityRecordV1Schema.parse({ pattern_id: patternId, finding }),
  );
  writeJsonlAtomic(applicabilityPath, applicabilityRecords);
  writeJsonArtifact(paths.metricsJson, computeFinalMetrics(inputs));
  writeJsonArtifact(`${paths.researchDir}/report/candidate-experiments.json`, {
    mission_id: inputs.mission.mission_id,
    proposals: inputs.proposals,
  });
  for (const review of inputs.reviews) {
    appendJsonl(`${paths.researchDir}/patterns/review.jsonl`, review);
  }
  const markdownPath = `${paths.researchDir}/report/RESEARCH_REPORT.md`;
  const markdownTmp = `${markdownPath}.tmp`;
  writeFileSync(markdownTmp, renderReportMarkdown(inputs), 'utf8');
  renameSync(markdownTmp, markdownPath);
}

function writeJsonlAtomic(filePath: string, records: unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  const contents = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileSync(temporaryPath, contents.length > 0 ? `${contents}\n` : '', 'utf8');
  renameSync(temporaryPath, filePath);
}

function verifyLocalEvidenceContent(targetRoot: string, ref: { path: string; start_line: number; end_line: number; content_hash: string }): void {
  const segments = ref.path.split(/[\\/]/);
  let currentPath = targetRoot;
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    const stat = lstatSync(currentPath);
    if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) {
      throw new Error(`Local applicability path is not a regular target-tree path: ${ref.path}`);
    }
  }
  const stat = lstatSync(currentPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Local applicability path is not a regular file: ${ref.path}`);
  }
  const lines = readFileSync(currentPath, 'utf8').split('\n');
  if (ref.end_line > lines.length) throw new Error(`Local applicability line range is missing: ${ref.path}:${ref.start_line}`);
  const excerpt = lines.slice(ref.start_line - 1, ref.end_line).join('\n');
  const actualHash = createHash('sha256').update(excerpt).digest('hex');
  if (actualHash !== ref.content_hash) {
    throw new Error(`Local applicability content hash mismatch: ${ref.path}:${ref.start_line}`);
  }
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
  applicability: ResearchApplicabilityRecordV1[];
  proposals: ExperimentProposalV1[];
  reviews: ResearchReviewV1[];
} {
  const mission = ResearchMissionV1Schema.parse(JSON.parse(readFileSync(paths.missionJson, 'utf8')));
  const proposalsPath = `${paths.researchDir}/report/candidate-experiments.json`;
  const proposalDocument = existsSync(proposalsPath) ? JSON.parse(readFileSync(proposalsPath, 'utf8')) : { mission_id: mission.mission_id, proposals: [] };
  const proposals = z.object({ mission_id: z.string().min(1), proposals: z.array(ExperimentProposalV1Schema) }).strict().parse(proposalDocument).proposals;
  const reviews = readJsonl<unknown>(`${paths.researchDir}/patterns/review.jsonl`).map((r) => ResearchReviewV1Schema.parse(r));
  const validateJsonl = <T>(filePath: string, schema: { parse(value: unknown): T }): T[] => readJsonl<unknown>(filePath).map((record) => schema.parse(record));
  validateJsonl(paths.scoreBreakdownJsonl, TriageScoreBreakdownSchema);
  validateJsonl(paths.evidenceValidationJsonl, EvidenceValidationEntryV1Schema);
  const applicabilityPath = `${paths.researchDir}/patterns/applicability.jsonl`;
  const hasApplicabilityArtifact = existsSync(applicabilityPath);
  const applicability = hasApplicabilityArtifact
    ? validateJsonl(applicabilityPath, ResearchApplicabilityRecordV1Schema)
    : [];
  const patterns = validateJsonl(paths.patternsJsonl, PatternCardV1Schema);
  const applicabilityByPattern = new Map(applicability.map((record) => [record.pattern_id, record]));
  for (const card of patterns) {
    const hasPersistedFinding =
      card.applicability.local_evidence_refs.length > 0 ||
      card.applicability.hypothesis.length > 0 ||
      card.applicability.integration_risks.length > 0 ||
      card.applicability.target_head_sha !== mission.target.head_sha;
    if (!hasApplicabilityArtifact && hasPersistedFinding) {
      throw new Error(`Applicability artifact is missing for populated pattern: ${card.pattern_id}`);
    }
    if (hasPersistedFinding && !applicabilityByPattern.has(card.pattern_id)) {
      throw new Error(`Applicability record is missing for populated pattern: ${card.pattern_id}`);
    }
  }
  for (const record of applicability) {
    const card = patterns.find((item) => item.pattern_id === record.pattern_id);
    if (!card) throw new Error(`Applicability record has no persisted pattern: ${record.pattern_id}`);
    if (card.applicability.target_head_sha !== record.finding.head_sha) {
      throw new Error(`Applicability HEAD binding differs from persisted pattern: ${record.pattern_id}`);
    }
    const persistedRefs = new Set(card.applicability.local_evidence_refs);
    const findingRefs = [...record.finding.attach_points, ...record.finding.existing_mechanisms];
    if (findingRefs.some((ref) => !persistedRefs.has(ref.local_ref_id))) {
      throw new Error(`Applicability evidence refs differ from persisted pattern: ${record.pattern_id}`);
    }
    for (const ref of findingRefs) verifyLocalEvidenceContent(mission.target.project_root, ref);
  }
  return {
    mission,
    candidates: validateJsonl(paths.candidatesJsonl, CandidateRecordV1Schema),
    evidence: validateJsonl(paths.evidenceJsonl, EvidenceRefV1Schema),
    snapshots: validateJsonl(paths.snapshotManifestsJsonl, SnapshotManifestV1Schema),
    patterns,
    applicability,
    proposals,
    reviews,
  };
}
