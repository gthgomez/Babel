// License: Apache-2.0 — see LICENSE
// One source of truth for what the prepack stage removes from dist/.

/** Removed wherever they appear (generated test metadata). */
export const ANY_DEPTH_DIST_DIRECTORIES = new Set(['__snapshots__', 'testinfra'])

/** Removed only at these exact dist-relative paths. */
export const EXACT_DIST_DIRECTORIES = new Set(['testUtils', 'testing', 'test-helpers', 'interactive/testing'])

/** Test-only build output that no runtime module imports. */
export const EXACT_DIST_FILES = new Set(['ui/testUtils.js', 'ui/testBackend.js', 'ui/vtTestBackend.js'])

/** Development-only loaders/builders that are not runtime or package-qualification support. */
export const DEVELOPMENT_ONLY_DIST_FILES = new Set([
  'research/v2/fixtures/campaign/papers/arxivPaperExternalCache.js',
  'research/v2/fixtures/general-dev-brief-corpus/verbatimBriefBytes.js',
  'research/v2/engine/testSupport/attempt4EvidenceSubset.js',
  'research/v2/engine/testSupport/attempt4QuestionCoverageDerived.js',
  'research/v2/engine/testSupport/gL2AuditDerivedRegression.js',
  'research/v2/engine/testSupport/gL2OriginalDerivedRegression.js',
  'research/v2/engine/testSupport/gL3Ba45DerivedRegression.js',
  'research/v2/engine/testSupport/gL3OriginalDerivedRegression.js',
  'research/v2/engine/testSupport/missionAdmissionBootstrapBarrier.js',
  'services/traceAuditor/fixtures.js',
])

/** Build debris removed everywhere. */
export const PRUNED_FILE_PATTERN = /\.test\.[cm]?js$|\.map$|\.d\.[cm]?ts$|\.tsbuildinfo$/

/** @param {string} relative dist-relative path without a trailing slash */
export function isPrunedDistDirectory(relative) {
  return ANY_DEPTH_DIST_DIRECTORIES.has(relative.split('/').pop()) || EXACT_DIST_DIRECTORIES.has(relative)
}

/** @param {string} relative dist-relative file path */
export function isPrunedDistFile(relative) {
  return EXACT_DIST_FILES.has(relative) || DEVELOPMENT_ONLY_DIST_FILES.has(relative) || PRUNED_FILE_PATTERN.test(relative)
}
