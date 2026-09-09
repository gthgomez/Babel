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

export const CANONICAL_BENCHMARK_FIXTURES: BabelBenchFixture[] = [
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
      antiLeakageHash: createHash('sha256').update('BENCH-001:off-by-one').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-002:cmd-injection').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-003:clean-refactor').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-004:docs-update').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-005:floating-promise').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-006:math-clamp').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-007:hardcoded-path').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-008:unearned-independence').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-009:clean-normalize').digest('hex'),
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
      antiLeakageHash: createHash('sha256').update('BENCH-010:clean-tests').digest('hex'),
    },
  },
];

/**
 * Verify anti-leakage integrity of benchmark fixtures.
 */
export function verifyFixtureAntiLeakage(fixtures: BabelBenchFixture[] = CANONICAL_BENCHMARK_FIXTURES): boolean {
  for (const fixture of fixtures) {
    if (!fixture.groundTruth.antiLeakageHash || fixture.groundTruth.antiLeakageHash.length !== 64) {
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
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1.0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1.0;
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
