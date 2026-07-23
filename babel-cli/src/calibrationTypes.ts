/**
 * calibrationTypes.ts — Zod schemas and types for the Evidence Label
 * calibration benchmark (OLS-MCC P2(b)).
 *
 * Measures whether OLS-MCC Evidence Labels with numerical confidence scores
 * (`[LABEL, c=0.XX±0.YY]`, per v4.4 §7.2) produce better-calibrated LLM
 * outputs compared to unlabeled outputs.
 *
 * Follows the DoublyCal (IJCAI 2026) methodology: binned ECE, adaptive
 * equal-mass ECE, and bootstrap confidence intervals on the delta.
 */

import { z } from 'zod';

// ─── Core sample ───────────────────────────────────────────────────────────────

/** A single LLM response scored for calibration. */
export interface ConfidenceSample {
  /** Stable identifier for the task that produced this sample. */
  taskId: string;
  /** Model identifier (provider shorthand, e.g. "deepseek-chat"). */
  modelId: string;
  /** "treatment" = with Evidence Labels; "control" = without. */
  variant: 'treatment' | 'control';
  /** The confidence value stated by the LLM (0–1). Extracted from
   *  `c=0.XX` in treatment; inferred from verbal cues in control. */
  statedConfidence: number;
  /** The ± interval width from `c=0.XX±0.YY`, or 0 if none. */
  confidenceInterval: number;
  /** Whether the LLM's claim is factually correct (ground-truth). */
  isCorrect: boolean;
  /** The raw claim text extracted from the response. */
  claimText: string;
  /** The Evidence Label name (PROVEN, OBSERVED, INFERRED, etc.), or
   *  undefined for control samples. */
  evidenceLabel?: string;
}

// ─── Calibration curve ─────────────────────────────────────────────────────────

/** One bin in a calibration curve. */
export interface CalibrationBin {
  binLower: number;
  binUpper: number;
  /** Number of samples in this bin. */
  count: number;
  /** Mean stated confidence across samples in this bin. */
  avgConfidence: number;
  /** Mean accuracy (fraction correct) across samples in this bin. */
  avgAccuracy: number;
  /** |avgAccuracy - avgConfidence| × weight of this bin. */
  binEce: number;
}

/** A full calibration curve with ECE metrics. */
export interface CalibrationCurve {
  /** Equal-width bins (10 bins, [0–0.1), [0.1–0.2), …). */
  bins: CalibrationBin[];
  /** Expected Calibration Error (equal-width bins). */
  ece: number;
  /** Adaptive equal-mass ECE (each bin has the same number of samples). */
  adaptiveEce: number;
  /** Total number of samples in this curve. */
  sampleCount: number;
}

// ─── Comparison ─────────────────────────────────────────────────────────────────

/** Statistical comparison of treatment vs control calibration. */
export interface CalibrationComparison {
  /** ECE for the treatment group (with Evidence Labels). */
  treatmentEce: number;
  /** ECE for the control group (without Evidence Labels). */
  controlEce: number;
  /** treatmentEce − controlEce. Negative = treatment is better calibrated. */
  deltaEce: number;
  /** 95% bootstrap confidence interval for deltaEce. */
  deltaEceCi95: [number, number];
  /** p-value from a paired bootstrap test. */
  pValue: number;
  /** True if p < 0.05 and the interval excludes 0. */
  significant: boolean;
}

// ─── Stratified breakdown ──────────────────────────────────────────────────────

/** Per-category comparison (e.g. "factual_qa"). */
export interface StratifiedComparison {
  category: string;
  treatmentEce: number;
  controlEce: number;
  deltaEce: number;
  sampleCount: number;
}

// ─── Full benchmark report ─────────────────────────────────────────────────────

/** Top-level report produced by the calibration benchmark. */
export interface CalibrationBenchmarkReport {
  schemaVersion: 1;
  benchmarkType: 'ols_mcc_evidence_label_calibration';
  modelId: string;
  generatedAt: string;
  artifactPath: string;
  environment: {
    platform: string;
    node: string;
  };
  summary: {
    taskCount: number;
    treatmentSamples: number;
    controlSamples: number;
    treatmentEce: number;
    controlEce: number;
    deltaEce: number;
    significant: boolean;
    verdict: 'VALIDATED' | 'REFUTED' | 'INCONCLUSIVE';
  };
  tasks: CalibrationTaskDefinition[];
  samples: ConfidenceSample[];
  treatment: CalibrationCurve;
  control: CalibrationCurve;
  comparison: CalibrationComparison;
  stratified: StratifiedComparison[];
  nextActions: string[];
}

// ─── Task definitions ──────────────────────────────────────────────────────────

export type CalibrationTaskCategory =
  | 'factual_qa'
  | 'numerical_estimation'
  | 'binary_classification'
  | 'constrained_generation';

/** A single test task for the calibration benchmark. */
export interface CalibrationTaskDefinition {
  id: string;
  title: string;
  category: CalibrationTaskCategory;
  /** The prompt WITHOUT Evidence Label requirements (control). */
  controlPrompt: string;
  /** The prompt WITH Evidence Label requirements (treatment). */
  treatmentPrompt: string;
  /** The correct answer, used to score isCorrect. */
  groundTruth: string;
  /** Optional function name for programmatic evaluation (constrained gen). */
  evaluator?: string;
}

// ─── Benchmark options ─────────────────────────────────────────────────────────

export interface CalibrationBenchmarkOptions {
  /** Model ID to benchmark (provider shorthand). */
  modelId?: string;
  /** Number of test tasks to run (default: all defined). */
  taskCount?: number;
  /** Output directory for the benchmark artifact. */
  outputDir?: string;
  /** Override the current time (deterministic testing). */
  now?: Date;
  /**
   * Label mode for the calibration comparison.
   * - 'numerical-vs-none' (default): Treatment has numerical scores; control has no labels.
   * - 'numerical-vs-categorical': Treatment has numerical scores; control has bare categorical labels.
   */
  labelMode?: 'numerical-vs-none' | 'numerical-vs-categorical';
}

// ─── Zod schemas (for fixture I/O and validation) ──────────────────────────────

export const ConfidenceSampleSchema = z.object({
  taskId: z.string(),
  modelId: z.string(),
  variant: z.enum(['treatment', 'control']),
  statedConfidence: z.number().min(0).max(1),
  confidenceInterval: z.number().min(0).max(0.5).default(0),
  isCorrect: z.boolean(),
  claimText: z.string(),
  evidenceLabel: z.string().optional(),
});

export const CalibrationBinSchema = z.object({
  binLower: z.number().min(0).max(1),
  binUpper: z.number().min(0).max(1),
  count: z.number().int().nonnegative(),
  avgConfidence: z.number().min(0).max(1),
  avgAccuracy: z.number().min(0).max(1),
  binEce: z.number().min(0),
});

export const CalibrationCurveSchema = z.object({
  bins: z.array(CalibrationBinSchema),
  ece: z.number().min(0),
  adaptiveEce: z.number().min(0),
  sampleCount: z.number().int().nonnegative(),
});

export const CalibrationComparisonSchema = z.object({
  treatmentEce: z.number().min(0),
  controlEce: z.number().min(0),
  deltaEce: z.number(),
  deltaEceCi95: z.tuple([z.number(), z.number()]),
  pValue: z.number().min(0).max(1),
  significant: z.boolean(),
});

export const StratifiedComparisonSchema = z.object({
  category: z.string(),
  treatmentEce: z.number().min(0),
  controlEce: z.number().min(0),
  deltaEce: z.number(),
  sampleCount: z.number().int().nonnegative(),
});

export const CalibrationTaskDefinitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum([
    'factual_qa',
    'numerical_estimation',
    'binary_classification',
    'constrained_generation',
  ]),
  controlPrompt: z.string(),
  treatmentPrompt: z.string(),
  groundTruth: z.string(),
  evaluator: z.string().optional(),
});

export const CalibrationBenchmarkReportSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkType: z.literal('ols_mcc_evidence_label_calibration'),
  modelId: z.string(),
  generatedAt: z.string(),
  artifactPath: z.string(),
  environment: z.object({
    platform: z.string(),
    node: z.string(),
  }),
  summary: z.object({
    taskCount: z.number().int().nonnegative(),
    treatmentSamples: z.number().int().nonnegative(),
    controlSamples: z.number().int().nonnegative(),
    treatmentEce: z.number(),
    controlEce: z.number(),
    deltaEce: z.number(),
    significant: z.boolean(),
    verdict: z.enum(['VALIDATED', 'REFUTED', 'INCONCLUSIVE']),
  }),
  tasks: z.array(CalibrationTaskDefinitionSchema),
  samples: z.array(ConfidenceSampleSchema),
  treatment: CalibrationCurveSchema,
  control: CalibrationCurveSchema,
  comparison: CalibrationComparisonSchema,
  stratified: z.array(StratifiedComparisonSchema),
  nextActions: z.array(z.string()),
});
