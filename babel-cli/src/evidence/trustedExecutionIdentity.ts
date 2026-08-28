import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import type { AgentEndpointV1 } from "../agent/agentEndpoint.js";
import { validateAgentEndpointV1 } from "../agent/agentEndpoint.js";
import {
  isCapabilityId,
  type CapabilityId,
} from "../authority/capabilities.js";
import { canonicalJson, sha256Canonical } from "../acceptance/canonical.js";
import type { EvidenceProducerRole } from "./evidenceGraph.js";

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

export interface TrustedExecutionIssuerV1 extends TrustedExecutionReadPortV1 {
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

export interface TrustedExecutionSupervisorV1 {
  readonly read: TrustedExecutionReadPortV1;
  readonly issuer: TrustedExecutionIssuerV1;
}

export interface TrustedExecutionPersistenceContextV1 {
  task_id?: string;
  run_id?: string;
  contract_hash?: string;
}

export const TRUSTED_EXECUTION_SCHEMA_VERSION = 1 as const;
const INTERNAL_REGISTRY_TOKEN = Symbol("babel.trusted-execution.registry");
const READ_PORT_BRAND = Symbol("babel.trusted-execution.read-port");
const AUTHORITATIVE_READ_PORT_BRAND = Symbol(
  "babel.trusted-execution.authoritative-read-port",
);

const assignmentSchema = z
  .object({
    assignment_id: z.string().regex(/^[0-9a-f]{64}$/),
    run_id: z.string().trim().min(1),
    task_id: z.string().trim().min(1),
    contract_hash: z.string().trim().min(1),
    endpoint_id: z.string().trim().min(1),
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

const persistenceSchema = z
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

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Trusted execution ${name} is required.`);
  }
}

function assertTimestamp(value: string, name: string): void {
  if (!z.string().datetime({ offset: true }).safeParse(value).success) {
    throw new Error(`Trusted execution ${name} must be an ISO timestamp.`);
  }
}

function recordHash(
  assignment: Omit<TrustedExecutionAssignmentV1, "record_hash">,
): string {
  return sha256Canonical(assignment);
}

function freezeAssignment(
  assignment: TrustedExecutionAssignmentV1,
): TrustedExecutionAssignmentV1 {
  return Object.freeze({
    ...assignment,
    capabilities: Object.freeze([...assignment.capabilities]),
  }) as TrustedExecutionAssignmentV1;
}

function cloneAssignment(
  assignment: TrustedExecutionAssignmentV1,
): TrustedExecutionAssignmentV1 {
  return freezeAssignment({
    ...assignment,
    capabilities: [...assignment.capabilities],
  });
}

function validateAssignmentIntegrity(
  assignment: TrustedExecutionAssignmentV1,
): string[] {
  const parsed = assignmentSchema.safeParse(assignment);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => issue.path.join(".") || "$");
  const { record_hash: _recordHash, ...body } = assignment;
  const expectedAssignmentId = sha256Canonical({
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
  if (assignment.assignment_id !== expectedAssignmentId)
    errors.push("assignment_id");
  if (!record_hashMatches(assignment.record_hash, recordHash(body)))
    errors.push("record_hash");
  return errors;
}

function loadedAssignment(
  value: z.infer<typeof assignmentSchema>,
): TrustedExecutionAssignmentV1 {
  if (value.capabilities.some((capability) => !isCapabilityId(capability)))
    throw new Error(
      "Trusted execution assignment contains an unknown capability.",
    );
  const { expires_at, capabilities, ...withoutExpiry } = value;
  if (expires_at === undefined)
    return { ...withoutExpiry, capabilities: capabilities as CapabilityId[] };
  return {
    ...withoutExpiry,
    capabilities: capabilities as CapabilityId[],
    expires_at,
  };
}

function record_hashMatches(actual: string, expected: string): boolean {
  return actual === expected;
}

function persistedStateHash(
  assignments: readonly TrustedExecutionAssignmentV1[],
): string {
  return sha256Canonical(assignments.map(cloneAssignment));
}

function assertPersistenceContext(
  assignment: TrustedExecutionAssignmentV1,
  context: TrustedExecutionPersistenceContextV1,
): void {
  if (context.task_id !== undefined && assignment.task_id !== context.task_id)
    throw new Error("Trusted execution state is bound to another task.");
  if (context.run_id !== undefined && assignment.run_id !== context.run_id)
    throw new Error("Trusted execution state is bound to another run.");
  if (
    context.contract_hash !== undefined &&
    assignment.contract_hash !== context.contract_hash
  )
    throw new Error("Trusted execution state is bound to another contract.");
}

/** Supervisor-owned trusted execution registry. Direct construction is rejected. */
export class TrustedExecutionRegistryV1 implements TrustedExecutionIssuerV1 {
  private readonly assignments = new Map<
    string,
    TrustedExecutionAssignmentV1
  >();

  public constructor(
    token?: symbol,
    initialAssignments: readonly TrustedExecutionAssignmentV1[] = [],
  ) {
    if (token !== INTERNAL_REGISTRY_TOKEN)
      throw new Error(
        "Trusted execution registry construction is supervisor-only.",
      );
    for (const assignment of initialAssignments)
      this.assignments.set(
        assignmentKey(assignment.run_id, assignment.endpoint_id),
        freezeAssignment({
          ...assignment,
          capabilities: [...assignment.capabilities],
        }),
      );
  }

  assign(input: {
    run_id: string;
    task_id: string;
    contract_hash: string;
    endpoint: AgentEndpointV1;
    role: EvidenceProducerRole;
    execution_domain?: string;
    assigned_at?: string;
    expires_at?: string;
  }): TrustedExecutionAssignmentV1 {
    assertNonEmpty(input.run_id, "run_id");
    assertNonEmpty(input.task_id, "task_id");
    assertNonEmpty(input.contract_hash, "contract_hash");
    const endpointErrors = validateAgentEndpointV1(input.endpoint);
    if (endpointErrors.length > 0)
      throw new Error(`Invalid trusted endpoint: ${endpointErrors.join(", ")}`);
    if (input.role === "builder")
      throw new Error("A builder cannot be assigned as a certifying producer.");
    const executionDomain =
      input.execution_domain ?? input.endpoint.execution_domain;
    assertNonEmpty(executionDomain, "execution_domain");
    const assignedAt = input.assigned_at ?? new Date().toISOString();
    assertTimestamp(assignedAt, "assigned_at");
    if (input.expires_at !== undefined) {
      assertTimestamp(input.expires_at, "expires_at");
      if (Date.parse(input.expires_at) <= Date.parse(assignedAt))
        throw new Error(
          "Trusted execution expires_at must be after assigned_at.",
        );
    }
    const body: Omit<TrustedExecutionAssignmentV1, "record_hash"> = {
      assignment_id: "",
      run_id: input.run_id,
      task_id: input.task_id,
      contract_hash: input.contract_hash,
      endpoint_id: input.endpoint.endpoint_id,
      role: input.role,
      execution_domain: executionDomain,
      capabilities: [...input.endpoint.capabilities],
      assigned_at: assignedAt,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
      lifecycle: "active",
      authority_provenance: "supervisor_issued",
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
    const assignment = freezeAssignment({
      ...body,
      record_hash: recordHash(body),
    });
    const key = assignmentKey(assignment.run_id, assignment.endpoint_id);
    if (this.assignments.has(key))
      throw new Error(`Trusted execution assignment already exists: ${key}`);
    this.assignments.set(key, assignment);
    return cloneAssignment(assignment);
  }

  get(
    runId: string,
    endpointId: string,
  ): TrustedExecutionAssignmentV1 | undefined {
    const assignment = this.assignments.get(assignmentKey(runId, endpointId));
    return assignment ? cloneAssignment(assignment) : undefined;
  }

  authorize(input: AuthorizeTrustedProducerInputV1): {
    authorized: boolean;
    error?: string;
    assignment?: TrustedExecutionAssignmentV1;
  } {
    const assignment = this.assignments.get(
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
    if (assignment.role !== input.role)
      return {
        authorized: false,
        error: "producer role does not match trusted assignment",
      };
    if (assignment.execution_domain !== input.execution_domain)
      return {
        authorized: false,
        error: "execution domain does not match trusted assignment",
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
  }

  assignmentsForRun(runId: string): TrustedExecutionAssignmentV1[] {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.run_id === runId)
      .map(cloneAssignment);
  }

  revoke(runId: string, endpointId: string): void {
    this.transition(runId, endpointId, "revoked");
  }
  complete(runId: string, endpointId: string): void {
    this.transition(runId, endpointId, "completed");
  }

  private transition(
    runId: string,
    endpointId: string,
    lifecycle: TrustedExecutionLifecycle,
  ): void {
    const existing = this.assignments.get(assignmentKey(runId, endpointId));
    if (!existing)
      throw new Error("Trusted execution assignment does not exist.");
    if (existing.lifecycle !== "active")
      throw new Error(
        `Cannot transition ${existing.lifecycle} trusted assignment.`,
      );
    const { record_hash: _recordHash, ...body } = existing;
    this.assignments.set(
      assignmentKey(runId, endpointId),
      freezeAssignment({
        ...body,
        lifecycle,
        record_hash: recordHash({ ...body, lifecycle }),
      }),
    );
  }

  save(filePath: string): void {
    const assignments = [...this.assignments.values()].sort((a, b) =>
      a.assignment_id.localeCompare(b.assignment_id),
    );
    for (const assignment of assignments) {
      const errors = validateAssignmentIntegrity(assignment);
      if (errors.length > 0)
        throw new Error(
          `Cannot persist invalid trusted execution state: ${errors.join(", ")}`,
        );
    }
    const document = {
      schema_version: TRUSTED_EXECUTION_SCHEMA_VERSION,
      kind: "trusted_execution_assignments_v1" as const,
      assignments,
      state_hash: persistedStateHash(assignments),
    };
    const serialized = `${canonicalJson(document)}\n`;
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(fd, serialized, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, resolved);
  }
}

function createReadPort(
  registry: TrustedExecutionRegistryV1,
  authoritative = false,
): TrustedExecutionReadPortV1 {
  const port = {
    [READ_PORT_BRAND]: true,
    ...(authoritative ? { [AUTHORITATIVE_READ_PORT_BRAND]: true } : {}),
    authorize: registry.authorize.bind(registry),
    get: registry.get.bind(registry),
    assignmentsForRun: registry.assignmentsForRun.bind(registry),
  };
  return Object.freeze(port) as TrustedExecutionReadPortV1;
}

/** Create supervisor-owned issuance and the narrow read-only consumer port. */
export function createTrustedExecutionSupervisorV1(): TrustedExecutionSupervisorV1 {
  const registry = new TrustedExecutionRegistryV1(INTERNAL_REGISTRY_TOKEN);
  return Object.freeze({ read: createReadPort(registry), issuer: registry });
}

// The authoritative read port is created once inside this module. Factory
// supervisors remain useful for isolated unit tests and persistence tooling,
// but their ports are deliberately not accepted by the completion gate.
const authoritativeRegistry = new TrustedExecutionRegistryV1(
  INTERNAL_REGISTRY_TOKEN,
);
const authoritativeReadPort = createReadPort(authoritativeRegistry, true);

/** Read-only dependency for the authoritative completion path. */
export function getAuthoritativeTrustedExecutionReadPortV1(): TrustedExecutionReadPortV1 {
  return authoritativeReadPort;
}

/** Issuance surface for trusted orchestration code; builders receive only the read port. */
export function getAuthoritativeTrustedExecutionIssuerV1(): TrustedExecutionIssuerV1 {
  return authoritativeRegistry;
}

/** Reject copied resolver objects at the completion boundary. */
export function isTrustedExecutionReadPort(
  value: unknown,
): value is TrustedExecutionReadPortV1 {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[READ_PORT_BRAND] === true &&
    (value as Record<PropertyKey, unknown>)[AUTHORITATIVE_READ_PORT_BRAND] ===
      true,
  );
}

/** Reload a persisted supervisor state; malformed or incompatible state throws. */
export function loadTrustedExecutionSupervisorV1(
  filePath: string,
  context: TrustedExecutionPersistenceContextV1 = {},
): TrustedExecutionSupervisorV1 {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new Error(
      `Trusted execution state cannot be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = persistenceSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Trusted execution state schema invalid: ${parsed.error.issues.map((issue) => issue.path.join(".") || "$").join(", ")}`,
    );
  const seen = new Set<string>();
  const assignments = parsed.data.assignments.map(loadedAssignment);
  const registry = new TrustedExecutionRegistryV1(
    INTERNAL_REGISTRY_TOKEN,
    assignments,
  );
  const supervisor = Object.freeze({
    read: createReadPort(registry),
    issuer: registry,
  });
  for (const assignment of assignments) {
    const key = assignmentKey(assignment.run_id, assignment.endpoint_id);
    if (seen.has(key))
      throw new Error(
        "Trusted execution state contains a duplicate assignment.",
      );
    seen.add(key);
    const errors = validateAssignmentIntegrity(assignment);
    if (errors.length > 0)
      throw new Error(
        `Trusted execution assignment integrity invalid: ${errors.join(", ")}`,
      );
    assertPersistenceContext(assignment, context);
  }
  if (parsed.data.state_hash !== persistedStateHash(assignments))
    throw new Error("Trusted execution state hash mismatch.");
  return supervisor;
}

export function requiredCapabilityForAcceptanceType(
  type: string,
): CapabilityId | undefined {
  const capability: CapabilityId | undefined =
    type === "build"
      ? "run_build"
      : type === "lint"
        ? "run_lint"
        : type === "typecheck"
          ? "run_typecheck"
          : type === "security" || type === "policy"
            ? "run_local_command"
            : type === "unit_test" ||
                type === "integration_test" ||
                type === "e2e"
              ? "run_tests"
              : type === "runtime"
                ? "inspect_external_device"
                : type === "custom"
                  ? "run_local_command"
                  : undefined;
  return capability && isCapabilityId(capability) ? capability : undefined;
}
