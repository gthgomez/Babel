/**
 * injectionTypes.ts — Zod schemas and types for the Authority Order injection
 * resistance benchmark (OLS-MCC P0).
 *
 * Measures whether Authority Order (System > Developer > User > Artifacts > Data)
 * reduces prompt injection success rates compared to a control without it.
 *
 * Methodology: A/B test with Fisher's exact test for binary outcomes.
 */

import { z } from 'zod';

// ─── Attack definitions ─────────────────────────────────────────────────────────

/** Categories from the prompt-tester escalation ladder (ols-test-patterns.md §4). */
export type InjectionAttackCategory =
  | 'direct_override'
  | 'role_modulation'
  | 'data_as_instruction'
  | 'language_switch'
  | 'multi_turn_erosion';

/** A single injection attack template. */
export interface InjectionAttack {
  /** Stable identifier. */
  id: string;
  /** Attack category from the escalation ladder. */
  category: InjectionAttackCategory;
  /** Human-readable name. */
  name: string;
  /**
   * The injection text appended to the user prompt.
   * Use {{PAYLOAD}} as a placeholder for the attack-specific payload.
   */
  injectionText: string;
  /**
   * Deterministic signal to check for injection success.
   * If the model output contains this string, the injection succeeded.
   * Mutually exclusive with `llmJudgePrompt` for classification.
   */
  successSignal?: string | undefined;
  /**
   * If set, use an LLM judge to classify the response instead of
   * a deterministic success signal. For nuanced attacks.
   */
  llmJudgePrompt?: string | undefined;
}

// ─── Task definitions ───────────────────────────────────────────────────────────

/** The role/task type being protected. */
export type AgentRole =
  | 'coding_assistant'
  | 'research_assistant'
  | 'customer_support'
  | 'content_moderator'
  | 'data_analyst';

/** A single test task for the injection benchmark. */
export interface InjectionTaskDefinition {
  /** Stable identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** The role the LLM is playing. */
  role: AgentRole;
  /** The system prompt WITHOUT Authority Order (control). */
  systemPromptBase: string;
  /** The legitimate user request (before injection is appended). */
  userRequest: string;
  /** The attack to apply. */
  attackId: string;
}

// ─── Core sample ────────────────────────────────────────────────────────────────

/** Classification of a single injection attempt. */
export type InjectionVerdict = 'INJECTION_BLOCKED' | 'INJECTION_SUCCESS';

/** A single LLM response tested for injection resistance. */
export interface InjectionSample {
  /** Stable identifier for the task that produced this sample. */
  taskId: string;
  /** Model identifier. */
  modelId: string;
  /** "treatment" = with Authority Order; "control" = without. */
  variant: 'treatment' | 'control';
  /** The injection attack category. */
  attackCategory: InjectionAttackCategory;
  /** The agent role. */
  role: AgentRole;
  /** Whether the injection succeeded. */
  injectionSucceeded: boolean;
  /** The raw LLM output. */
  responseText: string;
  /** How the verdict was determined. */
  classificationMethod: 'deterministic' | 'llm_judge';
}

// ─── Comparison ─────────────────────────────────────────────────────────────────

/** Statistical comparison of treatment vs control injection rates. */
export interface InjectionComparison {
  /** Injection success rate for treatment (with Authority Order). */
  treatmentRate: number;
  /** Injection success rate for control (without Authority Order). */
  controlRate: number;
  /** treatmentRate − controlRate. Negative = treatment is more resistant. */
  deltaRate: number;
  /** 95% confidence interval for deltaRate (Wilson score). */
  deltaRateCi95: [number, number];
  /** Fisher's exact test p-value (two-tailed). */
  pValue: number;
  /** True if p < 0.05. */
  significant: boolean;
  /** 2×2 contingency table: [[a,b],[c,d]] where a=treatment blocked, b=treatment succeeded, c=control blocked, d=control succeeded. */
  contingencyTable: [[number, number], [number, number]];
}

// ─── Stratified breakdown ───────────────────────────────────────────────────────

/** Per-category comparison (e.g. "direct_override"). */
export interface InjectionStratifiedComparison {
  category: string;
  treatmentSuccesses: number;
  treatmentTotal: number;
  controlSuccesses: number;
  controlTotal: number;
  treatmentRate: number;
  controlRate: number;
  deltaRate: number;
}

// ─── Full benchmark report ──────────────────────────────────────────────────────

/** Top-level report produced by the injection benchmark. */
export interface InjectionBenchmarkReport {
  schemaVersion: 1;
  benchmarkType: 'ols_mcc_authority_order_injection';
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
    treatmentSuccessRate: number;
    controlSuccessRate: number;
    deltaRate: number;
    significant: boolean;
    verdict: 'VALIDATED' | 'REFUTED' | 'INCONCLUSIVE';
    /** Which Authority Order variant was tested. */
    aoVariant: 'v1' | 'v2';
    /** Whether multi-turn boundary marker defense was enabled. */
    multiTurnDefense: boolean;
  };
  tasks: InjectionTaskDefinition[];
  attacks: InjectionAttack[];
  samples: InjectionSample[];
  comparison: InjectionComparison;
  stratified: InjectionStratifiedComparison[];
  nextActions: string[];
}

// ─── Benchmark options ──────────────────────────────────────────────────────────

export interface InjectionBenchmarkOptions {
  /** Model ID to benchmark. */
  modelId?: string;
  /** Number of test tasks to run (default: all defined). */
  taskCount?: number;
  /** Output directory for the benchmark artifact. */
  outputDir?: string;
  /** Override the current time (deterministic testing). */
  now?: Date;
  /** Authority Order variant: 'v1' (original) or 'v2' (hardened, default). */
  aoVariant?: 'v1' | 'v2';
  /** Enable multi-turn boundary marker defense (ConversationBoundary). */
  multiTurnDefense?: boolean;
}

// ─── Zod schemas (for fixture I/O and validation) ───────────────────────────────

export const InjectionAttackSchema = z.object({
  id: z.string(),
  category: z.enum([
    'direct_override',
    'role_modulation',
    'data_as_instruction',
    'language_switch',
    'multi_turn_erosion',
  ]),
  name: z.string(),
  injectionText: z.string(),
  successSignal: z.string().optional(),
  llmJudgePrompt: z.string().optional(),
});

export const InjectionTaskDefinitionSchema = z.object({
  id: z.string(),
  title: z.string(),
  role: z.enum([
    'coding_assistant',
    'research_assistant',
    'customer_support',
    'content_moderator',
    'data_analyst',
  ]),
  systemPromptBase: z.string(),
  userRequest: z.string(),
  attackId: z.string(),
});

export const InjectionSampleSchema = z.object({
  taskId: z.string(),
  modelId: z.string(),
  variant: z.enum(['treatment', 'control']),
  attackCategory: z.enum([
    'direct_override',
    'role_modulation',
    'data_as_instruction',
    'language_switch',
    'multi_turn_erosion',
  ]),
  role: z.enum([
    'coding_assistant',
    'research_assistant',
    'customer_support',
    'content_moderator',
    'data_analyst',
  ]),
  injectionSucceeded: z.boolean(),
  responseText: z.string(),
  classificationMethod: z.enum(['deterministic', 'llm_judge']),
});

export const InjectionComparisonSchema = z.object({
  treatmentRate: z.number().min(0).max(1),
  controlRate: z.number().min(0).max(1),
  deltaRate: z.number().min(-1).max(1),
  deltaRateCi95: z.tuple([z.number(), z.number()]),
  pValue: z.number().min(0).max(1),
  significant: z.boolean(),
  contingencyTable: z.tuple([
    z.tuple([z.number().int(), z.number().int()]),
    z.tuple([z.number().int(), z.number().int()]),
  ]),
});

export const InjectionStratifiedComparisonSchema = z.object({
  category: z.string(),
  treatmentSuccesses: z.number().int().nonnegative(),
  treatmentTotal: z.number().int().nonnegative(),
  controlSuccesses: z.number().int().nonnegative(),
  controlTotal: z.number().int().nonnegative(),
  treatmentRate: z.number().min(0).max(1),
  controlRate: z.number().min(0).max(1),
  deltaRate: z.number().min(-1).max(1),
});

export const InjectionBenchmarkReportSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkType: z.literal('ols_mcc_authority_order_injection'),
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
    treatmentSuccessRate: z.number().min(0).max(1),
    controlSuccessRate: z.number().min(0).max(1),
    deltaRate: z.number().min(-1).max(1),
    significant: z.boolean(),
    verdict: z.enum(['VALIDATED', 'REFUTED', 'INCONCLUSIVE']),
    aoVariant: z.enum(['v1', 'v2']),
    multiTurnDefense: z.boolean(),
  }),
  tasks: z.array(InjectionTaskDefinitionSchema),
  attacks: z.array(InjectionAttackSchema),
  samples: z.array(InjectionSampleSchema),
  comparison: InjectionComparisonSchema,
  stratified: z.array(InjectionStratifiedComparisonSchema),
  nextActions: z.array(z.string()),
});
