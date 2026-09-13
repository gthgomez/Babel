import { createHash } from 'node:crypto';
import { z } from 'zod';

export type BenchmarkSplit = 'dev' | 'holdout' | 'canary';
export type BenchmarkCategory = 'correctness' | 'security' | 'concurrency' | 'clean_control';
export type BenchmarkDifficulty = 'trivial' | 'medium' | 'hard';

export const MINIMUM_BENCHMARK_PROMOTION_SIZE = 10;

/** Reviewer-facing fixture with NO ground truth or answer keys. */
export interface ReviewerFixture {
  id: string;
  name: string;
  category: BenchmarkCategory;
  difficulty: BenchmarkDifficulty;
  split: BenchmarkSplit;
  files: Record<string, string>;
  candidateDiff: string;
  scope: string[];
}

/** Evaluator-held answer key with ground truth and anti-leakage hash. */
export interface EvaluatorAnswerKey {
  fixtureId: string;
  hasDefect: boolean;
  expectedVerdict: 'APPROVE' | 'BLOCK';
  defectLocation?: { path: string; line: number } | undefined;
  defectDescription?: string | undefined;
  antiLeakageHash: string;
}

export interface BabelBenchFixture extends ReviewerFixture {
  groundTruth: {
    hasDefect: boolean;
    expectedVerdict: 'APPROVE' | 'BLOCK';
    defectLocation?: { path: string; line: number } | undefined;
    defectDescription?: string | undefined;
    antiLeakageHash: string;
  };
}

export function extractReviewerFixture(fixture: BabelBenchFixture): ReviewerFixture {
  const { groundTruth: _gt, ...reviewerSafe } = fixture;
  return reviewerSafe;
}

export function extractAnswerKey(fixture: BabelBenchFixture): EvaluatorAnswerKey {
  return {
    fixtureId: fixture.id,
    ...fixture.groundTruth,
  };
}

export interface BabelBenchRunResult {
  fixtureId: string;
  category: BenchmarkCategory;
  split: BenchmarkSplit;
  reviewerModel: string;
  observedVerdict: 'APPROVE' | 'BLOCK';
  expectedVerdict: 'APPROVE' | 'BLOCK';
  isCorrect: boolean;
  isFalsePositive: boolean;
  isFalseNegative: boolean;
  executionTimeMs: number;
}

export interface BabelBenchMetrics {
  totalCases: number;
  cleanControlsCount: number;
  defectCasesCount: number;
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  accuracy: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  clean_candidate_approval_rate: number;
  /** Alias for backward compatibility */
  autonomousTrustedMergeRate: number;
}

export interface ShadowComparisonResult {
  baselineModel: string;
  challengerModel: string;
  baselineMetrics: BabelBenchMetrics;
  challengerMetrics: BabelBenchMetrics;
  deltas: {
    precisionDelta: number;
    recallDelta: number;
    accuracyDelta: number;
    mergeRateDelta: number;
  };
  challengerPromotable: boolean;
  promotionBlockers: string[];
}

const RAW_BENCHMARK_FIXTURES: Array<Omit<BabelBenchFixture, 'groundTruth'> & {
  groundTruth: Omit<BabelBenchFixture['groundTruth'], 'antiLeakageHash'>;
}> = [
  {
    id: 'BENCH-001',
    name: 'Off-by-one boundary defect in array chunking',
    category: 'correctness',
    difficulty: 'trivial',
    split: 'dev',
    files: {
      'src/chunk.ts': 'export function chunk<T>(arr: T[], size: number): T[][] {\n  const res: T[][] = [];\n  for (let i = 0; i <= arr.length; i += size) res.push(arr.slice(i, i + size));\n  return res;\n}\n',
    },
    candidateDiff: '@@ -2,3 +2,3 @@\n-  for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));\n+  for (let i = 0; i <= arr.length; i += size) res.push(arr.slice(i, i + size));\n',
    scope: ['src/chunk.ts'],
    groundTruth: {
      hasDefect: true,
      expectedVerdict: 'BLOCK',
      defectLocation: { path: 'src/chunk.ts', line: 3 },
      defectDescription: '<= causes empty trailing slice when arr.length is exact multiple of size',
    },
  },
  {
    id: 'BENCH-002',
    name: 'Command injection vulnerability via unescaped shell concatenation',
    category: 'security',
    difficulty: 'medium',
    split: 'dev',
    files: {
      'src/exec.ts': 'import { execSync } from "node:child_process";\nexport function runUserCommand(input: string) {\n  return execSync("echo " + input);\n}\n',
    },
    candidateDiff: '@@ -2,2 +2,3 @@\n+export function runUserCommand(input: string) {\n+  return execSync("echo " + input);\n+}\n',
    scope: ['src/exec.ts'],
    groundTruth: {
      hasDefect: true,
      expectedVerdict: 'BLOCK',
      defectLocation: { path: 'src/exec.ts', line: 3 },
      defectDescription: 'Direct shell execution of unsanitized input',
    },
  },
  {
    id: 'BENCH-003',
    name: 'Safe type-safe string utility refactoring',
    category: 'clean_control',
    difficulty: 'trivial',
    split: 'dev',
    files: {
      'src/format.ts': 'export function capitalize(str: string): string {\n  if (!str) return "";\n  return str.charAt(0).toUpperCase() + str.slice(1);\n}\n',
    },
    candidateDiff: '@@ -1,3 +1,4 @@\n export function capitalize(str: string): string {\n-  return str ? str[0].toUpperCase() + str.slice(1) : "";\n+  if (!str) return "";\n+  return str.charAt(0).toUpperCase() + str.slice(1);\n }\n',
    scope: ['src/format.ts'],
    groundTruth: {
      hasDefect: false,
      expectedVerdict: 'APPROVE',
    },
  },
  {
    id: 'BENCH-004',
    name: 'Pure documentation and README clarification',
    category: 'clean_control',
    difficulty: 'trivial',
    split: 'dev',
    files: {
      'README.md': '# Babel Code Review\n\nIndependent read-only autonomous code review system.\n',
    },
    candidateDiff: '@@ -1,2 +1,3 @@\n # Babel Code Review\n+\n+Independent read-only autonomous code review system.\n',
    scope: ['README.md'],
    groundTruth: {
      hasDefect: false,
      expectedVerdict: 'APPROVE',
    },
  },
  {
    id: 'BENCH-005',
    name: 'Unhandled Promise rejection in async worker dispatch',
    category: 'concurrency',
    difficulty: 'hard',
    split: 'holdout',
    files: {
      'src/worker.ts': 'export async function dispatch(tasks: Array<() => Promise<void>>) {\n  for (const t of tasks) t();\n}\n',
    },
    candidateDiff: '@@ -1,3 +1,3 @@\n export async function dispatch(tasks: Array<() => Promise<void>>) {\n-  await Promise.all(tasks.map(t => t()));\n+  for (const t of tasks) t();\n }\n',
    scope: ['src/worker.ts'],
    groundTruth: {
      hasDefect: true,
      expectedVerdict: 'BLOCK',
      defectLocation: { path: 'src/worker.ts', line: 2 },
      defectDescription: 'Floating unhandled promises spawned without await or catch',
    },
  },
  {
    id: 'BENCH-006',
    name: 'Optimized mathematical helper with identical behavior',
    category: 'clean_control',
    difficulty: 'medium',
    split: 'holdout',
    files: {
      'src/math.ts': 'export function clamp(val: number, min: number, max: number): number {\n  return Math.min(Math.max(val, min), max);\n}\n',
    },
    candidateDiff: '@@ -1,3 +1,3 @@\n export function clamp(val: number, min: number, max: number): number {\n-  if (val < min) return min;\n-  if (val > max) return max;\n-  return val;\n+  return Math.min(Math.max(val, min), max);\n }\n',
    scope: ['src/math.ts'],
    groundTruth: {
      hasDefect: false,
      expectedVerdict: 'APPROVE',
    },
  },
  {
    id: 'BENCH-007',
    name: 'Machine-specific hardcoded absolute path in helper',
    category: 'correctness',
    difficulty: 'medium',
    split: 'canary',
    files: {
      'src/path_helper.ts': 'export function getRoot() {\n  return "D:/LocalBuildEnv/repo_root";\n}\n',
    },
    candidateDiff: '@@ -1,3 +1,3 @@\n export function getRoot() {\n-  return process.cwd();\n+  return "D:/LocalBuildEnv/repo_root";\n }\n',
    scope: ['src/path_helper.ts'],
    groundTruth: {
      hasDefect: true,
      expectedVerdict: 'BLOCK',
      defectLocation: { path: 'src/path_helper.ts', line: 2 },
      defectDescription: 'Hardcoded machine-specific absolute path breaks non-local execution',
    },
  },
  {
    id: 'BENCH-008',
    name: 'Unearned independence promotion for unknown builder model',
    category: 'security',
    difficulty: 'hard',
    split: 'canary',
    files: {
      'src/independence.ts': 'export function isIndependent(builder?: string, reviewer?: string) {\n  return builder !== reviewer;\n}\n',
    },
    candidateDiff: '@@ -1,3 +1,3 @@\n export function isIndependent(builder?: string, reviewer?: string) {\n-  return Boolean(builder && reviewer && builder !== reviewer);\n+  return builder !== reviewer;\n }\n',
    scope: ['src/independence.ts'],
    groundTruth: {
      hasDefect: true,
      expectedVerdict: 'BLOCK',
      defectLocation: { path: 'src/independence.ts', line: 2 },
      defectDescription: 'Undefined builder model evaluates to true for inequality, creating unearned independence grant',
    },
  },
  {
    id: 'BENCH-009',
    name: 'Clean path normalization refactor with POSIX forward slashes',
    category: 'clean_control',
    difficulty: 'trivial',
    split: 'canary',
    files: {
      'src/normalize.ts': 'export function normalizePath(p: string) {\n  return p.replace(/\\\\/g, "/");\n}\n',
    },
    candidateDiff: '@@ -1,3 +1,3 @@\n export function normalizePath(p: string) {\n-  return p.split("\\\\").join("/");\n+  return p.replace(/\\\\/g, "/");\n }\n',
    scope: ['src/normalize.ts'],
    groundTruth: {
      hasDefect: false,
      expectedVerdict: 'APPROVE',
    },
  },
  {
    id: 'BENCH-010',
    name: 'Clean addition of unit tests for interval merging helper',
    category: 'clean_control',
    difficulty: 'medium',
    split: 'canary',
    files: {
      'test/intervals.test.ts': 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("merges overlapping intervals", () => {\n  assert.ok(true);\n});\n',
    },
    candidateDiff: '@@ -0,0 +1,5 @@\n+import test from "node:test";\n+import assert from "node:assert/strict";\n+test("merges overlapping intervals", () => {\n+  assert.ok(true);\n+});\n',
    scope: ['test/intervals.test.ts'],
    groundTruth: {
      hasDefect: false,
      expectedVerdict: 'APPROVE',
    },
  },
];

/**
 * Compute deterministic canonical SHA-256 integrity seal over fixture fields.
 */
export function computeFixtureIntegrityHash(fixture: {
  id: string;
  name: string;
  category: BenchmarkCategory;
  difficulty: BenchmarkDifficulty;
  split: BenchmarkSplit;
  files: Record<string, string>;
  candidateDiff: string;
  scope: string[];
  groundTruth: {
    hasDefect: boolean;
    expectedVerdict: 'APPROVE' | 'BLOCK';
    defectLocation?: { path: string; line: number } | undefined;
    defectDescription?: string | undefined;
  };
}): string {
  const sortedFiles = Object.keys(fixture.files)
    .sort()
    .map((k) => [k, fixture.files[k]]);
  const sortedScope = [...fixture.scope].sort();
  const canonicalPayload = [
    fixture.id,
    fixture.name,
    fixture.category,
    fixture.difficulty,
    fixture.split,
    sortedFiles,
    fixture.candidateDiff,
    sortedScope,
    fixture.groundTruth.hasDefect,
    fixture.groundTruth.expectedVerdict,
    fixture.groundTruth.defectLocation?.path ?? null,
    fixture.groundTruth.defectLocation?.line ?? null,
    fixture.groundTruth.defectDescription ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}

/**
 * Independently stored canonical fixture integrity seals.
 * These seals cryptographically lock the benchmark dataset. Any runtime or code modification
 * to a fixture without a deliberate update to this independent seal manifest will fail closed.
 * Note: antiLeakageHash is a cryptographic fixture integrity seal; prompt anti-leakage
 * is enforced structurally via extractReviewerFixture().
 */
export const CANONICAL_FIXTURE_SEAL_MANIFEST: Readonly<Record<string, string>> = Object.freeze({
  'BENCH-001': '654596fb2a5d49b57d34ec00cf497b49f66a9cefb6a2264cb94e53f802d18a30',
  'BENCH-002': '074f8f9d3415d39caa6f6099731da6a43ebc941bd35a3279894ce2a19bef251d',
  'BENCH-003': '8b8e481cd90bf5774499e3826ea60a0af57ff6a5ca8023210d1b59e7b276e884',
  'BENCH-004': 'caecd018e0ba0536b09171a4e86bbce35ce6f1f3511f212dabffd559302af2ec',
  'BENCH-005': '78660e18758bf3d44295d687fb7ed9979389271a208914f826305757bac45bd6',
  'BENCH-006': '4e79bdb557a41c6ecee6130e790416db3fec2d966ded79ef5581e1c493ee613f',
  'BENCH-007': '7d547016961df4d001cedff3066adac150b184f08cf974fba949a5ccf34894ba',
  'BENCH-008': 'cd24780d709465784f0c8fef398083c2a5d934a6c958d2844f7a93dfe63e728c',
  'BENCH-009': 'e5e122533a4ce42151f9602a28c9c7f0092d76851a73bc13457636aa4e14485a',
  'BENCH-010': '2ad2616e6d954580af71e5254dc383dcc8316479f5ebbc4a702deb8f8956f39d',
});

export const CANONICAL_BENCHMARK_FIXTURES: BabelBenchFixture[] = RAW_BENCHMARK_FIXTURES.map((f) => {
  const expectedSeal = CANONICAL_FIXTURE_SEAL_MANIFEST[f.id];
  if (!expectedSeal) throw new Error(`Missing expected integrity seal for fixture: ${f.id}`);
  return {
    ...f,
    groundTruth: {
      ...f.groundTruth,
      antiLeakageHash: expectedSeal,
    },
  };
});

/**
 * Verify anti-leakage integrity of benchmark fixtures against independently retained seals.
 * Validates canonical 64-char lowercase hex format and cryptographically recomputes
 * integrity seal from source fields to fail closed upon tampering or mutation.
 */
export function verifyFixtureAntiLeakage(
  fixtures: BabelBenchFixture[] = CANONICAL_BENCHMARK_FIXTURES,
  expectedManifest: Record<string, string> = CANONICAL_FIXTURE_SEAL_MANIFEST,
): boolean {
  if (!fixtures || fixtures.length === 0) return false;
  for (const fixture of fixtures) {
    const hash = fixture.groundTruth?.antiLeakageHash;
    if (!hash || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      return false;
    }
    const expectedSeal = expectedManifest[fixture.id];
    if (!expectedSeal || expectedSeal !== hash) {
      return false;
    }
    const recomputed = computeFixtureIntegrityHash(fixture);
    if (recomputed !== hash || recomputed !== expectedSeal) {
      return false;
    }
  }
  return true;
}

/**
 * Compute BabelBench metrics from run results.
 */
export function computeBabelBenchMetrics(results: BabelBenchRunResult[]): BabelBenchMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let cleanControls = 0;
  let defectCases = 0;

  for (const r of results) {
    if (r.expectedVerdict === 'APPROVE') {
      cleanControls++;
      if (r.observedVerdict === 'APPROVE') tn++;
      else fp++;
    } else {
      defectCases++;
      if (r.observedVerdict === 'BLOCK') tp++;
      else fn++;
    }
  }

  const total = results.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : (defectCases === 0 ? 1.0 : 0.0);
  const recall = defectCases > 0 ? tp / defectCases : 1.0;
  const accuracy = total > 0 ? (tp + tn) / total : 1.0;
  const fpr = cleanControls > 0 ? fp / cleanControls : 0.0;
  const fnr = defectCases > 0 ? fn / defectCases : 0.0;

  // Clean candidate approval rate = Clean PRs correctly approved / Total Clean PRs
  const cleanApprovalRate = cleanControls > 0 ? tn / cleanControls : 1.0;

  return {
    totalCases: total,
    cleanControlsCount: cleanControls,
    defectCasesCount: defectCases,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision,
    recall,
    accuracy,
    falsePositiveRate: fpr,
    falseNegativeRate: fnr,
    clean_candidate_approval_rate: cleanApprovalRate,
    autonomousTrustedMergeRate: cleanApprovalRate,
  };
}

/**
 * Compare challenger reviewer against baseline in shadow mode.
 */
export function compareShadowReviewer(
  baselineModel: string,
  challengerModel: string,
  baselineResults: BabelBenchRunResult[],
  challengerResults: BabelBenchRunResult[],
): ShadowComparisonResult {
  const baseMetrics = computeBabelBenchMetrics(baselineResults);
  const chalMetrics = computeBabelBenchMetrics(challengerResults);

  const precisionDelta = chalMetrics.precision - baseMetrics.precision;
  const recallDelta = chalMetrics.recall - baseMetrics.recall;
  const accuracyDelta = chalMetrics.accuracy - baseMetrics.accuracy;
  const mergeRateDelta = chalMetrics.clean_candidate_approval_rate - baseMetrics.clean_candidate_approval_rate;

  const blockers: string[] = [];

  // Minimum sample size requirement
  if (baselineResults.length < MINIMUM_BENCHMARK_PROMOTION_SIZE || challengerResults.length < MINIMUM_BENCHMARK_PROMOTION_SIZE) {
    blockers.push(`INSUFFICIENT_BENCHMARK_SIZE: sample size (${Math.min(baselineResults.length, challengerResults.length)}) is below minimum promotion threshold (${MINIMUM_BENCHMARK_PROMOTION_SIZE})`);
  }

  // Promotion Gates:
  // 1. Challenger precision must not degrade significantly (> 2% drop)
  if (precisionDelta < -0.02) {
    blockers.push(`Precision degraded by ${(precisionDelta * 100).toFixed(1)}%`);
  }
  // 2. Challenger recall must not degrade (> 2% drop)
  if (recallDelta < -0.02) {
    blockers.push(`Recall degraded by ${(recallDelta * 100).toFixed(1)}%`);
  }
  // 3. Clean control false positive rate must not exceed 5%
  if (chalMetrics.falsePositiveRate > 0.05) {
    blockers.push(`False positive rate on clean controls (${(chalMetrics.falsePositiveRate * 100).toFixed(1)}%) exceeds 5% maximum threshold`);
  }
  // 4. Clean candidate approval rate must be >= baseline
  if (mergeRateDelta < 0) {
    blockers.push(`Clean candidate approval rate degraded by ${(mergeRateDelta * 100).toFixed(1)}%`);
  }

  return {
    baselineModel,
    challengerModel,
    baselineMetrics: baseMetrics,
    challengerMetrics: chalMetrics,
    deltas: {
      precisionDelta,
      recallDelta,
      accuracyDelta,
      mergeRateDelta,
    },
    challengerPromotable: blockers.length === 0,
    promotionBlockers: blockers,
  };
}

/**
 * Run BabelBench evaluation against a provided reviewer function.
 * Ensures the reviewer function only receives ReviewerFixture (no ground truth).
 */
export async function runBabelBench(
  reviewer: (fixture: ReviewerFixture | BabelBenchFixture) => Promise<'APPROVE' | 'BLOCK'>,
  options: {
    modelName: string;
    fixtures?: BabelBenchFixture[];
    split?: BenchmarkSplit;
  },
): Promise<{
  results: BabelBenchRunResult[];
  metrics: BabelBenchMetrics;
}> {
  const allFixtures = options.fixtures ?? CANONICAL_BENCHMARK_FIXTURES;
  const selected = options.split
    ? allFixtures.filter((f) => f.split === options.split)
    : allFixtures;

  const results: BabelBenchRunResult[] = [];

  for (const fixture of selected) {
    const started = Date.now();
    // Anti-leakage: strip ground truth before passing fixture to reviewer
    const cleanInput = extractReviewerFixture(fixture);
    const observed = await reviewer(cleanInput);
    const elapsed = Date.now() - started;

    const isExpectedApprove = fixture.groundTruth.expectedVerdict === 'APPROVE';
    const isCorrect = observed === fixture.groundTruth.expectedVerdict;
    const isFP = isExpectedApprove && observed === 'BLOCK';
    const isFN = !isExpectedApprove && observed === 'APPROVE';

    results.push({
      fixtureId: fixture.id,
      category: fixture.category,
      split: fixture.split,
      reviewerModel: options.modelName,
      observedVerdict: observed,
      expectedVerdict: fixture.groundTruth.expectedVerdict,
      isCorrect,
      isFalsePositive: isFP,
      isFalseNegative: isFN,
      executionTimeMs: elapsed,
    });
  }

  const metrics = computeBabelBenchMetrics(results);
  return { results, metrics };
}
