import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import type { AgentEndpointV1 } from "../agent/agentEndpoint.js";
import type { CompletionStatusV1 } from "../evidence/evidenceGraph.js";
import {
  assertDurableValueSafe,
  sanitizeDurableString,
} from "../utils/redaction.js";

export const RELIABILITY_TELEMETRY_VERSION = 1 as const;
export const RELIABILITY_TELEMETRY_FILENAME = "reliability-telemetry.jsonl";

export interface ReliabilityTelemetryV1 {
  schema_version: typeof RELIABILITY_TELEMETRY_VERSION;
  run_id: string;
  task_id: string;
  task_class: string | null;
  risk: string | null;
  model: string | null;
  harness: string | null;
  tool_profile: string | null;
  success: boolean | null;
  verification_result: CompletionStatusV1 | null;
  attempt_count: number | null;
  human_interventions: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  escaped_defect: boolean | null;
  recorded_at: string;
}

const telemetrySchema = z
  .object({
    schema_version: z.literal(RELIABILITY_TELEMETRY_VERSION),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    task_class: z.string().nullable(),
    risk: z.string().nullable(),
    model: z.string().nullable(),
    harness: z.string().nullable(),
    tool_profile: z.string().nullable(),
    success: z.boolean().nullable(),
    verification_result: z
      .enum(["UNVERIFIED", "PARTIAL", "FAILED", "VERIFIED", "UNKNOWN"])
      .nullable(),
    attempt_count: z.number().int().nonnegative().nullable(),
    human_interventions: z.number().int().nonnegative().nullable(),
    duration_ms: z.number().nonnegative().nullable(),
    cost_usd: z.number().nonnegative().nullable(),
    escaped_defect: z.boolean().nullable(),
    recorded_at: z.string().datetime(),
  })
  .strict();

export function buildReliabilityTelemetryV1(input: {
  run_id: string;
  task_id: string;
  task_class?: string | null;
  risk?: string | null;
  endpoint?: Pick<AgentEndpointV1, "model" | "harness">;
  model?: string | null;
  harness?: string | null;
  tool_profile?: string | null;
  success?: boolean | null;
  verification_result?: CompletionStatusV1 | null;
  attempt_count?: number | null;
  human_interventions?: number | null;
  duration_ms?: number | null;
  cost_usd?: number | null;
  escaped_defect?: boolean | null;
  recorded_at?: string;
}): ReliabilityTelemetryV1 {
  const record: ReliabilityTelemetryV1 = {
    schema_version: RELIABILITY_TELEMETRY_VERSION,
    run_id: sanitizeDurableString(input.run_id, "telemetry.run_id"),
    task_id: sanitizeDurableString(input.task_id, "telemetry.task_id"),
    task_class:
      input.task_class === null || input.task_class === undefined
        ? null
        : sanitizeDurableString(input.task_class, "telemetry.task_class"),
    risk:
      input.risk === null || input.risk === undefined
        ? null
        : sanitizeDurableString(input.risk, "telemetry.risk"),
    model:
      input.model === null || input.model === undefined
        ? input.endpoint?.model === undefined
          ? null
          : sanitizeDurableString(input.endpoint.model, "telemetry.model")
        : sanitizeDurableString(input.model, "telemetry.model"),
    harness:
      input.harness === null || input.harness === undefined
        ? input.endpoint?.harness === undefined
          ? null
          : sanitizeDurableString(input.endpoint.harness, "telemetry.harness")
        : sanitizeDurableString(input.harness, "telemetry.harness"),
    tool_profile:
      input.tool_profile === null || input.tool_profile === undefined
        ? null
        : sanitizeDurableString(input.tool_profile, "telemetry.tool_profile"),
    success: input.success ?? null,
    verification_result: input.verification_result ?? null,
    attempt_count: input.attempt_count ?? null,
    human_interventions: input.human_interventions ?? null,
    duration_ms: input.duration_ms ?? null,
    cost_usd: input.cost_usd ?? null,
    escaped_defect: input.escaped_defect ?? null,
    recorded_at: input.recorded_at ?? new Date().toISOString(),
  };
  const parsed = telemetrySchema.safeParse(record);
  if (!parsed.success)
    throw new Error(`Invalid reliability telemetry: ${parsed.error.message}`);
  return record;
}

export function validateReliabilityTelemetryV1(value: unknown): string[] {
  const parsed = telemetrySchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.path.join(".") || "$");
}

/** Append one bounded, nullable run outcome; no ranking or automatic routing is performed. */
export function appendReliabilityTelemetryV1(
  path: string,
  record: ReliabilityTelemetryV1,
): void {
  const errors = validateReliabilityTelemetryV1(record);
  if (errors.length > 0)
    throw new Error(`Invalid reliability telemetry: ${errors.join(", ")}`);
  assertDurableValueSafe(record, "reliability_telemetry");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function loadReliabilityTelemetryV1(
  path: string,
): ReliabilityTelemetryV1[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(
          `Invalid telemetry JSON at line ${index + 1}: ${String(error)}`,
        );
      }
      const errors = validateReliabilityTelemetryV1(value);
      if (errors.length > 0)
        throw new Error(
          `Invalid reliability telemetry at line ${index + 1}: ${errors.join(", ")}`,
        );
      assertDurableValueSafe(value, "reliability_telemetry");
      return value as ReliabilityTelemetryV1;
    });
}
