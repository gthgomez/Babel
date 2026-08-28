import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import type { EvidenceProducerRole } from "./evidenceGraph.js";
import { sha256Canonical } from "../acceptance/canonical.js";
import {
  isCapabilityId,
  type CapabilityId,
} from "../authority/capabilities.js";
export { isTrustedExecutionReadPort } from "../authority/trustedExecutionPort.js";

export type TrustedExecutionLifecycle =
  | "active"
  | "revoked"
  | "expired"
  | "completed";

export interface TrustedExecutionAssignmentV1 {
  assignment_id: string;
  run_id: string;
  task_id: string;
  contract_hash: string;
  endpoint_id: string;
  role: EvidenceProducerRole;
  execution_domain: string;
  capabilities: CapabilityId[];
  assigned_at: string;
  expires_at?: string;
  lifecycle: TrustedExecutionLifecycle;
  authority_provenance: "supervisor_issued";
  record_hash: string;
}

export interface AuthorizeTrustedProducerInputV1 {
  run_id: string;
  task_id: string;
  contract_hash: string;
  endpoint_id: string;
  role: EvidenceProducerRole;
  execution_domain: string;
  required_capability?: CapabilityId;
}

export interface TrustedExecutionReadPortV1 {
  authorize(input: AuthorizeTrustedProducerInputV1): {
    authorized: boolean;
    error?: string;
    assignment?: TrustedExecutionAssignmentV1;
  };
  get(
    runId: string,
    endpointId: string,
  ): TrustedExecutionAssignmentV1 | undefined;
  assignmentsForRun(runId: string): TrustedExecutionAssignmentV1[];
}

export interface TrustedExecutionPersistenceContextV1 {
  task_id?: string;
  run_id?: string;
  contract_hash?: string;
  allowed_capabilities?: ReadonlyMap<string, readonly CapabilityId[]>;
  now?: number;
}

export const TRUSTED_EXECUTION_SCHEMA_VERSION = 1 as const;
const assignmentSchema = z
  .object({
    assignment_id: z.string().regex(/^[0-9a-f]{64}$/),
    run_id: z.string().trim().min(1),
    task_id: z.string().trim().min(1),
    contract_hash: z.string().trim().min(1),
    endpoint_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]{2,127}$/),
    role: z.enum([
      "builder",
      "reviewer",
      "breaker",
      "verifier",
      "observer",
      "system",
    ]),
    execution_domain: z.string().trim().min(1),
    capabilities: z.array(z.string().min(1)).min(1),
    assigned_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }).optional(),
    lifecycle: z.enum(["active", "revoked", "expired", "completed"]),
    authority_provenance: z.literal("supervisor_issued"),
    record_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const TrustedExecutionPersistenceSchemaV1 = z
  .object({
    schema_version: z.literal(TRUSTED_EXECUTION_SCHEMA_VERSION),
    kind: z.literal("trusted_execution_assignments_v1"),
    assignments: z.array(assignmentSchema),
    state_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

function assignmentKey(runId: string, endpointId: string): string {
  return `${runId}\u0000${endpointId}`;
}

function cloneAssignment(
  value: TrustedExecutionAssignmentV1,
): TrustedExecutionAssignmentV1 {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
  }) as TrustedExecutionAssignmentV1;
}

function stateHash(
  assignments: readonly TrustedExecutionAssignmentV1[],
): string {
  return sha256Canonical(assignments.map(cloneAssignment));
}

export function trustedExecutionRecordHash(
  value: Omit<TrustedExecutionAssignmentV1, "record_hash">,
): string {
  return sha256Canonical(value);
}

export function validateTrustedExecutionAssignmentV1(value: unknown): string[] {
  const parsed = assignmentSchema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => issue.path.join(".") || "$");
  const assignment = parsed.data as unknown as TrustedExecutionAssignmentV1;
  if (assignment.capabilities.some((capability) => !isCapabilityId(capability)))
    return ["capabilities"];
  const { record_hash: _recordHash, ...body } = assignment;
  const expectedId = sha256Canonical({
    run_id: body.run_id,
    task_id: body.task_id,
    contract_hash: body.contract_hash,
    endpoint_id: body.endpoint_id,
    role: body.role,
    execution_domain: body.execution_domain,
    capabilities: body.capabilities,
    assigned_at: body.assigned_at,
    ...(body.expires_at ? { expires_at: body.expires_at } : {}),
  });
  const errors: string[] = [];
  if (assignment.assignment_id !== expectedId) errors.push("assignment_id");
  if (assignment.record_hash !== trustedExecutionRecordHash(body))
    errors.push("record_hash");
  return errors;
}

/** Parse persisted state for untrusted inspection; this can never create an authoritative port. */
export function loadTrustedExecutionSupervisorV1(
  filePath: string,
  context: TrustedExecutionPersistenceContextV1 = {},
): TrustedExecutionReadPortV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(
      fs.readFileSync(path.resolve(filePath), "utf8"),
    ) as unknown;
  } catch (error) {
    throw new Error(
      `Trusted execution state cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = TrustedExecutionPersistenceSchemaV1.safeParse(raw);
  if (!parsed.success)
    throw new Error("Trusted execution state schema invalid.");
  const seen = new Set<string>();
  const assignments = parsed.data.assignments.map((assignment) => {
    const errors = validateTrustedExecutionAssignmentV1(assignment);
    if (errors.length)
      throw new Error(
        `Trusted execution assignment integrity invalid: ${errors.join(", ")}`,
      );
    const assignmentKeyValue = assignmentKey(
      assignment.run_id,
      assignment.endpoint_id,
    );
    if (!seen.add(assignmentKeyValue))
      throw new Error(
        "Trusted execution state contains a duplicate assignment.",
      );
    if (context.task_id && assignment.task_id !== context.task_id)
      throw new Error("Trusted execution state is bound to another task.");
    if (context.run_id && assignment.run_id !== context.run_id)
      throw new Error("Trusted execution state is bound to another run.");
    if (
      context.contract_hash &&
      assignment.contract_hash !== context.contract_hash
    )
      throw new Error("Trusted execution state is bound to another contract.");
    return cloneAssignment(
      assignment as unknown as TrustedExecutionAssignmentV1,
    );
  });
  if (parsed.data.state_hash !== stateHash(assignments))
    throw new Error("Trusted execution state hash mismatch.");
  const map = new Map(
    assignments.map((assignment) => [
      assignmentKey(assignment.run_id, assignment.endpoint_id),
      assignment,
    ]),
  );
  return Object.freeze({
    authorize(input: AuthorizeTrustedProducerInputV1) {
      const assignment = map.get(
        assignmentKey(input.run_id, input.endpoint_id),
      );
      if (!assignment)
        return {
          authorized: false,
          error: "endpoint is not trusted for this run",
        };
      if (assignment.lifecycle !== "active")
        return {
          authorized: false,
          error: `trusted assignment is ${assignment.lifecycle}`,
        };
      if (
        assignment.expires_at &&
        Date.parse(assignment.expires_at) <= (context.now ?? Date.now())
      )
        return { authorized: false, error: "trusted assignment is expired" };
      if (
        assignment.task_id !== input.task_id ||
        assignment.contract_hash !== input.contract_hash ||
        assignment.role !== input.role ||
        assignment.execution_domain !== input.execution_domain
      )
        return {
          authorized: false,
          error: "trusted assignment binding mismatch",
        };
      if (
        input.required_capability &&
        !assignment.capabilities.includes(input.required_capability)
      )
        return {
          authorized: false,
          error: `trusted endpoint lacks ${input.required_capability}`,
        };
      return { authorized: true, assignment: cloneAssignment(assignment) };
    },
    get(runId: string, endpointId: string) {
      const assignment = map.get(assignmentKey(runId, endpointId));
      return assignment ? cloneAssignment(assignment) : undefined;
    },
    assignmentsForRun(runId: string) {
      return assignments
        .filter((assignment) => assignment.run_id === runId)
        .map(cloneAssignment);
    },
  });
}

export function requiredCapabilityForAcceptanceType(
  type: string,
): CapabilityId | undefined {
  const capability =
    type === "build"
      ? "run_build"
      : type === "lint"
        ? "run_lint"
        : type === "typecheck"
          ? "run_typecheck"
          : type === "security" || type === "policy" || type === "custom"
            ? "run_local_command"
            : type === "unit_test" ||
                type === "integration_test" ||
                type === "e2e"
              ? "run_tests"
              : type === "runtime"
                ? "inspect_external_device"
                : undefined;
  return capability && isCapabilityId(capability) ? capability : undefined;
}
