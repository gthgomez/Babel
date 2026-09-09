import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StructuredFinding } from './structuredFinding.js';

export interface FindingVerificationOptions {
  snapshotRoot: string;
  scope: string[];
}

export function verifyFindingStatically(
  finding: StructuredFinding,
  options: FindingVerificationOptions,
): StructuredFinding {
  const normPath = finding.location.path.replace(/\\/g, '/').replace(/^source\//, '');
  const normScope = options.scope.map((p) => p.replace(/\\/g, '/').replace(/^source\//, ''));

  // 1. Verify that the file belongs to the candidate scope
  if (normPath === 'unspecified' || !normScope.includes(normPath)) {
    return {
      ...finding,
      verification_status: 'LOCATION_INVALID',
      verification_source: 'static_scope_check',
      evidence_refs: [`rejected:path_not_in_candidate_scope:${normPath}`],
    };
  }

  // 2. Verify file exists in inert snapshot
  const diskPath = join(options.snapshotRoot, normPath.startsWith('source/') ? normPath : `source/${normPath}`);
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
  if (finding.location.line) {
    try {
      const content = readFileSync(targetPath, 'utf8');
      const lines = content.split(/\r?\n/);
      if (finding.location.line > lines.length) {
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
