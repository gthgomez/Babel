import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_BENCHMARK_FIXTURES,
  verifyFixtureAntiLeakage,
  computeBabelBenchMetrics,
  compareShadowReviewer,
  runBabelBench,
  type BabelBenchRunResult,
} from './babelBench.js';

test('babelBench: canonical fixtures exist and satisfy anti-leakage guards', () => {
  assert.ok(CANONICAL_BENCHMARK_FIXTURES.length >= 6);
  assert.equal(verifyFixtureAntiLeakage(), true);

  const cleanControls = CANONICAL_BENCHMARK_FIXTURES.filter((f) => f.category === 'clean_control');
  const defectCases = CANONICAL_BENCHMARK_FIXTURES.filter((f) => f.category !== 'clean_control');

  assert.ok(cleanControls.length >= 3);
  assert.ok(defectCases.length >= 3);

  // Every clean control must expect APPROVE, every defect case must expect BLOCK
  for (const c of cleanControls) assert.equal(c.groundTruth.expectedVerdict, 'APPROVE');
  for (const d of defectCases) assert.equal(d.groundTruth.expectedVerdict, 'BLOCK');
});

test('babelBench: computeBabelBenchMetrics correctly derives North Star KPIs', () => {
  const mockResults: BabelBenchRunResult[] = [
    // 3 Clean controls: 2 Approved (TN), 1 Blocked (FP)
    {
      fixtureId: 'C1',
      category: 'clean_control',
      split: 'dev',
      reviewerModel: 'test-model',
      observedVerdict: 'APPROVE',
      expectedVerdict: 'APPROVE',
      isCorrect: true,
      isFalsePositive: false,
      isFalseNegative: false,
      executionTimeMs: 100,
    },
    {
      fixtureId: 'C2',
      category: 'clean_control',
      split: 'dev',
      reviewerModel: 'test-model',
      observedVerdict: 'APPROVE',
      expectedVerdict: 'APPROVE',
      isCorrect: true,
      isFalsePositive: false,
      isFalseNegative: false,
      executionTimeMs: 100,
    },
    {
      fixtureId: 'C3',
      category: 'clean_control',
      split: 'dev',
      reviewerModel: 'test-model',
      observedVerdict: 'BLOCK',
      expectedVerdict: 'APPROVE',
      isCorrect: false,
      isFalsePositive: true,
      isFalseNegative: false,
      executionTimeMs: 100,
    },
    // 3 Defect cases: 2 Blocked (TP), 1 Approved (FN)
    {
      fixtureId: 'D1',
      category: 'correctness',
      split: 'dev',
      reviewerModel: 'test-model',
      observedVerdict: 'BLOCK',
      expectedVerdict: 'BLOCK',
      isCorrect: true,
      isFalsePositive: false,
      isFalseNegative: false,
      executionTimeMs: 100,
    },
    {
      fixtureId: 'D2',
      category: 'security',
      split: 'dev',
      reviewerModel: 'test-model',
      observedVerdict: 'BLOCK',
      expectedVerdict: 'BLOCK',
      isCorrect: true,
      isFalsePositive: false,
      isFalseNegative: false,
      executionTimeMs: 100,
    },
    {
      fixtureId: 'D3',
      category: 'concurrency',
      split: 'dev',
      reviewerModel: 'test-model',
      observedVerdict: 'APPROVE',
      expectedVerdict: 'BLOCK',
      isCorrect: false,
      isFalsePositive: false,
      isFalseNegative: true,
      executionTimeMs: 100,
    },
  ];

  const metrics = computeBabelBenchMetrics(mockResults);

  assert.equal(metrics.totalCases, 6);
  assert.equal(metrics.cleanControlsCount, 3);
  assert.equal(metrics.defectCasesCount, 3);
  assert.equal(metrics.truePositives, 2);
  assert.equal(metrics.falsePositives, 1);
  assert.equal(metrics.trueNegatives, 2);
  assert.equal(metrics.falseNegatives, 1);

  // Precision = TP / (TP + FP) = 2 / 3 ~= 0.6667
  assert.ok(Math.abs(metrics.precision - 2 / 3) < 0.001);
  // Recall = TP / (TP + FN) = 2 / 3 ~= 0.6667
  assert.ok(Math.abs(metrics.recall - 2 / 3) < 0.001);
  // Accuracy = (TP + TN) / Total = 4 / 6 ~= 0.6667
  assert.ok(Math.abs(metrics.accuracy - 4 / 6) < 0.001);
  // Autonomous Trusted Merge Rate = TN / Clean = 2 / 3 ~= 0.6667
  assert.ok(Math.abs(metrics.autonomousTrustedMergeRate - 2 / 3) < 0.001);
});

test('babelBench: runBabelBench executes benchmark against reviewer function', async () => {
  // Perfect reviewer
  const perfectReviewer = async (f: { groundTruth: { expectedVerdict: 'APPROVE' | 'BLOCK' } }) =>
    f.groundTruth.expectedVerdict;

  const { results, metrics } = await runBabelBench(perfectReviewer, {
    modelName: 'oracle-model',
  });

  assert.equal(results.length, CANONICAL_BENCHMARK_FIXTURES.length);
  assert.equal(metrics.accuracy, 1.0);
  assert.equal(metrics.precision, 1.0);
  assert.equal(metrics.recall, 1.0);
  assert.equal(metrics.falsePositiveRate, 0.0);
  assert.equal(metrics.autonomousTrustedMergeRate, 1.0);
});

test('babelBench: compareShadowReviewer gates challenger promotion strictly', () => {
  const baselineResults: BabelBenchRunResult[] = [
    {
      fixtureId: 'C1',
      category: 'clean_control',
      split: 'dev',
      reviewerModel: 'base',
      observedVerdict: 'APPROVE',
      expectedVerdict: 'APPROVE',
      isCorrect: true,
      isFalsePositive: false,
      isFalseNegative: false,
      executionTimeMs: 50,
    },
    {
      fixtureId: 'D1',
      category: 'correctness',
      split: 'dev',
      reviewerModel: 'base',
      observedVerdict: 'BLOCK',
      expectedVerdict: 'BLOCK',
      isCorrect: true,
      isFalsePositive: false,
      isFalseNegative: false,
      executionTimeMs: 50,
    },
  ];

  // Challenger that falsely blocks clean control
  const flawedChallengerResults: BabelBenchRunResult[] = [
    {
      fixtureId: 'C1',
      category: 'clean_control',
      split: 'dev',
      reviewerModel: 'chal',
      observedVerdict: 'BLOCK', // FP!
      expectedVerdict: 'APPROVE',
      isCorrect: false,
      isFalsePositive: true,
      isFalseNegative: false,
      executionTimeMs: 50,
    },
    {
      fixtureId: 'D1',
      category: 'correctness',
      split: 'dev',
      reviewerModel: 'chal',
      observedVerdict: 'BLOCK',
      expectedVerdict: 'BLOCK',
      isCorrect: true,
      isFalsePositive: false,
      isFalseNegative: false,
      executionTimeMs: 50,
    },
  ];

  const comparison = compareShadowReviewer(
    'base',
    'chal',
    baselineResults,
    flawedChallengerResults,
  );

  assert.equal(comparison.challengerPromotable, false);
  assert.ok(comparison.promotionBlockers.length > 0);
  assert.ok(comparison.promotionBlockers.some((b) => b.includes('False positive rate')));
});
