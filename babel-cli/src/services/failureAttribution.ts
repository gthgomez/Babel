import { z } from "zod";
import { createHash } from "node:crypto";

export const FAILURE_ATTRIBUTION_VERSION = 1 as const;

export const FAILURE_CATEGORIES = [
  "MODEL_JUDGMENT_FAILURE",
  "HARNESS_RESTRICTION",
  "TOOL_FAILURE",
  "ENVIRONMENT_FAILURE",
  "SPEC_AMBIGUITY",
  "CONTEXT_LOSS",
  "VERIFIER_FAILURE",
  "INFRA_FAILURE",
  "MODEL_CAPABILITY_LIMIT",
  "PERMISSION_BLOCK",
  "FLAKY_TEST",
  "UNKNOWN",
] as const;

export type FailureCategoryV1 = (typeof FAILURE_CATEGORIES)[number];

export interface FailureEvidenceV1 {
  evidence_id: string;
  source:
    | "test"
    | "build"
    | "command"
    | "policy"
    | "environment"
    | "operator"
    | "model_self_report";
  detail: string;
  supports_category: FailureCategoryV1 | null;
  /** Provenance is optional for compatibility, but required for high confidence. */
  producer_id?: string;
  source_domain?: string;
  run_id?: string;
  observation_id?: string;
}

export interface FailureAttributionV1 {
  schema_version: typeof FAILURE_ATTRIBUTION_VERSION;
  failure_id: string;
  category: FailureCategoryV1;
  confidence: "low" | "medium" | "high" | "unknown";
  evidence: FailureEvidenceV1[];
  alternative_hypotheses: FailureCategoryV1[];
  task_id: string;
  contract_hash: string;
  model: string | null;
  harness: string | null;
  environment: string | null;
  tool_capabilities: string[];
  base_sha: string | null;
  candidate_sha: string | null;
}

const evidenceSchema = z
  .object({
    evidence_id: z.string().min(1),
    source: z.enum([
      "test",
      "build",
      "command",
      "policy",
      "environment",
      "operator",
      "model_self_report",
    ]),
    detail: z.string().min(1).max(8_000),
    supports_category: z
      .enum(FAILURE_CATEGORIES as unknown as [string, ...string[]])
      .nullable(),
    producer_id: z.string().min(1).optional(),
    source_domain: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    observation_id: z.string().min(1).optional(),
  })
  .strict();

export const FailureAttributionV1Schema = z
  .object({
    schema_version: z.literal(FAILURE_ATTRIBUTION_VERSION),
    failure_id: z.string().min(1),
    category: z.enum(FAILURE_CATEGORIES as unknown as [string, ...string[]]),
    confidence: z.enum(["low", "medium", "high", "unknown"]),
    evidence: z.array(evidenceSchema),
    alternative_hypotheses: z.array(
      z.enum(FAILURE_CATEGORIES as unknown as [string, ...string[]]),
    ),
    task_id: z.string().min(1),
    contract_hash: z.string().regex(/^[0-9a-f]{32,64}$/),
    model: z.string().nullable(),
    harness: z.string().nullable(),
    environment: z.string().nullable(),
    tool_capabilities: z.array(z.string()),
    base_sha: z.string().nullable(),
    candidate_sha: z.string().nullable(),
  })
  .strict();

/** Attribute only from independent evidence; a model's diagnosis is never causal proof. */
export function attributeFailureV1(input: {
  failure_id: string;
  proposed_category?: FailureCategoryV1;
  evidence: FailureEvidenceV1[];
  alternative_hypotheses?: FailureCategoryV1[];
  task_id: string;
  contract_hash: string;
  model?: string | null;
  harness?: string | null;
  environment?: string | null;
  tool_capabilities?: string[];
  base_sha?: string | null;
  candidate_sha?: string | null;
}): FailureAttributionV1 {
  const causal = input.evidence.filter(
    (item) =>
      item.source !== "model_self_report" && item.supports_category !== null,
  );
  const uniqueCausal = [
    ...new Map(
      causal.map((item) => [
        item.observation_id
          ? `${item.source_domain ?? "unknown"}|${item.run_id ?? "unknown"}|${item.observation_id}`
          : createHash("sha256")
              .update(
                JSON.stringify({
                  source: item.source,
                  detail: item.detail,
                  supports_category: item.supports_category,
                  source_domain: item.source_domain ?? null,
                  run_id: item.run_id ?? null,
                }),
              )
              .digest("hex"),
        item,
      ]),
    ).values(),
  ];
  const categories = [
    ...new Set(
      uniqueCausal
        .map((item) => item.supports_category)
        .filter(
          (category): category is FailureCategoryV1 =>
            category !== null && category !== "UNKNOWN",
        ),
    ),
  ];
  const category = categories.length === 1 ? categories[0]! : "UNKNOWN";
  const independentProvenance = new Set(
    uniqueCausal
      .filter(
        (item) =>
          item.producer_id &&
          item.source_domain &&
          item.run_id &&
          item.observation_id,
      )
      .map(
        (item) => `${item.producer_id}|${item.source_domain}|${item.run_id}`,
      ),
  );
  const confidence =
    category === "UNKNOWN"
      ? "unknown"
      : categories.length === 1 && independentProvenance.size > 1
        ? "high"
        : "medium";
  const alternatives = [
    ...new Set([
      ...(input.alternative_hypotheses ?? []),
      ...(input.proposed_category && input.proposed_category !== category
        ? [input.proposed_category]
        : []),
      ...categories.filter((item) => item !== category),
    ]),
  ].filter((item) => item !== category);
  return {
    schema_version: FAILURE_ATTRIBUTION_VERSION,
    failure_id: input.failure_id,
    category,
    confidence,
    evidence: input.evidence.map((item) => ({ ...item })),
    alternative_hypotheses: alternatives,
    task_id: input.task_id,
    contract_hash: input.contract_hash,
    model: input.model ?? null,
    harness: input.harness ?? null,
    environment: input.environment ?? null,
    tool_capabilities: [...(input.tool_capabilities ?? [])],
    base_sha: input.base_sha ?? null,
    candidate_sha: input.candidate_sha ?? null,
  };
}

export function validateFailureAttributionV1(value: unknown): string[] {
  const parsed = FailureAttributionV1Schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.path.join(".") || "$");
}
