import { z } from "zod";

import {
  TASK_CONTRACT_VERSION,
  type AcceptanceRequirementV1,
  type TaskContractV1,
  validateTaskContractV1ForCompletion,
} from "../agent/taskContract.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";
import { deepFreeze } from "./freeze.js";

export const ACCEPTANCE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const ACCEPTANCE_BUNDLE_MAX_BYTES = 128 * 1024;

export type AcceptanceBundleView = "builder" | "verifier" | "auditor";

export interface AcceptanceOracleIsolationV1 {
  mode: "role_separation" | "isolated";
  storage: "outside_implementor_worktree" | "implementor_accessible";
  implementorCanRead: boolean;
  implementorCanWrite: boolean;
  execution: "trusted_runner" | "shared_process";
}

export interface AcceptanceBundleV1 {
  schema_version: typeof ACCEPTANCE_BUNDLE_SCHEMA_VERSION;
  bundle_id: string;
  task_id: string;
  contract_hash: string;
  builder_visible: AcceptanceRequirementV1[];
  restricted: AcceptanceRequirementV1[];
  restricted_boundary?: AcceptanceOracleIsolationV1;
  generator_role: "independent_acceptance_generator";
  created_at: string;
  frozen: true;
  bundle_hash: string;
}

const requirementSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    type: z.enum([
      "unit_test",
      "integration_test",
      "e2e",
      "build",
      "lint",
      "typecheck",
      "security",
      "policy",
      "manual",
      "runtime",
      "custom",
    ]),
    required: z.boolean(),
    verification_strategy: z.string().min(1),
    verification: z
      .object({
        kind: z.string().min(1),
        verifier_id: z.string().min(1),
        command_hash: z
          .string()
          .regex(/^[0-9a-f]{32,64}$/)
          .optional(),
        target: z.string().min(1).optional(),
        execution_profile: z.string().min(1).optional(),
        artifact_expectations: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  })
  .strict();

export const AcceptanceBundleV1Schema = z
  .object({
    schema_version: z.literal(ACCEPTANCE_BUNDLE_SCHEMA_VERSION),
    bundle_id: z.string().min(1),
    task_id: z.string().min(1),
    contract_hash: z.string().regex(/^[0-9a-f]{32,64}$/),
    builder_visible: z.array(requirementSchema),
    restricted: z.array(requirementSchema),
    restricted_boundary: z
      .object({
        mode: z.enum(["role_separation", "isolated"]),
        storage: z.enum(["outside_implementor_worktree", "implementor_accessible"]),
        implementorCanRead: z.boolean(),
        implementorCanWrite: z.boolean(),
        execution: z.enum(["trusted_runner", "shared_process"]),
      })
      .strict()
      .optional(),
    generator_role: z.literal("independent_acceptance_generator"),
    created_at: z.string().datetime(),
    frozen: z.literal(true),
    bundle_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

function bundleBody(
  bundle: Omit<AcceptanceBundleV1, "bundle_id" | "bundle_hash" | "frozen">,
): unknown {
  return bundle;
}

function requirementIds(
  requirements: readonly AcceptanceRequirementV1[],
): string[] {
  return requirements.map((requirement) => requirement.id);
}

/** Validate that a persisted bundle is an exact partition of frozen acceptance. */
export function validateAcceptanceBundleForContractV1(
  bundle: AcceptanceBundleV1,
  contract: TaskContractV1,
): string[] {
  const errors = validateAcceptanceBundleV1(bundle);
  if (bundle.task_id !== contract.task_id) errors.push("task_id");
  if (bundle.contract_hash !== contract.contract_hash)
    errors.push("contract_hash");
  const expected = new Map(
    contract.acceptance.map((requirement) => [
      requirement.id,
      canonicalJson(requirement),
    ]),
  );
  const actual = [...bundle.builder_visible, ...bundle.restricted];
  if (actual.length !== expected.size) errors.push("acceptance.partition");
  for (const requirement of actual) {
    if (expected.get(requirement.id) !== canonicalJson(requirement))
      errors.push(`acceptance.drift.${requirement.id}`);
  }
  for (const id of expected.keys()) {
    if (!actual.some((requirement) => requirement.id === id))
      errors.push(`acceptance.missing.${id}`);
  }
  return [...new Set(errors)];
}

function assertBoundTaskContract(contract: TaskContractV1): void {
  if (
    contract.schema_version !== TASK_CONTRACT_VERSION ||
    contract.frozen !== true
  ) {
    throw new Error("Acceptance escrow requires a frozen TaskContractV1.");
  }
  const errors = validateTaskContractV1ForCompletion(contract);
  if (errors.length > 0) {
    throw new Error(
      `Acceptance escrow task contract is invalid: ${errors.join(", ")}`,
    );
  }
}

/** Build a frozen role-separated bundle; restricted data is not cryptographically secret in V1. */
export function buildAcceptanceBundleV1(input: {
  taskContract: TaskContractV1;
  builder_visible?: AcceptanceRequirementV1[];
  restricted?: AcceptanceRequirementV1[];
  restricted_boundary?: AcceptanceOracleIsolationV1;
  created_at?: string;
}): AcceptanceBundleV1 {
  assertBoundTaskContract(input.taskContract);
  const builderVisible = [
    ...(input.builder_visible ?? input.taskContract.acceptance),
  ];
  const restricted = [...(input.restricted ?? [])];
  const contractById = new Map(
    input.taskContract.acceptance.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const ids = [
    ...requirementIds(builderVisible),
    ...requirementIds(restricted),
  ];
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      "Acceptance escrow requirement IDs must be unique across views.",
    );
  }
  if (
    ids.length !== contractById.size ||
    ids.some((id) => !contractById.has(id))
  ) {
    throw new Error(
      "Acceptance escrow must partition the frozen contract acceptance exactly.",
    );
  }
  for (const requirement of [...builderVisible, ...restricted]) {
    const canonical = contractById.get(requirement.id);
    if (JSON.stringify(canonical) !== JSON.stringify(requirement)) {
      throw new Error(
        `Acceptance escrow requirement drift rejected: ${requirement.id}`,
      );
    }
  }
  if (
    restricted.length > 0 &&
    input.restricted_boundary?.mode === "isolated" &&
    !(
      input.restricted_boundary.storage === "outside_implementor_worktree" &&
      input.restricted_boundary.implementorCanRead === false &&
      input.restricted_boundary.implementorCanWrite === false &&
      input.restricted_boundary.execution === "trusted_runner"
    )
  ) {
    throw new Error(
      "Isolated restricted oracles require external storage, no implementor access, and a trusted runner.",
    );
  }
  const createdAt = input.created_at ?? new Date().toISOString();
  const base = {
    schema_version: ACCEPTANCE_BUNDLE_SCHEMA_VERSION,
    task_id: input.taskContract.task_id,
    contract_hash: input.taskContract.contract_hash,
    builder_visible: builderVisible,
    restricted,
    generator_role: "independent_acceptance_generator" as const,
    created_at: createdAt,
    ...(input.restricted_boundary
      ? { restricted_boundary: { ...input.restricted_boundary } }
      : {}),
  };
  const bundleHash = sha256Canonical(base);
  return deepFreeze({
    ...base,
    bundle_id: `ab1:${bundleHash.slice(0, 16)}`,
    frozen: true as const,
    bundle_hash: bundleHash,
  });
}

/** Return true only when the restricted oracle has a real capability boundary. */
export function hasIsolatedRestrictedOracle(
  bundle: AcceptanceBundleV1,
): boolean {
  const boundary = bundle.restricted_boundary;
  return Boolean(
    bundle.restricted.length > 0 &&
      boundary?.mode === "isolated" &&
      boundary.storage === "outside_implementor_worktree" &&
      boundary.implementorCanRead === false &&
      boundary.implementorCanWrite === false &&
      boundary.execution === "trusted_runner",
  );
}

/** Project only the view a role is permitted to consume. This is access separation, not secrecy. */
export function viewAcceptanceBundle(
  bundle: AcceptanceBundleV1,
  view: AcceptanceBundleView,
): AcceptanceRequirementV1[] {
  const errors = validateAcceptanceBundleV1(bundle);
  if (errors.length > 0)
    throw new Error(`Invalid acceptance bundle: ${errors.join(", ")}`);
  if (view === "builder") return [...bundle.builder_visible];
  return [...bundle.builder_visible, ...bundle.restricted];
}

export function validateAcceptanceBundleV1(value: unknown): string[] {
  const parsed = AcceptanceBundleV1Schema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => issue.path.join(".") || "$");
  const bundle = parsed.data as unknown as AcceptanceBundleV1;
  const errors: string[] = [];
  const ids = [
    ...requirementIds(bundle.builder_visible),
    ...requirementIds(bundle.restricted),
  ];
  if (new Set(ids).size !== ids.length) errors.push("duplicate_requirement_id");
  if (bundle.restricted.length > 0 && bundle.restricted_boundary) {
    const boundary = bundle.restricted_boundary;
    if (boundary.mode === "isolated" && !hasIsolatedRestrictedOracle(bundle))
      errors.push("restricted_boundary_not_isolated");
  }
  const {
    bundle_id: _bundleId,
    bundle_hash: _bundleHash,
    frozen: _frozen,
    ...base
  } = bundle;
  if (sha256Canonical(bundleBody(base)) !== bundle.bundle_hash)
    errors.push("bundle_hash");
  if (!bundle.bundle_id.startsWith(`ab1:${bundle.bundle_hash.slice(0, 16)}`))
    errors.push("bundle_id");
  return errors;
}

export function serializeAcceptanceBundleV1(
  bundle: AcceptanceBundleV1,
): string {
  const errors = validateAcceptanceBundleV1(bundle);
  if (errors.length > 0)
    throw new Error(`Invalid acceptance bundle: ${errors.join(", ")}`);
  const serialized = `${canonicalJson(bundle)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > ACCEPTANCE_BUNDLE_MAX_BYTES) {
    throw new Error(
      `Acceptance bundle exceeds ${ACCEPTANCE_BUNDLE_MAX_BYTES} bytes.`,
    );
  }
  return serialized;
}
