/**
 * research/analysis/deepAnalysis.ts — deep-read pool orchestration (Slice C)
 *
 * Takes the discovery shortlist and, bounded by the mission budget
 * (max_deep_reads, max_files_per_repo, max_remote_bytes), for each repo:
 * pins an exact-SHA snapshot, runs the quarantined reader (strategy-
 * supplied; the deterministic keyword strategy ships now, a model reader
 * plugs in later without changing contracts), validates every evidence
 * ref deterministically, and extracts Pattern Cards whose evidence_state
 * is earned through validation.
 *
 * Acceptance invariants enforced here: no foreign code execution, no
 * repository writes, no generic shell, no arbitrary URL access, and no
 * unsupported claim reaches SOURCE_CONFIRMED.
 */

import type {
  CandidateRecordV1,
  PatternCardV1,
  RepositoryResearchProvider,
  ResearchMissionV1,
} from '../contracts.js';
import { buildRepositorySnapshot, type RepositorySnapshot } from '../acquisition/snapshot.js';
import { validateEvidenceRefs } from '../acquisition/evidenceValidator.js';
import { openReaderSession, type FinishedSession } from './repoReader.js';
import { extractPatternCard, promoteOnValidEvidence } from './patternExtractor.js';
import { appendJsonl, writeJsonArtifact, type ResearchRunPaths } from '../artifacts.js';
import { extractProblemTerms } from '../queryPlanner.js';

export interface ReaderStrategy {
  readonly name: string;
  run(session: import('./repoReader.js').RepoReaderSession, context: ReaderStrategyContext): unknown;
}

export interface ReaderStrategyContext {
  mission: ResearchMissionV1;
  candidate: CandidateRecordV1;
  problemTerms: string[];
}

export interface DeepAnalysisResult {
  snapshots: Array<RepositorySnapshot>;
  sessions: Array<{ candidate: CandidateRecordV1; finished: FinishedSession }>;
  patterns: PatternCardV1[];
  invalidEvidenceCount: number;
  rejectionCount: number;
}

/**
 * Deterministic keyword strategy: search the snapshot for the problem's
 * mechanism terms, read the strongest hits, and emit conservative
 * observations. This is the placeholder for the model reader; the report
 * contract and validation gate are identical for both.
 */
export const keywordReaderStrategy: ReaderStrategy = {
  name: 'keyword_v1',
  run(session, context) {
    const metadata = session.repo_metadata();
    // Candidate views: content hits from repo_search plus snapshot paths
    // whose names match the problem terms (snapshots are path-selected).
    const windows = new Map<string, { start_line: number; end_line: number }>();
    for (const term of context.problemTerms.slice(0, 6)) {
      for (const hit of session.repo_search(term)) {
        if (!windows.has(hit.path)) windows.set(hit.path, { start_line: hit.start_line, end_line: hit.end_line });
      }
      for (const entry of session.repo_tree()) {
        if (entry.path.toLowerCase().includes(term) && !windows.has(entry.path)) {
          windows.set(entry.path, { start_line: 1, end_line: 30 });
        }
      }
    }
    const observations: Array<Record<string, unknown>> = [];
    const patterns: Array<Record<string, unknown>> = [];
    for (const [path, window] of windows) {
      const first = session.repo_read(path, window.start_line, window.end_line);
      if (!first) continue;
      observations.push({
        claim: `${context.candidate.identity.observed_full_name}:${path} lines ${first.start_line}-${first.end_line} match the problem terms`,
        evidence_ref_ids: [first.evidence_ref_id],
        kind: 'source_observed',
      });
      const symbols = session.repo_symbols(path);
      if (symbols && symbols.symbols.length > 0) {
        patterns.push({
          name: `${path} symbols (${symbols.symbols.slice(0, 3).map((s) => s.name).join(', ')})`,
          mechanism: `implementation surface observed in ${path} at ${metadata.commit_sha.slice(0, 8)}`,
          tradeoffs: [],
        });
      }
    }
    return {
      schema_version: 1,
      problem_match: `keyword strategy matched ${observations.length} bounded views`,
      observations,
      patterns,
      missing_evidence: windows.size === 0 ? ['no snapshot file matched the problem terms'] : [],
    };
  },
};

export async function runDeepAnalysis(
  mission: ResearchMissionV1,
  provider: RepositoryResearchProvider,
  shortlist: CandidateRecordV1[],
  paths: ResearchRunPaths,
  options: { strategy?: ReaderStrategy; now?: Date } = {},
): Promise<DeepAnalysisResult> {
  const strategy = options.strategy ?? keywordReaderStrategy;
  const now = options.now ?? new Date();
  const problemTerms = extractProblemTerms(mission.problem.statement);
  const deepPool = shortlist.slice(0, mission.budget.max_deep_reads);
  const snapshots: Array<RepositorySnapshot> = [];
  const sessions: DeepAnalysisResult['sessions'] = [];
  const patterns: PatternCardV1[] = [];
  let invalidEvidenceCount = 0;
  let rejectionCount = 0;

  for (const candidate of deepPool) {
    const readerTerms = [
      ...new Set([
        ...problemTerms,
        ...extractProblemTerms(candidate.description ?? ''),
        ...candidate.topics.map((topic) => topic.toLowerCase()),
      ]),
    ];
    const snapshot = await buildRepositorySnapshot(provider, candidate.identity, {
      missionId: mission.mission_id,
      now,
      byteBudget: mission.budget.max_remote_bytes,
      maxFiles: mission.budget.max_files_per_repo,
      interestTerms: readerTerms,
    });
    snapshots.push(snapshot);
    appendJsonl(paths.snapshotManifestsJsonl, snapshot.manifest);

    const session = openReaderSession(candidate.identity, snapshot);
    const rawReport = strategy.run(session, { mission, candidate, problemTerms: readerTerms });
    const finished = session.finish(rawReport);
    sessions.push({ candidate, finished });
    rejectionCount += finished.rejectedEvidenceIds.length;

    const validation = validateEvidenceRefs(snapshot, finished.evidenceRefs);
    for (const ref of validation.valid) appendJsonl(paths.evidenceJsonl, ref);
    for (const entry of validation.entries) {
      appendJsonl(paths.evidenceValidationJsonl, entry);
    }
    invalidEvidenceCount += validation.invalid.length;
    const validRefIds = new Set(validation.valid.map((ref) => ref.evidence_id));

    const card = extractPatternCard({
      missionId: mission.mission_id,
      report: finished.report,
      evidenceRefs: validation.valid,
      manifest: snapshot.manifest,
      files: snapshot.files,
      targetHeadSha: mission.target.head_sha,
      now,
    });
    patterns.push(promoteOnValidEvidence(card, validRefIds));
  }

  for (const card of patterns) {
    appendJsonl(paths.patternsJsonl, card);
  }
  writeJsonArtifact(paths.metricsJson.replace('metrics.json', 'deep-analysis.json'), {
    deep_read_count: deepPool.length,
    patterns_proposed: patterns.length,
    patterns_source_confirmed: patterns.filter((p) => p.evidence_state === 'SOURCE_CONFIRMED').length,
    invalid_evidence_refs: invalidEvidenceCount,
    rejected_evidence_ids: rejectionCount,
    strategy: strategy.name,
  });

  return { snapshots, sessions, patterns, invalidEvidenceCount, rejectionCount };
}
