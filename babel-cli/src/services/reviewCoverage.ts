import { createHash } from 'node:crypto';

export interface ToolExecutionTrace {
  tool: string;
  targetPath?: string;
  args?: Record<string, unknown>;
  bytesRead?: number;
  startLine?: number;
  endLine?: number;
  startByte?: number;
  endByte?: number;
}

export interface CoverageExclusion {
  path: string;
  reason: 'lockfile' | 'binary' | 'generated' | 'docs_only' | 'oversized';
  replacement_evidence?: string;
}

export interface ReviewCoverageReceipt {
  schema_version: 2;
  changed_files_total: number;
  directly_inspected_files: string[];
  covered_by_diff_files: string[];
  excluded_files: CoverageExclusion[];
  unaccounted_files: string[];
  claimed_files: string[];
  observed_coverage_ratio: number;
  claimed_coverage_ratio: number;
  claimed_matches_observed: boolean;
  diff_intervals_observed?: Array<[number, number]>;
  diff_coverage_ratio?: number;
  is_sufficient: boolean;
  coverage_verdict: 'SUFFICIENT' | 'INSUFFICIENT_REVIEW_COVERAGE';
  receipt_digest: string;
  evaluated_at: string;
}

export function isExcludableFile(path: string): CoverageExclusion | null {
  const norm = path.replace(/\\/g, '/');
  if (norm.match(/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock)$/)) {
    return {
      path: norm,
      reason: 'lockfile',
      replacement_evidence: 'dependency_audit_and_lockfile_integrity_gate',
    };
  }
  if (norm.match(/\.(png|jpe?g|gif|ico|webp|svg|wasm|bin|exe|dll|so|dylib)$/i)) {
    return {
      path: norm,
      reason: 'binary',
      replacement_evidence: 'binary_sha256_manifest_and_size_attestation',
    };
  }
  if (norm.match(/(^|\/)(dist|build|\.next|out|coverage|\.turbo)\//) || norm.match(/\.min\.(js|css)$/)) {
    return {
      path: norm,
      reason: 'generated',
      replacement_evidence: 'clean_build_and_source_generation_verification',
    };
  }
  if (norm.match(/\.(md|txt|rst|adoc)$/i) || norm.startsWith('docs/')) {
    return {
      path: norm,
      reason: 'docs_only',
      replacement_evidence: 'trivial_risk_tier_documentation_inspection',
    };
  }
  return null;
}

export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [[sorted[0]![0], sorted[0]![1]]];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const prev = merged[merged.length - 1]!;
    if (current[0] <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], current[1]);
    } else {
      merged.push([current[0], current[1]]);
    }
  }
  return merged;
}

export function evaluateReviewCoverage(input: {
  scope: string[];
  toolTraces: ToolExecutionTrace[];
  claimedReviewedFiles?: string[];
  changesDiffFullyRead?: boolean;
  changesDiffTotalLines?: number;
  minCoverageThreshold?: number;
  now?: string;
}): ReviewCoverageReceipt {
  const normScope = [...new Set(input.scope.map((p) => p.replace(/\\/g, '/')))].sort();
  const claimed = [...new Set((input.claimedReviewedFiles ?? []).map((p) => p.replace(/\\/g, '/')))].sort();

  const directlyInspected = new Set<string>();
  const coveredByDiff = new Set<string>();
  const excluded: CoverageExclusion[] = [];
  const diffIntervals: Array<[number, number]> = [];
  let diffReadFull = false;

  // Track tools executed against paths
  for (const trace of input.toolTraces) {
    let target = trace.targetPath;
    if (!target && trace.args) {
      if (typeof trace.args['path'] === 'string') target = trace.args['path'];
      else if (typeof trace.args['file'] === 'string') target = trace.args['file'];
      else if (typeof trace.args['target'] === 'string') target = trace.args['target'];
    }

    if (target) {
      const normTarget = target.replace(/\\/g, '/').replace(/^source\//, '');
      if (normScope.includes(normTarget)) {
        directlyInspected.add(normTarget);
      }

      if (normTarget.endsWith('changes.diff') || normTarget === 'diff' || normTarget === 'changes') {
        const start = (trace.startLine ?? trace.args?.['start'] ?? trace.args?.['start_line'] ?? trace.args?.['StartLine']) as number | undefined;
        const end = (trace.endLine ?? trace.args?.['end'] ?? trace.args?.['end_line'] ?? trace.args?.['EndLine']) as number | undefined;
        if (start !== undefined && end !== undefined && Number.isInteger(start) && Number.isInteger(end)) {
          diffIntervals.push([start, end]);
        } else {
          diffReadFull = true;
        }
      }
    }
  }

  const mergedIntervals = mergeIntervals(diffIntervals);
  const totalDiffLines = input.changesDiffTotalLines;
  let diffCoverageRatio = 0;
  if (diffReadFull) {
    diffCoverageRatio = 1.0;
  } else if (totalDiffLines && totalDiffLines > 0 && mergedIntervals.length > 0) {
    let coveredLines = 0;
    for (const [s, e] of mergedIntervals) {
      const clampedS = Math.max(1, s);
      const clampedE = Math.min(totalDiffLines, e);
      if (clampedE >= clampedS) {
        coveredLines += (clampedE - clampedS + 1);
      }
    }
    diffCoverageRatio = Math.min(1.0, coveredLines / totalDiffLines);
  }

  // If changes.diff was fully inspected (either derived or explicit fixture override),
  // small/unopened files are accounted for via diff
  const diffFullyObserved = diffReadFull || (diffCoverageRatio >= 1.0) || (input.changesDiffFullyRead === true);
  if (diffFullyObserved) {
    for (const file of normScope) {
      if (!directlyInspected.has(file)) {
        coveredByDiff.add(file);
      }
    }
  }

  const unaccounted: string[] = [];
  for (const file of normScope) {
    const exclusion = isExcludableFile(file);
    if (exclusion) {
      excluded.push(exclusion);
      continue;
    }
    if (!directlyInspected.has(file) && !coveredByDiff.has(file)) {
      unaccounted.push(file);
    }
  }

  const directlyInspectedList = [...directlyInspected].sort();
  const coveredByDiffList = [...coveredByDiff].sort();
  const unaccountedList = unaccounted.sort();

  const accountedCount = normScope.length - unaccountedList.length;
  const observedRatio = normScope.length > 0 ? accountedCount / normScope.length : 1.0;
  const claimedRatio = normScope.length > 0 ? claimed.length / normScope.length : 1.0;

  const threshold = input.minCoverageThreshold ?? 1.0;
  const isSufficient = unaccountedList.length === 0 || observedRatio >= threshold;
  const claimedMatchesObserved =
    claimed.length === directlyInspectedList.length &&
    claimed.every((f) => directlyInspectedList.includes(f));

  const evaluatedAt = input.now ?? new Date().toISOString();
  const digestPayload = [
    normScope,
    directlyInspectedList,
    coveredByDiffList,
    unaccountedList,
    isSufficient,
    evaluatedAt,
  ];
  const receiptDigest = createHash('sha256').update(JSON.stringify(digestPayload)).digest('hex');

  return {
    schema_version: 2,
    changed_files_total: normScope.length,
    directly_inspected_files: directlyInspectedList,
    covered_by_diff_files: coveredByDiffList,
    excluded_files: excluded,
    unaccounted_files: unaccountedList,
    claimed_files: claimed,
    observed_coverage_ratio: observedRatio,
    claimed_coverage_ratio: claimedRatio,
    claimed_matches_observed: claimedMatchesObserved,
    diff_intervals_observed: mergedIntervals,
    diff_coverage_ratio: diffCoverageRatio,
    is_sufficient: isSufficient,
    coverage_verdict: isSufficient ? 'SUFFICIENT' : 'INSUFFICIENT_REVIEW_COVERAGE',
    receipt_digest: receiptDigest,
    evaluated_at: evaluatedAt,
  };
}
