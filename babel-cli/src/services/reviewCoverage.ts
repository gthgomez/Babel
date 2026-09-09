import { createHash } from 'node:crypto';

export interface ToolExecutionTrace {
  tool: string;
  targetPath?: string;
  args?: Record<string, unknown>;
  bytesRead?: number;
}

export interface CoverageExclusion {
  path: string;
  reason: 'lockfile' | 'binary' | 'generated' | 'docs_only' | 'oversized';
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
  is_sufficient: boolean;
  coverage_verdict: 'SUFFICIENT' | 'INSUFFICIENT_REVIEW_COVERAGE';
  receipt_digest: string;
  evaluated_at: string;
}

export function isExcludableFile(path: string): CoverageExclusion | null {
  const norm = path.replace(/\\/g, '/');
  if (norm.match(/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock)$/)) {
    return { path: norm, reason: 'lockfile' };
  }
  if (norm.match(/\.(png|jpe?g|gif|ico|webp|svg|wasm|bin|exe|dll|so|dylib)$/i)) {
    return { path: norm, reason: 'binary' };
  }
  if (norm.match(/(^|\/)(dist|build|\.next|out|coverage|\.turbo)\//) || norm.match(/\.min\.(js|css)$/)) {
    return { path: norm, reason: 'generated' };
  }
  return null;
}

export function evaluateReviewCoverage(input: {
  scope: string[];
  toolTraces: ToolExecutionTrace[];
  claimedReviewedFiles?: string[];
  changesDiffFullyRead?: boolean;
  minCoverageThreshold?: number;
  now?: string;
}): ReviewCoverageReceipt {
  const normScope = [...new Set(input.scope.map((p) => p.replace(/\\/g, '/')))].sort();
  const claimed = [...new Set((input.claimedReviewedFiles ?? []).map((p) => p.replace(/\\/g, '/')))].sort();

  const directlyInspected = new Set<string>();
  const coveredByDiff = new Set<string>();
  const excluded: CoverageExclusion[] = [];

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
    }
  }

  // If changes.diff was fully inspected, small/unopened files are accounted for via diff
  if (input.changesDiffFullyRead) {
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
    is_sufficient: isSufficient,
    coverage_verdict: isSufficient ? 'SUFFICIENT' : 'INSUFFICIENT_REVIEW_COVERAGE',
    receipt_digest: receiptDigest,
    evaluated_at: evaluatedAt,
  };
}
