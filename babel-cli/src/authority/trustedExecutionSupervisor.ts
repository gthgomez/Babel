import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEndpointV1 } from "../agent/agentEndpoint.js";
import { validateAgentEndpointV1 } from "../agent/agentEndpoint.js";
import type { EvidenceProducerRole } from "../evidence/evidenceGraph.js";
import {
  TRUSTED_EXECUTION_SCHEMA_VERSION,
  TrustedExecutionPersistenceSchemaV1,
  trustedExecutionRecordHash,
  validateTrustedExecutionAssignmentV1,
  type AuthorizeTrustedProducerInputV1,
  type TrustedExecutionAssignmentV1,
  type TrustedExecutionLifecycle,
  type TrustedExecutionPersistenceContextV1,
  type TrustedExecutionReadPortV1,
} from "../evidence/trustedExecutionIdentity.js";
import { createTrustedExecutionReadPortInternal } from "./trustedExecutionPort.js";
import { canonicalJson, sha256Canonical } from "../acceptance/canonical.js";
import type { CapabilityId } from "./capabilities.js";

export interface TrustedExecutionAuthorityV1 {
  readonly read: TrustedExecutionReadPortV1;
  assign(input: {
    run_id: string;
    task_id: string;
    contract_hash: string;
    endpoint: AgentEndpointV1;
    role: EvidenceProducerRole;
    execution_domain?: string;
    assigned_at?: string;
    expires_at?: string;
  }): TrustedExecutionAssignmentV1;
  revoke(runId: string, endpointId: string): void;
  complete(runId: string, endpointId: string): void;
  save(filePath: string): void;
}

function key(runId: string, endpointId: string): string {
  return `${runId}\u0000${endpointId}`;
}
function copy(
  value: TrustedExecutionAssignmentV1,
): TrustedExecutionAssignmentV1 {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
  }) as TrustedExecutionAssignmentV1;
}
function requireText(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Trusted execution ${name} is required.`);
  return value;
}

function transition(
  map: Map<string, TrustedExecutionAssignmentV1>,
  runId: string,
  endpointId: string,
  lifecycle: TrustedExecutionLifecycle,
): void {
  const current = map.get(key(runId, endpointId));
  if (!current) throw new Error("Trusted execution assignment does not exist.");
  if (current.lifecycle !== "active")
    throw new Error(
      `Cannot transition ${current.lifecycle} trusted assignment.`,
    );
  const { record_hash: _recordHash, ...body } = current;
  map.set(
    key(runId, endpointId),
    copy({
      ...body,
      lifecycle,
      record_hash: trustedExecutionRecordHash({ ...body, lifecycle }),
    }),
  );
}

function createAuthority(
  initial: readonly TrustedExecutionAssignmentV1[] = [],
): TrustedExecutionAuthorityV1 {
  const assignments = new Map<string, TrustedExecutionAssignmentV1>();
  for (const assignment of initial)
    assignments.set(
      key(assignment.run_id, assignment.endpoint_id),
      copy(assignment),
    );
  const authorize = (input: AuthorizeTrustedProducerInputV1) => {
    const assignment = assignments.get(key(input.run_id, input.endpoint_id));
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
      Date.parse(assignment.expires_at) <= Date.now()
    )
      return { authorized: false, error: "trusted assignment is expired" };
    if (assignment.task_id !== input.task_id)
      return {
        authorized: false,
        error: "trusted endpoint is assigned to another task",
      };
    if (assignment.contract_hash !== input.contract_hash)
      return {
        authorized: false,
        error: "trusted endpoint is assigned to another contract",
      };
    if (
      assignment.role !== input.role ||
      assignment.execution_domain !== input.execution_domain
    )
      return {
        authorized: false,
        error: "trusted assignment producer binding mismatch",
      };
    if (
      input.required_capability &&
      !assignment.capabilities.includes(input.required_capability)
    )
      return {
        authorized: false,
        error: `trusted endpoint lacks ${input.required_capability}`,
      };
    return { authorized: true, assignment: copy(assignment) };
  };
  const implementation: TrustedExecutionReadPortV1 = {
    authorize,
    get(runId: string, endpointId: string) {
      const value = assignments.get(key(runId, endpointId));
      return value ? copy(value) : undefined;
    },
    assignmentsForRun(runId: string) {
      return [...assignments.values()]
        .filter((value) => value.run_id === runId)
        .map(copy);
    },
  };
  return Object.freeze({
    read: createTrustedExecutionReadPortInternal(implementation, true),
    assign(input: {
      run_id: string;
      task_id: string;
      contract_hash: string;
      endpoint: AgentEndpointV1;
      role: EvidenceProducerRole;
      execution_domain?: string;
      assigned_at?: string;
      expires_at?: string;
    }) {
      requireText(input.run_id, "run_id");
      requireText(input.task_id, "task_id");
      requireText(input.contract_hash, "contract_hash");
      const endpointErrors = validateAgentEndpointV1(input.endpoint);
      if (endpointErrors.length)
        throw new Error(
          `Invalid trusted endpoint: ${endpointErrors.join(", ")}`,
        );
      if ((input.role as string) === "builder")
        throw new Error(
          "A builder cannot be assigned as a certifying producer.",
        );
      const assignedAt = input.assigned_at ?? new Date().toISOString();
      const executionDomain =
        input.execution_domain ?? input.endpoint.execution_domain;
      if (
        input.expires_at &&
        Date.parse(input.expires_at) <= Date.parse(assignedAt)
      )
        throw new Error(
          "Trusted execution expires_at must be after assigned_at.",
        );
      const body = {
        assignment_id: "",
        run_id: input.run_id,
        task_id: input.task_id,
        contract_hash: input.contract_hash,
        endpoint_id: input.endpoint.endpoint_id,
        role: input.role,
        execution_domain: executionDomain,
        capabilities: [...input.endpoint.capabilities] as CapabilityId[],
        assigned_at: assignedAt,
        ...(input.expires_at ? { expires_at: input.expires_at } : {}),
        lifecycle: "active" as const,
        authority_provenance: "supervisor_issued" as const,
      };
      body.assignment_id = sha256Canonical({
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
      const assignment = copy({
        ...body,
        record_hash: trustedExecutionRecordHash(body),
      } as TrustedExecutionAssignmentV1);
      if (assignments.has(key(assignment.run_id, assignment.endpoint_id)))
        throw new Error("Trusted execution assignment already exists.");
      assignments.set(
        key(assignment.run_id, assignment.endpoint_id),
        assignment,
      );
      return copy(assignment);
    },
    revoke(runId: string, endpointId: string) {
      transition(assignments, runId, endpointId, "revoked");
    },
    complete(runId: string, endpointId: string) {
      transition(assignments, runId, endpointId, "completed");
    },
    save(filePath: string) {
      const values = [...assignments.values()].sort((a, b) =>
        a.assignment_id.localeCompare(b.assignment_id),
      );
      for (const value of values) {
        const errors = validateTrustedExecutionAssignmentV1(value);
        if (errors.length)
          throw new Error(
            `Cannot persist invalid trusted execution state: ${errors.join(", ")}`,
          );
      }
      const document = {
        schema_version: TRUSTED_EXECUTION_SCHEMA_VERSION,
        kind: "trusted_execution_assignments_v1" as const,
        assignments: values,
        state_hash: sha256Canonical(values),
      };
      const resolved = path.resolve(filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(temporary, "w");
      try {
        fs.writeFileSync(fd, `${canonicalJson(document)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, resolved);
    },
  });
}

/** Trusted-only authority factory; this module is excluded from the public package exports. */
export function createTrustedExecutionSupervisorV1(): TrustedExecutionAuthorityV1 {
  return createAuthority();
}

/** Restore authoritative state after trusted bootstrap validation. */
export function bootstrapTrustedExecutionSupervisorV1(
  filePath: string,
  context: TrustedExecutionPersistenceContextV1 = {},
): TrustedExecutionAuthorityV1 {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.resolve(filePath), "utf8"),
    ) as unknown;
  } catch (error) {
    throw new Error(
      `Trusted execution state cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = TrustedExecutionPersistenceSchemaV1.safeParse(value);
  if (!parsed.success)
    throw new Error("Trusted execution state schema invalid.");
  const seen = new Set<string>();
  const assignments = parsed.data.assignments.map((assignment) => {
    const trustedAssignment =
      assignment as unknown as TrustedExecutionAssignmentV1;
    const errors = validateTrustedExecutionAssignmentV1(trustedAssignment);
    if (errors.length)
      throw new Error(
        `Trusted execution assignment integrity invalid: ${errors.join(", ")}`,
      );
    const assignmentKey = key(
      trustedAssignment.run_id,
      trustedAssignment.endpoint_id,
    );
    if (!seen.add(assignmentKey))
      throw new Error(
        "Trusted execution state contains a duplicate assignment.",
      );
    if (context.task_id && trustedAssignment.task_id !== context.task_id)
      throw new Error("Trusted execution state is bound to another task.");
    if (context.run_id && trustedAssignment.run_id !== context.run_id)
      throw new Error("Trusted execution state is bound to another run.");
    if (
      context.contract_hash &&
      trustedAssignment.contract_hash !== context.contract_hash
    )
      throw new Error("Trusted execution state is bound to another contract.");
    if (
      trustedAssignment.lifecycle === "active" &&
      trustedAssignment.expires_at &&
      Date.parse(trustedAssignment.expires_at) <= (context.now ?? Date.now())
    )
      throw new Error("Trusted execution state contains expired authority.");
    const allowed = context.allowed_capabilities?.get(
      trustedAssignment.endpoint_id,
    );
    if (
      allowed &&
      trustedAssignment.capabilities.some(
        (capability) => !allowed.includes(capability),
      )
    )
      throw new Error("Trusted execution state widens endpoint capabilities.");
    return copy(trustedAssignment);
  });
  if (parsed.data.state_hash !== sha256Canonical(assignments))
    throw new Error("Trusted execution state hash mismatch.");
  return createAuthority(assignments);
}
