/**
 * calibrationBenchmark.ts — Evidence Label calibration benchmark orchestrator
 *
 * Measures whether OLS-MCC Evidence Labels with numerical confidence scores
 * (`[LABEL, c=0.XX±0.YY]`) produce better-calibrated LLM outputs.
 *
 * Architecture: prompt pair gen → LLM harness → ECE compute → report assembly
 * Follows the `run*` + `format*Human` pattern from parityBenchmark.ts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { BABEL_RUNS_DIR } from '../cli/constants.js';
import type {
  CalibrationBenchmarkOptions,
  CalibrationBenchmarkReport,
  CalibrationBin,
  CalibrationComparison,
  CalibrationCurve,
  CalibrationTaskDefinition,
  ConfidenceSample,
  StratifiedComparison,
} from '../calibrationTypes.js';
import {
  CalibrationBenchmarkReportSchema,
} from '../calibrationTypes.js';
import {
  defaultCalibrationTasks,
  defaultCategoricalLabelTasks,
} from '../evals/evidenceLabelPrompts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toArtifactTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}_` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}` +
    `${pad(date.getSeconds())}`
  );
}

// ─── Evidence Label Parser ─────────────────────────────────────────────────────

const EVIDENCE_LABEL_RE =
  /\[([^,\]]+),\s*c=(\d\.\d+)(?:±(\d\.\d+))?\]/g;

/**
 * Extracts all Evidence Label matches from a string.
 * Returns an array of { label, confidence, interval } objects.
 */
export function parseEvidenceLabels(text: string): Array<{
  label: string;
  confidence: number;
  interval: number;
}> {
  const results: Array<{ label: string; confidence: number; interval: number }> =
    [];
  let match: RegExpExecArray | null;
  // Reset lastIndex before iterating
  EVIDENCE_LABEL_RE.lastIndex = 0;
  while ((match = EVIDENCE_LABEL_RE.exec(text)) !== null) {
    results.push({
      label: match[1]!,
      confidence: Number.parseFloat(match[2]!),
      interval: match[3] ? Number.parseFloat(match[3]) : 0,
    });
  }
  return results;
}

/**
 * Extracts the primary confidence from a treatment response.
 * Uses the first Evidence Label found, or the average if multiple.
 */
export function extractTreatmentConfidence(text: string): {
  confidence: number;
  interval: number;
  label: string | undefined;
} {
  const labels = parseEvidenceLabels(text);
  if (labels.length === 0) {
    return { confidence: 0.5, interval: 0, label: undefined };
  }
  // Use the first label as the primary
  return {
    confidence: labels[0]!.confidence,
    interval: labels[0]!.interval,
    label: labels[0]!.label,
  };
}

/**
 * Infers a confidence score from verbal cues in a control response
 * (no Evidence Labels). Uses simple keyword heuristics.
 */
export function extractControlConfidence(text: string): number {
  const lower = text.toLowerCase();
  // High-confidence cues
  if (/\b(certainly|definitely|undoubtedly|i am (very |quite )?confident|clearly|obviously)\b/.test(lower)) {
    return 0.9;
  }
  if (/\b(i am confident|i'm confident|very likely|highly likely|almost certainly)\b/.test(lower)) {
    return 0.85;
  }
  // Moderate-confidence cues
  if (/\b(likely|probably|i believe|it appears|most likely|i think)\b/.test(lower)) {
    return 0.7;
  }
  if (/\b(may|might|could be|possibly|perhaps|seems)\b/.test(lower)) {
    return 0.55;
  }
  // Low-confidence cues
  if (/\b(uncertain|unclear|not sure|hard to say|difficult to determine|speculative)\b/.test(lower)) {
    return 0.35;
  }
  // Default: no confidence signal → assume moderate
  return 0.6;
}

/**
 * Extracts confidence from a categorical Evidence Label like `[HIGH]`.
 *
 * Mapping:
 *   [HIGH]       → 0.85
 *   [OBSERVED]   → 0.7
 *   [INFERRED]   → 0.55
 *   [SPECULATIVE] → 0.35
 *
 * Returns the first match found, or defaults to 0.6 if no categorical
 * label is detected. Case-insensitive matching.
 */
export function extractCategoricalConfidence(text: string): {
  confidence: number;
  label: string | undefined;
} {
  const CATEGORICAL_LABEL_RE =
    /\[(HIGH|OBSERVED|INFERRED|SPECULATIVE)\]/i;
  CATEGORICAL_LABEL_RE.lastIndex = 0;
  const match = CATEGORICAL_LABEL_RE.exec(text);
  if (!match) {
    return { confidence: 0.6, label: undefined };
  }
  const label = match[1]!.toUpperCase();
  const mapping: Record<string, number> = {
    HIGH: 0.85,
    OBSERVED: 0.7,
    INFERRED: 0.55,
    SPECULATIVE: 0.35,
  };
  return {
    confidence: mapping[label] ?? 0.6,
    label,
  };
}

// ─── Ground-Truth Scoring ──────────────────────────────────────────────────────

/**
 * Scores whether an LLM response matches the ground truth.
 * Uses fuzzy matching for factual tasks, exact for binary classification.
 */
export function scoreCorrectness(
  response: string,
  groundTruth: string,
  category: string,
): boolean {
  const lowerResp = response.toLowerCase().trim();
  const lowerTruth = groundTruth.toLowerCase().trim();

  // Binary classification: look for true/false, yes/no
  if (category === 'binary_classification') {
    const truthWords = new Set(
      lowerTruth.split(/\s*,\s*/).map((w) => w.trim()),
    );
    for (const word of truthWords) {
      if (lowerResp.includes(word)) {
        const opposites =
          word === 'true'
            ? 'false'
            : word === 'false'
              ? 'true'
              : word === 'yes'
                ? 'no'
                : word === 'no'
                  ? 'yes'
                  : null;
        if (opposites && lowerResp.includes(opposites)) {
          const wordIdx = lowerResp.indexOf(word);
          const oppIdx = lowerResp.indexOf(opposites);
          return wordIdx < oppIdx;
        }
        return true;
      }
    }
    return false;
  }

  // Constrained generation: check if key code patterns appear
  if (category === 'constrained_generation') {
    return scoreCodeCorrectness(lowerResp, lowerTruth);
  }

  // Factual QA / numerical estimation: strip formatting and check
  return scoreFactualCorrectness(lowerResp, lowerTruth);
}

/**
 * Scores code generation by checking for key structural elements
 * rather than exact character match.
 */
function scoreCodeCorrectness(response: string, groundTruth: string): boolean {
  // Extract function signatures and key tokens from both
  const respTokens = new Set(
    response.replace(/[^a-z0-9_$]/g, ' ').split(/\s+/).filter((t) => t.length > 1),
  );
  const truthTokens = new Set(
    groundTruth.replace(/[^a-z0-9_$]/g, ' ').split(/\s+/).filter((t) => t.length > 1),
  );
  // Require ≥70% of ground-truth tokens to appear in response
  if (truthTokens.size === 0) return false;
  let matched = 0;
  for (const t of truthTokens) {
    if (respTokens.has(t)) matched++;
  }
  return matched / truthTokens.size >= 0.7;
}

/**
 * Scores factual answers with tolerance for formatting differences.
 */
function scoreFactualCorrectness(response: string, groundTruth: string): boolean {
  // Strip punctuation and normalize whitespace
  const normResp = response.replace(/[,%$€£]/g, '').replace(/\s+/g, ' ').trim();
  const normTruth = groundTruth.replace(/[,%$€£]/g, '').replace(/\s+/g, ' ').trim();

  // Direct substring match after normalization
  if (normResp.includes(normTruth)) return true;

  // For list-type answers (comma-separated elements), check element presence
  const truthElements = normTruth.split(/\s*,\s*/).filter((e) => e.length > 0);
  if (truthElements.length >= 3) {
    const allPresent = truthElements.every((el) => normResp.includes(el));
    if (allPresent) return true;
  }

  // Extract numbers and compare with 5% tolerance
  const truthNumbers = normTruth.match(/\d+\.?\d*/g);
  const respNumbers = normResp.match(/\d+\.?\d*/g);
  if (truthNumbers && respNumbers) {
    for (const tn of truthNumbers) {
      const tVal = Number.parseFloat(tn);
      if (Number.isNaN(tVal) || tVal === 0) continue;
      for (const rn of respNumbers) {
        const rVal = Number.parseFloat(rn);
        if (Number.isNaN(rVal)) continue;
        if (Math.abs(rVal - tVal) / tVal < 0.05) return true;
      }
    }
  }

  return false;
}

// ─── ECE Computation (Pure JS — no numpy dependency) ───────────────────────────

/**
 * Computes Expected Calibration Error using equal-width bins.
 *
 * ECE = Σ (|B_m| / N) × |acc(B_m) − conf(B_m)|
 * where B_m is the m-th bin, acc is mean accuracy, conf is mean confidence.
 */
export function computeEce(
  samples: Pick<ConfidenceSample, 'statedConfidence' | 'isCorrect'>[],
  nBins: number = 10,
): CalibrationCurve {
  if (samples.length === 0) {
    return { bins: [], ece: 0, adaptiveEce: 0, sampleCount: 0 };
  }

  // Sort by stated confidence
  const sorted = [...samples].sort(
    (a, b) => a.statedConfidence - b.statedConfidence,
  );

  // Equal-width bins
  const bins: CalibrationBin[] = [];
  let totalEce = 0;

  for (let b = 0; b < nBins; b++) {
    const binLower = b / nBins;
    const binUpper = (b + 1) / nBins;
    const inBin = sorted.filter(
      (s) =>
        s.statedConfidence >= binLower &&
        (b === nBins - 1
          ? s.statedConfidence <= binUpper
          : s.statedConfidence < binUpper),
    );

    if (inBin.length === 0) {
      bins.push({
        binLower,
        binUpper,
        count: 0,
        avgConfidence: 0,
        avgAccuracy: 0,
        binEce: 0,
      });
      continue;
    }

    const avgConf =
      inBin.reduce((sum, s) => sum + s.statedConfidence, 0) / inBin.length;
    const avgAcc =
      inBin.filter((s) => s.isCorrect).length / inBin.length;
    const weight = inBin.length / sorted.length;
    const binEce = weight * Math.abs(avgAcc - avgConf);
    totalEce += binEce;

    bins.push({
      binLower,
      binUpper,
      count: inBin.length,
      avgConfidence: avgConf,
      avgAccuracy: avgAcc,
      binEce,
    });
  }

  // Adaptive equal-mass ECE: partition into bins so each has ~same sample count
  const adaptiveEce = computeAdaptiveEce(sorted, nBins);

  return {
    bins,
    ece: totalEce,
    adaptiveEce,
    sampleCount: samples.length,
  };
}

function computeAdaptiveEce(
  sorted: Pick<ConfidenceSample, 'statedConfidence' | 'isCorrect'>[],
  nBins: number,
): number {
  if (sorted.length < nBins) return 0;
  const perBin = Math.floor(sorted.length / nBins);
  let total = 0;

  for (let b = 0; b < nBins; b++) {
    const start = b * perBin;
    const end = b === nBins - 1 ? sorted.length : start + perBin;
    const inBin = sorted.slice(start, end);
    if (inBin.length === 0) continue;

    const avgConf =
      inBin.reduce((sum, s) => sum + s.statedConfidence, 0) / inBin.length;
    const avgAcc =
      inBin.filter((s) => s.isCorrect).length / inBin.length;
    const weight = inBin.length / sorted.length;
    total += weight * Math.abs(avgAcc - avgConf);
  }

  return total;
}

// ─── Statistical Significance (Bootstrap) ──────────────────────────────────────

/**
 * Bootstrap 95% CI and p-value for the difference in ECE between
 * treatment and control groups.
 *
 * Uses paired resampling: each bootstrap draw resamples task-level
 * treatment/control pairs, recomputes ECE for both, and records the delta.
 */
export function bootstrapComparison(
  treatmentSamples: ConfidenceSample[],
  controlSamples: ConfidenceSample[],
  nResamples: number = 10_000,
): CalibrationComparison {
  const treatmentCurve = computeEce(treatmentSamples);
  const controlCurve = computeEce(controlSamples);

  const observedTreatmentEce = treatmentCurve.ece;
  const observedControlEce = controlCurve.ece;
  const observedDelta = observedTreatmentEce - observedControlEce;

  // Build paired task-level arrays
  const taskIds = [...new Set(treatmentSamples.map((s) => s.taskId))];
  const pairs: Array<{
    taskId: string;
    treatment: ConfidenceSample[];
    control: ConfidenceSample[];
  }> = [];
  for (const tid of taskIds) {
    pairs.push({
      taskId: tid,
      treatment: treatmentSamples.filter((s) => s.taskId === tid),
      control: controlSamples.filter((s) => s.taskId === tid),
    });
  }

  // Bootstrap
  const deltas: number[] = [];
  for (let i = 0; i < nResamples; i++) {
    // Resample task pairs with replacement
    const resampled: typeof pairs = [];
    for (let j = 0; j < pairs.length; j++) {
      const idx = Math.floor(Math.random() * pairs.length);
      resampled.push(pairs[idx]!);
    }
    const tResampled = resampled.flatMap((p) => p.treatment);
    const cResampled = resampled.flatMap((p) => p.control);
    const tEce = computeEce(tResampled).ece;
    const cEce = computeEce(cResampled).ece;
    deltas.push(tEce - cEce);
  }

  // 95% CI: percentile method
  deltas.sort((a, b) => a - b);
  const ciLower = deltas[Math.floor(nResamples * 0.025)]!;
  const ciUpper = deltas[Math.floor(nResamples * 0.975)]!;

  // p-value: fraction of bootstrap deltas on the "wrong" side of 0
  // (two-sided: fraction where |delta| ≥ |observed delta| under H0 shift)
  // Shift deltas to center at 0 (null hypothesis)
  const centered = deltas.map((d) => d - observedDelta);
  const extremeCount = centered.filter(
    (d) => Math.abs(d) >= Math.abs(observedDelta),
  ).length;
  const pValue = extremeCount / nResamples;

  return {
    treatmentEce: observedTreatmentEce,
    controlEce: observedControlEce,
    deltaEce: observedDelta,
    deltaEceCi95: [ciLower, ciUpper],
    pValue,
    significant: pValue < 0.05 && ciLower < 0 === ciUpper < 0,
  };
}

// ─── Stratified comparison ─────────────────────────────────────────────────────

export function stratifiedComparisons(
  samples: ConfidenceSample[],
): StratifiedComparison[] {
  const tasks = new Map<
    string,
    { category: string; samples: ConfidenceSample[] }
  >();
  for (const s of samples) {
    const key = s.taskId;
    if (!tasks.has(key)) {
      tasks.set(key, { category: key.split('_')[0] ?? 'unknown', samples: [] });
    }
    tasks.get(key)!.samples.push(s);
  }

  const byCategory = new Map<string, ConfidenceSample[]>();
  for (const [, task] of tasks) {
    const existing = byCategory.get(task.category);
    if (existing) {
      existing.push(...task.samples);
    } else {
      byCategory.set(task.category, [...task.samples]);
    }
  }

  const results: StratifiedComparison[] = [];
  for (const [category, catSamples] of byCategory) {
    const treatment = catSamples.filter((s) => s.variant === 'treatment');
    const control = catSamples.filter((s) => s.variant === 'control');
    const tEce = computeEce(treatment).ece;
    const cEce = computeEce(control).ece;
    results.push({
      category,
      treatmentEce: tEce,
      controlEce: cEce,
      deltaEce: tEce - cEce,
      sampleCount: catSamples.length,
    });
  }

  results.sort((a, b) => a.deltaEce - b.deltaEce);
  return results;
}

// ─── Task selection ────────────────────────────────────────────────────────────

function selectTasks(
  tasks: CalibrationTaskDefinition[],
  count?: number,
): CalibrationTaskDefinition[] {
  if (count === undefined || count >= tasks.length) return tasks;
  // Deterministic selection: take first N
  return tasks.slice(0, count);
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Runs the calibration benchmark.
 *
 * CURRENT STATE: produces a REPORT SKELETON with empty samples.
 * The LLM inference harness (Task 7) will populate samples by calling
 * an LLM provider. For now, this produces a valid but empty report
 * that downstream code (CLI, tests) can compile against.
 */
export function runCalibrationBenchmark(
  options: CalibrationBenchmarkOptions = {},
): CalibrationBenchmarkReport {
  const now = options.now ?? new Date();
  const outputDir = resolve(
    options.outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks'),
  );
  const artifactPath = join(
    outputDir,
    `calibration-${toArtifactTimestamp(now)}.json`,
  );

  const labelMode = options.labelMode ?? 'numerical-vs-none';

  const allTasks = defaultCalibrationTasks();
  const tasks = selectTasks(allTasks, options.taskCount);
  const modelId = options.modelId ?? 'default';

  // For the report, store the task set that reflects the treatment prompts
  const reportTasks =
    labelMode === 'numerical-vs-categorical'
      ? selectTasks(defaultCategoricalLabelTasks(), options.taskCount)
      : tasks;

  // Placeholder: in Task 7, this will be populated by LLM calls
  const samples: ConfidenceSample[] = [];

  // Compute curves from samples (empty for now)
  const treatmentSamples = samples.filter((s) => s.variant === 'treatment');
  const controlSamples = samples.filter((s) => s.variant === 'control');

  const treatment = computeEce(treatmentSamples);
  const control = computeEce(controlSamples);
  const comparison = bootstrapComparison(treatmentSamples, controlSamples);
  const stratified = stratifiedComparisons(samples);

  let verdict: 'VALIDATED' | 'REFUTED' | 'INCONCLUSIVE';
  if (!comparison.significant || comparison.deltaEce === 0) {
    verdict = 'INCONCLUSIVE';
  } else {
    verdict = comparison.deltaEce < 0 ? 'VALIDATED' : 'REFUTED';
  }

  mkdirSync(outputDir, { recursive: true });

  const report: CalibrationBenchmarkReport = {
    schemaVersion: 1,
    benchmarkType: 'ols_mcc_evidence_label_calibration',
    modelId,
    generatedAt: now.toISOString(),
    artifactPath,
    environment: {
      platform: process.platform,
      node: process.version,
    },
    summary: {
      taskCount: reportTasks.length,
      treatmentSamples: treatmentSamples.length,
      controlSamples: controlSamples.length,
      treatmentEce: treatment.ece,
      controlEce: control.ece,
      deltaEce: comparison.deltaEce,
      significant: comparison.significant,
      verdict,
    },
    tasks: reportTasks,
    samples,
    treatment,
    control,
    comparison,
    stratified,
    nextActions: buildNextActions(verdict, samples.length),
  };

  // Validate
  const parsed = CalibrationBenchmarkReportSchema.parse(report as unknown);
  writeFileSync(
    artifactPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    'utf8',
  );

  return report;
}

function buildNextActions(
  verdict: 'VALIDATED' | 'REFUTED' | 'INCONCLUSIVE',
  sampleCount: number,
): string[] {
  if (sampleCount === 0) {
    return [
      'Populate samples by running the LLM inference harness (babel benchmark calibration --live).',
      'Re-run after samples are collected to compute actual ECE values.',
    ];
  }
  if (verdict === 'VALIDATED') {
    return [
      'Update ols-empirical-validation-v1.0.md: upgrade "Evidence Labels improve calibration" from [INFERRED] to [VALIDATED].',
      'Include the delta ECE and p-value in the validation register entry.',
    ];
  }
  if (verdict === 'REFUTED') {
    return [
      'Update ols-empirical-validation-v1.0.md: mark "Evidence Labels improve calibration" as [REFUTED].',
      'Investigate: are labels well-formed but miscalibrated? Re-check prompt templates.',
    ];
  }
  return [
    'Insufficient evidence for a conclusive verdict. Increase task count or sample size.',
    'Check stratified results for categories where the effect is directionally clear.',
  ];
}

// ─── Live LLM harness ──────────────────────────────────────────────────────────

/** Callback signature for LLM completion. Returns the model's text response. */
export type LlmCallFn = (prompt: string) => Promise<string>;

/** Options for the live benchmark run. */
export interface CalibrationBenchmarkLiveOptions
  extends CalibrationBenchmarkOptions {
  /** Provider-agnostic LLM call function. */
  llmCall: LlmCallFn;
  /** Milliseconds between LLM calls (rate limiting). Default: 500. */
  delayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the calibration benchmark with live LLM calls.
 *
 * For each task, sends both the control and treatment prompts to the LLM,
 * extracts confidence scores, scores correctness against ground truth,
 * and assembles the full report.
 *
 * The `llmCall` callback keeps this function provider-agnostic — wire up
 * DeepInfra, DeepSeek, or any other provider at the CLI layer.
 */
export async function runCalibrationBenchmarkLive(
  options: CalibrationBenchmarkLiveOptions,
): Promise<CalibrationBenchmarkReport> {
  const now = options.now ?? new Date();
  const outputDir = resolve(
    options.outputDir ?? join(BABEL_RUNS_DIR, 'benchmarks'),
  );
  const artifactPath = join(
    outputDir,
    `calibration-${toArtifactTimestamp(now)}.json`,
  );

  const labelMode = options.labelMode ?? 'numerical-vs-none';
  const isCategoricalControl = labelMode === 'numerical-vs-categorical';

  const allTasks = defaultCalibrationTasks();
  const tasks = selectTasks(allTasks, options.taskCount);
  const modelId = options.modelId ?? 'default';
  const delayMs = options.delayMs ?? 500;

  // For categorical control mode, load the paired categorical task variants
  const allCategoricalTasks = defaultCategoricalLabelTasks();
  const categoricalTasks = selectTasks(allCategoricalTasks, options.taskCount);

  const samples: ConfidenceSample[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const catTask = categoricalTasks[i] ?? task; // fallback if lengths diverge

    // Control: either no labels or categorical labels depending on mode
    const controlPrompt = isCategoricalControl
      ? catTask.treatmentPrompt  // categorical label prompt
      : task.controlPrompt;      // no-label prompt
    let controlResp: string;
    try {
      controlResp = await options.llmCall(controlPrompt);
    } catch (err) {
      console.warn(
        `[calibration] LLM call failed for ${task.id}/control: ${err}`,
      );
      controlResp = '';
    }
    await sleep(delayMs);

    if (isCategoricalControl) {
      const catConf = extractCategoricalConfidence(controlResp);
      samples.push({
        taskId: task.id,
        modelId,
        variant: 'control',
        statedConfidence: catConf.confidence,
        confidenceInterval: 0,
        isCorrect: scoreCorrectness(controlResp, task.groundTruth, task.category),
        claimText: controlResp.slice(0, 500),
        ...(catConf.label !== undefined ? { evidenceLabel: catConf.label } : {}),
      });
    } else {
      samples.push({
        taskId: task.id,
        modelId,
        variant: 'control',
        statedConfidence: extractControlConfidence(controlResp),
        confidenceInterval: 0,
        isCorrect: scoreCorrectness(controlResp, task.groundTruth, task.category),
        claimText: controlResp.slice(0, 500),
      });
    }

    // Treatment (always with numerical Evidence Labels)
    let treatmentResp: string;
    try {
      treatmentResp = await options.llmCall(task.treatmentPrompt);
    } catch (err) {
      console.warn(
        `[calibration] LLM call failed for ${task.id}/treatment: ${err}`,
      );
      treatmentResp = '';
    }
    await sleep(delayMs);
    const conf = extractTreatmentConfidence(treatmentResp);
    samples.push({
      taskId: task.id,
      modelId,
      variant: 'treatment',
      statedConfidence: conf.confidence,
      confidenceInterval: conf.interval,
      isCorrect: scoreCorrectness(
        treatmentResp,
        task.groundTruth,
        task.category,
      ),
      claimText: treatmentResp.slice(0, 500),
      ...(conf.label !== undefined ? { evidenceLabel: conf.label } : {}),
    });
  }

  // Compute curves & comparison
  const treatmentSamples = samples.filter((s) => s.variant === 'treatment');
  const controlSamples = samples.filter((s) => s.variant === 'control');

  const treatment = computeEce(treatmentSamples);
  const control = computeEce(controlSamples);
  const comparison = bootstrapComparison(treatmentSamples, controlSamples);
  const stratified = stratifiedComparisons(samples);

  let verdict: 'VALIDATED' | 'REFUTED' | 'INCONCLUSIVE';
  if (!comparison.significant || comparison.deltaEce === 0) {
    verdict = 'INCONCLUSIVE';
  } else {
    verdict = comparison.deltaEce < 0 ? 'VALIDATED' : 'REFUTED';
  }

  // For the report, store the task set that reflects the control prompts
  const reportTasks = isCategoricalControl ? categoricalTasks : tasks;

  mkdirSync(outputDir, { recursive: true });

  const report: CalibrationBenchmarkReport = {
    schemaVersion: 1,
    benchmarkType: 'ols_mcc_evidence_label_calibration',
    modelId,
    generatedAt: now.toISOString(),
    artifactPath,
    environment: {
      platform: process.platform,
      node: process.version,
    },
    summary: {
      taskCount: reportTasks.length,
      treatmentSamples: treatmentSamples.length,
      controlSamples: controlSamples.length,
      treatmentEce: treatment.ece,
      controlEce: control.ece,
      deltaEce: comparison.deltaEce,
      significant: comparison.significant,
      verdict,
    },
    tasks: reportTasks,
    samples,
    treatment,
    control,
    comparison,
    stratified,
    nextActions: buildNextActions(verdict, samples.length),
  };

  const parsed = CalibrationBenchmarkReportSchema.parse(report as unknown);
  writeFileSync(artifactPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  return report;
}

// ─── Human-readable formatter ──────────────────────────────────────────────────

export function formatCalibrationBenchmarkHuman(
  report: CalibrationBenchmarkReport,
): string {
  const lines = [
    'OLS-MCC Evidence Label Calibration Benchmark',
    `Artifact: ${report.artifactPath}`,
    `Generated: ${report.generatedAt}`,
    `Model: ${report.modelId}`,
    '',
    `Tasks: ${report.summary.taskCount}`,
    `Samples: ${report.summary.treatmentSamples} treatment, ${report.summary.controlSamples} control`,
    '',
    '── Calibration Curves ──',
    `Treatment ECE: ${report.summary.treatmentEce.toFixed(4)}`,
    `Control ECE:   ${report.summary.controlEce.toFixed(4)}`,
    `Delta ECE:     ${report.summary.deltaEce.toFixed(4)}`,
    `p-value:       ${report.comparison.pValue.toFixed(4)}`,
    `Significant:   ${report.summary.significant ? 'yes' : 'no'}`,
    `95% CI:        [${report.comparison.deltaEceCi95[0].toFixed(4)}, ${report.comparison.deltaEceCi95[1].toFixed(4)}]`,
    '',
    `Verdict: ${report.summary.verdict}`,
    '',
  ];

  // Per-bin breakdown
  if (report.treatment.bins.length > 0) {
    lines.push('── Treatment Bins (equal-width) ──');
    lines.push(
      'Range        Count   AvgConf  AvgAcc   |Acc−Conf|',
    );
    for (const bin of report.treatment.bins) {
      if (bin.count === 0) continue;
      lines.push(
        `${bin.binLower.toFixed(1)}–${bin.binUpper.toFixed(1)}`.padEnd(13) +
          `${String(bin.count).padEnd(8)}` +
          `${bin.avgConfidence.toFixed(3).padEnd(9)}` +
          `${bin.avgAccuracy.toFixed(3).padEnd(9)}` +
          `${Math.abs(bin.avgAccuracy - bin.avgConfidence).toFixed(3)}`,
      );
    }
    lines.push('');
  }

  // Stratified
  if (report.stratified.length > 0) {
    lines.push('── By Category ──');
    for (const strat of report.stratified) {
      const dir = strat.deltaEce < 0 ? '✓' : '✗';
      lines.push(
        `${dir} ${strat.category.padEnd(24)} ΔECE=${strat.deltaEce.toFixed(4)} (n=${strat.sampleCount})`,
      );
    }
    lines.push('');
  }

  lines.push('Next actions:');
  for (const action of report.nextActions) {
    lines.push(`  → ${action}`);
  }

  return lines.join('\n');
}

// ─── ASCII calibration curve renderer ─────────────────────────────────────────

/**
 * Renders a simple ASCII calibration curve for terminal output.
 * Each character column is a confidence bin; height shows accuracy vs confidence.
 */
export function renderCalibrationCurveAscii(
  curve: CalibrationCurve,
  label: string,
): string {
  if (curve.bins.length === 0) return `${label}: (no data)`;

  const lines: string[] = [`${label} (ECE=${curve.ece.toFixed(3)}, n=${curve.sampleCount})`];
  const maxHeight = 10;

  // Find max value to scale
  let maxVal = 0;
  for (const bin of curve.bins) {
    if (bin.avgConfidence > maxVal) maxVal = bin.avgConfidence;
    if (bin.avgAccuracy > maxVal) maxVal = bin.avgAccuracy;
  }
  if (maxVal === 0) maxVal = 1;

  for (let row = maxHeight; row >= 0; row--) {
    let line = '';
    const val = (row / maxHeight) * maxVal;
    for (const bin of curve.bins) {
      if (bin.count === 0) {
        line += ' ';
        continue;
      }
      const confAbove = bin.avgConfidence >= val;
      const accAbove = bin.avgAccuracy >= val;
      if (confAbove && accAbove) line += '█';
      else if (confAbove) line += 'C'; // confidence-only
      else if (accAbove) line += 'A'; // accuracy-only
      else line += ' ';
    }
    const yLabel =
      row === maxHeight
        ? maxVal.toFixed(1)
        : row === 0
          ? '0.0'
          : '';
    lines.push(`${yLabel.padStart(4)} │${line}`);
  }
  lines.push(`     └${'─'.repeat(curve.bins.length)}`);
  lines.push(
    `     0${' '.repeat(Math.max(0, curve.bins.length - 4))}1.0 (confidence)`,
  );

  return lines.join('\n');
}
