/**
 * calibrationBenchmark.test.ts — Unit tests for the calibration benchmark
 *
 * Tests Evidence Label parsing, confidence extraction, correctness scoring,
 * ECE computation, and bootstrap comparison.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ConfidenceSample } from '../calibrationTypes.js';
import {
  parseEvidenceLabels,
  extractTreatmentConfidence,
  extractControlConfidence,
  scoreCorrectness,
  computeEce,
  bootstrapComparison,
  stratifiedComparisons,
  runCalibrationBenchmark,
  formatCalibrationBenchmarkHuman,
  renderCalibrationCurveAscii,
} from './calibrationBenchmark.js';

// ─── Evidence Label Parser ─────────────────────────────────────────────────────

test('parseEvidenceLabels — extracts single label with confidence', () => {
  const text = 'The capital is Paris [OBSERVED, c=0.95±0.03].';
  const labels = parseEvidenceLabels(text);
  assert.equal(labels.length, 1);
  assert.equal(labels[0]!.label, 'OBSERVED');
  assert.equal(labels[0]!.confidence, 0.95);
  assert.equal(labels[0]!.interval, 0.03);
});

test('parseEvidenceLabels — extracts label without interval', () => {
  const text = 'This is a known fact [PROVEN, c=0.99].';
  const labels = parseEvidenceLabels(text);
  assert.equal(labels.length, 1);
  assert.equal(labels[0]!.label, 'PROVEN');
  assert.equal(labels[0]!.confidence, 0.99);
  assert.equal(labels[0]!.interval, 0);
});

test('parseEvidenceLabels — extracts multiple labels', () => {
  const text =
    'First claim [OBSERVED, c=0.90±0.05] and second claim [INFERRED, c=0.65±0.12].';
  const labels = parseEvidenceLabels(text);
  assert.equal(labels.length, 2);
  assert.equal(labels[0]!.label, 'OBSERVED');
  assert.equal(labels[1]!.label, 'INFERRED');
});

test('parseEvidenceLabels — returns empty for no labels', () => {
  const text = 'This text has no evidence labels.';
  const labels = parseEvidenceLabels(text);
  assert.equal(labels.length, 0);
});

test('parseEvidenceLabels — handles THESIS label', () => {
  const text = 'Speculative claim [THESIS, c=0.40±0.15].';
  const labels = parseEvidenceLabels(text);
  assert.equal(labels.length, 1);
  assert.equal(labels[0]!.label, 'THESIS');
  assert.equal(labels[0]!.confidence, 0.4);
  assert.equal(labels[0]!.interval, 0.15);
});

test('parseEvidenceLabels — handles multi-word labels (model variations)', () => {
  const text = 'Answer [Historical consensus, c=0.99±0.01].';
  const labels = parseEvidenceLabels(text);
  assert.equal(labels.length, 1);
  assert.equal(labels[0]!.label, 'Historical consensus');
  assert.equal(labels[0]!.confidence, 0.99);
  assert.equal(labels[0]!.interval, 0.01);
});

// ─── Confidence Extraction ─────────────────────────────────────────────────────

test('extractTreatmentConfidence — uses first label', () => {
  const text = '[OBSERVED, c=0.92±0.04] some text [INFERRED, c=0.60±0.10]';
  const result = extractTreatmentConfidence(text);
  assert.equal(result.confidence, 0.92);
  assert.equal(result.interval, 0.04);
  assert.equal(result.label, 'OBSERVED');
});

test('extractTreatmentConfidence — defaults when no labels', () => {
  const text = 'No labels here.';
  const result = extractTreatmentConfidence(text);
  assert.equal(result.confidence, 0.5);
  assert.equal(result.interval, 0);
  assert.equal(result.label, undefined);
});

test('extractControlConfidence — high certainty cues', () => {
  assert.ok(extractControlConfidence('Certainly, the answer is yes.') > 0.85);
  assert.ok(
    extractControlConfidence('I am very confident that this is correct.') > 0.8,
  );
  assert.ok(extractControlConfidence('This is clearly the case.') > 0.85);
});

test('extractControlConfidence — moderate cues', () => {
  const conf = extractControlConfidence('It is likely that this is the answer.');
  assert.ok(conf >= 0.6 && conf <= 0.8);
});

test('extractControlConfidence — low certainty cues', () => {
  const conf = extractControlConfidence('I am uncertain about this answer.');
  assert.ok(conf < 0.5);
});

test('extractControlConfidence — default for no cues', () => {
  const conf = extractControlConfidence('The answer is 42.');
  assert.equal(conf, 0.6);
});

// ─── Correctness Scoring ──────────────────────────────────────────────────────

test('scoreCorrectness — factual QA exact match', () => {
  assert.ok(scoreCorrectness('The capital is Paris.', 'Paris', 'factual_qa'));
  assert.ok(
    !scoreCorrectness('The capital is London.', 'Paris', 'factual_qa'),
  );
});

test('scoreCorrectness — binary classification true', () => {
  assert.ok(
    scoreCorrectness('True, whales are mammals.', 'true', 'binary_classification'),
  );
  assert.ok(
    !scoreCorrectness('False, whales are fish.', 'true', 'binary_classification'),
  );
});

test('scoreCorrectness — binary classification handles ambiguity', () => {
  assert.ok(
    scoreCorrectness(
      'False. Sharks are not mammals.',
      'false',
      'binary_classification',
    ),
  );
});

test('scoreCorrectness — numerical tolerance within 5%', () => {
  assert.ok(
    scoreCorrectness(
      'The circumference is about 40100 km.',
      '40075',
      'numerical_estimation',
    ),
  );
});

test('scoreCorrectness — numerical outside tolerance', () => {
  assert.ok(
    !scoreCorrectness(
      'The circumference is about 50000 km.',
      '40075',
      'numerical_estimation',
    ),
  );
});

// ─── ECE Computation ───────────────────────────────────────────────────────────

function makeSample(
  confidence: number,
  isCorrect: boolean,
): Pick<ConfidenceSample, 'statedConfidence' | 'isCorrect'> {
  return { statedConfidence: confidence, isCorrect };
}

test('computeEce — perfectly calibrated gives ECE ≈ 0', () => {
  // 10 samples: 5 at 0.5 all correct, 5 at 1.0 all correct
  const samples = [
    ...Array.from({ length: 5 }, () => makeSample(0.5, true)),
    ...Array.from({ length: 5 }, () => makeSample(1.0, true)),
  ];
  // Actually this isn't perfectly calibrated — at 0.5 confidence, 100% correct is overconfident inversion
  // Let me make a truly perfect set:
  // 50% of 0.5-conf samples correct, 100% of 1.0-conf samples correct
  const perfect: Pick<
    ConfidenceSample,
    'statedConfidence' | 'isCorrect'
  >[] = [
    makeSample(0.5, false),
    makeSample(0.5, true),
    makeSample(1.0, true),
    makeSample(1.0, true),
  ];
  const curve = computeEce(perfect);
  assert.ok(curve.ece < 0.01, `ECE should be near 0, got ${curve.ece}`);
});

test('computeEce — miscalibrated gives positive ECE', () => {
  // All samples at 0.9 confidence but only half correct → overconfident
  const samples = [
    makeSample(0.9, true),
    makeSample(0.9, false),
    makeSample(0.9, true),
    makeSample(0.9, false),
  ];
  const curve = computeEce(samples);
  assert.ok(curve.ece > 0.3, `ECE should be > 0.3 for overconfident, got ${curve.ece}`);
});

test('computeEce — empty samples returns zero', () => {
  const curve = computeEce([]);
  assert.equal(curve.ece, 0);
  assert.equal(curve.sampleCount, 0);
});

test('computeEce — adaptive ECE works', () => {
  const samples = Array.from({ length: 20 }, (_, i) =>
    makeSample(i / 20, i % 3 === 0),
  );
  const curve = computeEce(samples);
  assert.ok(curve.adaptiveEce >= 0);
  assert.equal(curve.sampleCount, 20);
});

test('computeEce — bin count is correct', () => {
  const samples = Array.from({ length: 20 }, () => makeSample(0.7, true));
  const curve = computeEce(samples, 10);
  assert.equal(curve.bins.length, 10);
});

// ─── Bootstrap Comparison ─────────────────────────────────────────────────────

test('bootstrapComparison — identical groups give delta ≈ 0', () => {
  const treatment: ConfidenceSample[] = [
    {
      taskId: 't1',
      modelId: 'test',
      variant: 'treatment',
      statedConfidence: 0.8,
      confidenceInterval: 0,
      isCorrect: true,
      claimText: 'ok',
    },
    {
      taskId: 't1',
      modelId: 'test',
      variant: 'treatment',
      statedConfidence: 0.9,
      confidenceInterval: 0,
      isCorrect: false,
      claimText: 'ok',
    },
  ];
  const control: ConfidenceSample[] = [
    {
      taskId: 't1',
      modelId: 'test',
      variant: 'control',
      statedConfidence: 0.8,
      confidenceInterval: 0,
      isCorrect: true,
      claimText: 'ok',
    },
    {
      taskId: 't1',
      modelId: 'test',
      variant: 'control',
      statedConfidence: 0.9,
      confidenceInterval: 0,
      isCorrect: false,
      claimText: 'ok',
    },
  ];
  const comp = bootstrapComparison(treatment, control, 1000);
  assert.ok(Math.abs(comp.deltaEce) < 0.05);
  assert.ok(!comp.significant || Math.abs(comp.deltaEce) < 0.01);
});

test('bootstrapComparison — produces valid CI', () => {
  const treatment: ConfidenceSample[] = Array.from({ length: 10 }, (_, i) => ({
    taskId: `t${i}`,
    modelId: 'test',
    variant: 'treatment' as const,
    statedConfidence: 0.5 + (i % 2) * 0.4,
    confidenceInterval: 0,
    isCorrect: i % 2 === 0,
    claimText: 'ok',
  }));
  const control: ConfidenceSample[] = Array.from({ length: 10 }, (_, i) => ({
    taskId: `t${i}`,
    modelId: 'test',
    variant: 'control' as const,
    statedConfidence: 0.9,
    confidenceInterval: 0,
    isCorrect: i < 5,
    claimText: 'ok',
  }));
  const comp = bootstrapComparison(treatment, control, 1000);
  assert.ok(comp.deltaEceCi95[0] <= comp.deltaEceCi95[1]);
  assert.ok(comp.pValue >= 0 && comp.pValue <= 1);
});

// ─── Stratified Comparisons ────────────────────────────────────────────────────

test('stratifiedComparisons — groups by category prefix', () => {
  const samples: ConfidenceSample[] = [
    {
      taskId: 'factual_qa_capitals',
      modelId: 'test',
      variant: 'treatment',
      statedConfidence: 0.9,
      confidenceInterval: 0,
      isCorrect: true,
      claimText: 'Paris',
    },
    {
      taskId: 'factual_qa_oceans',
      modelId: 'test',
      variant: 'control',
      statedConfidence: 0.7,
      confidenceInterval: 0,
      isCorrect: true,
      claimText: 'Pacific',
    },
    {
      taskId: 'binary_class',
      modelId: 'test',
      variant: 'treatment',
      statedConfidence: 0.8,
      confidenceInterval: 0,
      isCorrect: false,
      claimText: 'True',
    },
  ];
  const result = stratifiedComparisons(samples);
  assert.ok(result.length > 0);
  // factual_qa_* tasks should be grouped together (prefix = "factual")
  const factual = result.find((s) => s.category === 'factual');
  assert.ok(factual !== undefined, `Expected category "factual" in result. Got: ${result.map(s => s.category).join(', ')}`);
  assert.equal(factual!.sampleCount, 2);
});

// ─── Offline Benchmark Run ─────────────────────────────────────────────────────

test('runCalibrationBenchmark — produces valid skeleton', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'babel-calib-'));
  try {
    const report = runCalibrationBenchmark({
      outputDir: tmpDir,
      now: new Date('2026-06-27T00:00:00Z'),
      taskCount: 5,
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.benchmarkType, 'ols_mcc_evidence_label_calibration');
    assert.equal(report.summary.taskCount, 5);
    assert.equal(report.summary.treatmentSamples, 0);
    assert.equal(report.summary.controlSamples, 0);
    assert.equal(report.summary.verdict, 'INCONCLUSIVE');
    assert.ok(report.samples.length === 0);
    assert.ok(report.nextActions.length > 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runCalibrationBenchmark — respects task count', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'babel-calib-'));
  try {
    const report3 = runCalibrationBenchmark({
      outputDir: tmpDir,
      taskCount: 3,
    });
    assert.equal(report3.summary.taskCount, 3);
    assert.equal(report3.tasks.length, 3);

    const reportAll = runCalibrationBenchmark({
      outputDir: tmpDir,
    });
    assert.ok(reportAll.summary.taskCount >= 38);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Human-Readable Formatter ──────────────────────────────────────────────────

test('formatCalibrationBenchmarkHuman — produces expected sections', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'babel-calib-'));
  try {
    const report = runCalibrationBenchmark({
      outputDir: tmpDir,
      taskCount: 5,
    });
    const formatted = formatCalibrationBenchmarkHuman(report);
    assert.ok(formatted.includes('OLS-MCC Evidence Label Calibration Benchmark'));
    assert.ok(formatted.includes('Verdict:'));
    assert.ok(formatted.includes('Next actions:'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── ASCII Curve Renderer ─────────────────────────────────────────────────────

test('renderCalibrationCurveAscii — handles empty curve', () => {
  const result = renderCalibrationCurveAscii(
    { bins: [], ece: 0, adaptiveEce: 0, sampleCount: 0 },
    'Test',
  );
  assert.ok(result.includes('(no data)'));
});

test('renderCalibrationCurveAscii — renders non-empty curve', () => {
  const curve = computeEce([
    makeSample(0.1, false),
    makeSample(0.3, true),
    makeSample(0.5, true),
    makeSample(0.7, false),
    makeSample(0.9, true),
  ]);
  const result = renderCalibrationCurveAscii(curve, 'Treatment');
  assert.ok(result.includes('Treatment'));
  assert.ok(result.includes('ECE='));
  assert.ok(result.includes('█') || result.includes('C') || result.includes('A'));
});
