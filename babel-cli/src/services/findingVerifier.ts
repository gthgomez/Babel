import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStructuredFinding, parseFindingFromModelClaim, type StructuredFinding } from './structuredFinding.js';
import { safeReviewPath } from './babelReviewSnapshot.js';

export interface FindingVerificationOptions {
  snapshotRoot: string;
  scope: string[];
}

export function verifyFindingStatically(
  finding: StructuredFinding,
  options: FindingVerificationOptions,
): StructuredFinding {
  const path = finding.location.path.replace(/\\/g, '/');
  const normScope = options.scope.map((p) => p.replace(/\\/g, '/'));
  const normPath = normScope.includes(path) ? path : path.startsWith('source/') && normScope.includes(path.slice(7)) ? path.slice(7) : path;

  // 1. Verify that the file belongs to the candidate scope
  if (normPath === 'unspecified' || !safeReviewPath(normPath) || !normScope.includes(normPath)) {
    return {
      ...finding,
      verification_status: 'LOCATION_INVALID',
      verification_source: 'static_scope_check',
      evidence_refs: [`rejected:path_not_in_candidate_scope:${normPath}`],
    };
  }

  // 2. Verify file exists in inert snapshot
  const diskPath = join(options.snapshotRoot, 'source', normPath);
  const directPath = join(options.snapshotRoot, normPath);
  const targetPath = existsSync(diskPath) ? diskPath : existsSync(directPath) ? directPath : null;

  if (!targetPath) {
    return {
      ...finding,
      verification_status: 'LOCATION_INVALID',
      verification_source: 'static_filesystem_check',
      evidence_refs: [`rejected:file_not_found_in_snapshot:${normPath}`],
    };
  }

  // 3. Verify line bounds if line is specified
  if (finding.location.line !== undefined || finding.location.end_line !== undefined) {
    try {
      const content = readFileSync(targetPath, 'utf8');
      const lines = content.split(/\r?\n/);
      const line = finding.location.line;
      if (line === undefined || !Number.isInteger(line) || line < 1 || line > lines.length ||
          (finding.location.end_line !== undefined && (!Number.isInteger(finding.location.end_line) || finding.location.end_line < line || finding.location.end_line > lines.length))) {
        return {
          ...finding,
          verification_status: 'LOCATION_INVALID',
          verification_source: 'static_bounds_check',
          evidence_refs: [
            `rejected:line_${finding.location.line}_exceeds_total_lines_${lines.length}`,
          ],
        };
      }
    } catch (err) {
      return {
        ...finding,
        verification_status: 'INCONCLUSIVE',
        verification_source: 'static_read_failure',
        evidence_refs: [`inconclusive:unreadable_file:${normPath}`],
      };
    }
  }

  // Location verified on disk in candidate snapshot (structural validity only, not semantic confirmation)
  return {
    ...finding,
    verification_status: 'LOCATION_VALID',
    verification_source: 'static_snapshot_verification',
    evidence_refs: [`location_valid:static_location_verified:${normPath}:${finding.location.line ?? 1}`],
  };
}

/** Canonical findings used by both a fresh result and cache verification. */
export function buildVerifiedReviewFindings(input: {
  candidateDigest: string; executionId: string; reviewerId: string;
  scope: string[]; snapshotRoot: string;
  verdict: { findings: string[]; blocking_findings: string[] };
}): StructuredFinding[] {
  return [...new Set([...input.verdict.blocking_findings, ...input.verdict.findings])].map(claim => {
    const blocking = input.verdict.blocking_findings.includes(claim);
    const parsed = parseFindingFromModelClaim(claim, input.scope);
    return verifyFindingAgainstSnapshot(createStructuredFinding({
      candidateDigest: input.candidateDigest, executionId: input.executionId, reviewerId: input.reviewerId,
      ...parsed, severity: blocking ? 'P1' : 'P2', claim, recommended_blocking: blocking,
    }), input.snapshotRoot, input.scope);
  });
}

/** Project canonical status into the existing wire format, retaining unresolved
 * claims. Structural invalidity does not establish that a serious claim is false. */
export function projectFindingReview(
  raw: { verdict: 'APPROVE' | 'BLOCK'; uncertain: boolean },
  findings: StructuredFinding[],
): { verdict: 'APPROVE' | 'BLOCK'; findings: string[]; blocking_findings: string[] } {
  const projected = findings.map(finding => {
    const semantic = ['SOURCE_SUPPORTED', 'SOURCE_REFUTED', 'REPRODUCED', 'CONFIRMED', 'REJECTED_FALSE_POSITIVE'].includes(finding.verification_status);
    return { finding, text: `[${finding.verification_status}${semantic ? '' : '; semantic validation unavailable'}] ${finding.claim}` };
  });
  const blocking = projected.filter(({ finding }) => finding.policy_blocking &&
    !['SOURCE_REFUTED', 'REJECTED_FALSE_POSITIVE', 'SUPERSEDED', 'DUPLICATE'].includes(finding.verification_status));
  // A refutation alone does not turn the original review's BLOCK/uncertainty
  // into approval. A fresh complete review is needed for that decision.
  return { verdict: raw.verdict === 'BLOCK' || raw.uncertain || blocking.length ? 'BLOCK' : 'APPROVE',
    findings: projected.map(item => item.text), blocking_findings: blocking.map(item => item.text) };
}

export function verifyFindingAgainstSnapshot(
  finding: StructuredFinding,
  snapshotRoot: string,
  scope?: string[],
): StructuredFinding {
  return verifyFindingStatically(finding, {
    snapshotRoot,
    scope: scope ?? [],
  });
}

export function verifyFindingsList(
  findings: StructuredFinding[],
  options: FindingVerificationOptions,
): StructuredFinding[] {
  return findings.map((f) => verifyFindingStatically(f, options));
}

export function corroborateFindings(
  findingsByReviewer: StructuredFinding[][],
): StructuredFinding[] {
  const allFindings = findingsByReviewer.flat();
  const byFingerprint = new Map<string, StructuredFinding[]>();

  for (const f of allFindings) {
    const list = byFingerprint.get(f.finding_fingerprint) ?? [];
    list.push(f);
    byFingerprint.set(f.finding_fingerprint, list);
  }

  const result: StructuredFinding[] = [];
  for (const [fingerprint, instances] of byFingerprint.entries()) {
    const distinctReviewers = new Set(instances.map((i) => i.reviewer_id));
    const base = instances[0]!;

    if (distinctReviewers.size >= 2 && base.verification_status === 'LOCATION_VALID') {
      result.push({
        ...base,
        verification_status: 'CORROBORATED',
        verification_source: 'multi_reviewer_corroboration',
        evidence_refs: [
          ...(base.evidence_refs ?? []),
          `corroborated:distinct_reviewers:${distinctReviewers.size}`,
        ],
      });
    } else {
      result.push(base);
    }
  }

  return result;
}
