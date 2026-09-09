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
  if (!normScope.includes(normPath)) {
    return {
      ...finding,
      verification_status: 'REJECTED_FALSE_POSITIVE',
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
      verification_status: 'REJECTED_FALSE_POSITIVE',
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
          verification_status: 'REJECTED_FALSE_POSITIVE',
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

  // File and line span verified statically in candidate snapshot
  return {
    ...finding,
    verification_status: 'CONFIRMED',
    verification_source: 'static_snapshot_verification',
    evidence_refs: [`confirmed:static_location_verified:${normPath}:${finding.location.line ?? 1}`],
  };
}

export function verifyFindingsList(
  findings: StructuredFinding[],
  options: FindingVerificationOptions,
): StructuredFinding[] {
  return findings.map((f) => verifyFindingStatically(f, options));
}
