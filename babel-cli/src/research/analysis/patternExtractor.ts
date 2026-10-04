/**
 * research/analysis/patternExtractor.ts — Pattern Card extraction
 *
 * Builds PatternCardV1 records from finished reader sessions. A card's
 * evidence_state is earned, never asserted: SOURCE_CONFIRMED only when
 * every cited evidence ref survives deterministic validation against the
 * snapshot; otherwise the card stays at DISCOVERED. Cards cite bounded
 * evidence — no copied source files.
 */

import { randomUUID } from 'node:crypto';
import type {
  EvidenceRefV1,
  PatternCardV1,
  RepoReaderReportV1,
  SnapshotManifestV1,
} from '../contracts.js';

export interface ExtractPatternInput {
  missionId: string;
  report: RepoReaderReportV1;
  evidenceRefs: EvidenceRefV1[];
  manifest: SnapshotManifestV1;
  /** Snapshot file contents, used for deterministic license detection. */
  files: Map<string, string>;
  targetHeadSha: string | null;
  now: Date;
}

const SPDX_SIGNATURES: Array<[RegExp, string]> = [
  [/\bApache License\s+Version 2\.0/i, 'Apache-2.0'],
  [/\bMIT License\b/i, 'MIT'],
  [/\bISC License\b/i, 'ISC'],
  [/\bBSD\s+3-Clause\b/i, 'BSD-3-Clause'],
  [/\bBSD\s+2-Clause\b/i, 'BSD-2-Clause'],
  [/\bGNU GENERAL PUBLIC LICENSE\s+Version 3/i, 'GPL-3.0-only'],
  [/\bMPL\s+2\.0/i, 'MPL-2.0'],
  [/\bCreative Commons Zero\b|\bCC0\b/i, 'CC0-1.0'],
];

function licenseObservation(
  manifest: SnapshotManifestV1,
  files: Map<string, string>,
): PatternCardV1['license_observations'] {
  for (const file of manifest.files.filter((f) => f.selection_reason === 'license')) {
    const content = files.get(file.path);
    if (!content) continue;
    for (const [re, spdx] of SPDX_SIGNATURES) {
      if (re.test(content)) {
        return [{ repository_id: manifest.repository_id, spdx_id: spdx, status: 'known' as const }];
      }
    }
  }
  return [{ repository_id: manifest.repository_id, spdx_id: null, status: 'unknown' as const }];
}

export function extractPatternCard(input: ExtractPatternInput): PatternCardV1 {
  const { report, evidenceRefs, manifest } = input;
  const refIds = new Set(evidenceRefs.map((ref) => ref.evidence_id));
  const citedRefs = [
    ...new Set(report.observations.flatMap((observation) => observation.evidence_ref_ids)),
  ].filter((id) => refIds.has(id));

  const firstPattern = report.patterns[0];
  const license = licenseObservation(manifest, input.files);
  const licenseKnown = license[0]!.status === 'known' && license[0]!.spdx_id !== null;

  const card: PatternCardV1 = {
    schema_version: 1,
    pattern_id: `pat_${randomUUID().slice(0, 12)}`,
    mission_id: input.missionId,
    title: firstPattern?.name ?? `${manifest.repository_full_name} approach`,
    problem: report.problem_match || 'analogous engineering problem',
    mechanism: firstPattern?.mechanism ?? 'mechanism not yet characterized',
    preconditions: [],
    tradeoffs: firstPattern?.tradeoffs ?? [],
    evidence_refs: citedRefs,
    sources: [
      { repository_id: manifest.repository_id, commit_sha: manifest.commit_sha },
    ],
    license_observations: license,
    applicability: {
      target_head_sha: input.targetHeadSha,
      local_evidence_refs: [],
      hypothesis: '',
      integration_risks: [],
    },
    next_action: licenseKnown ? 'prototype' : 'dependency_review',
    evidence_state: 'DISCOVERED',
  };
  return card;
}

/**
 * The SOURCE_CONFIRMED transition: every cited ref must validate. A card
 * with zero valid refs stays DISCOVERED. This function is the only place
 * that performs the promotion, and it requires validator output.
 */
export function promoteOnValidEvidence(
  card: PatternCardV1,
  validRefIds: Set<string>,
): PatternCardV1 {
  const allValid =
    card.evidence_refs.length > 0 && card.evidence_refs.every((id) => validRefIds.has(id));
  return allValid ? { ...card, evidence_state: 'SOURCE_CONFIRMED' } : card;
}
