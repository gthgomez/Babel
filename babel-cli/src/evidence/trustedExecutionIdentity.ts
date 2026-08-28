import type { AgentEndpointV1 } from "../agent/agentEndpoint.js";
import { validateAgentEndpointV1 } from "../agent/agentEndpoint.js";
import {
  isCapabilityId,
  type CapabilityId,
} from "../authority/capabilities.js";
import type { EvidenceProducerRole } from "./evidenceGraph.js";

export interface TrustedExecutionAssignmentV1 {
  run_id: string;
  task_id: string;
  contract_hash: string;
  endpoint_id: string;
  role: EvidenceProducerRole;
  execution_domain: string;
  capabilities: CapabilityId[];
  assigned_at: string;
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

function assignmentKey(runId: string, endpointId: string): string {
  return `${runId}\u0000${endpointId}`;
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Trusted execution ${name} is required.`);
  }
}

function freezeAssignment(
  assignment: TrustedExecutionAssignmentV1,
): TrustedExecutionAssignmentV1 {
  return Object.freeze({
    ...assignment,
    capabilities: Object.freeze([...assignment.capabilities]),
  }) as TrustedExecutionAssignmentV1;
}

/**
 * Orchestrator-owned execution identity state. Evidence may reference an
 * assignment, but it cannot create or alter one by supplying identity fields.
 */
export class TrustedExecutionRegistryV1 {
  private readonly assignments = new Map<
    string,
    TrustedExecutionAssignmentV1
  >();

  assign(input: {
    run_id: string;
    task_id: string;
    contract_hash: string;
    endpoint: AgentEndpointV1;
    role: EvidenceProducerRole;
    execution_domain?: string;
    assigned_at?: string;
  }): TrustedExecutionAssignmentV1 {
    assertNonEmpty(input.run_id, "run_id");
    assertNonEmpty(input.task_id, "task_id");
    assertNonEmpty(input.contract_hash, "contract_hash");
    const endpointErrors = validateAgentEndpointV1(input.endpoint);
    if (endpointErrors.length > 0) {
      throw new Error(`Invalid trusted endpoint: ${endpointErrors.join(", ")}`);
    }
    if (input.role === "builder") {
      throw new Error("A builder cannot be assigned as a certifying producer.");
    }
    const executionDomain =
      input.execution_domain ?? input.endpoint.execution_domain;
    assertNonEmpty(executionDomain, "execution_domain");
    const assignment: TrustedExecutionAssignmentV1 = {
      run_id: input.run_id,
      task_id: input.task_id,
      contract_hash: input.contract_hash,
      endpoint_id: input.endpoint.endpoint_id,
      role: input.role,
      execution_domain: executionDomain,
      capabilities: [...input.endpoint.capabilities],
      assigned_at: input.assigned_at ?? new Date().toISOString(),
    };
    const key = assignmentKey(assignment.run_id, assignment.endpoint_id);
    if (this.assignments.has(key)) {
      throw new Error(`Trusted execution assignment already exists: ${key}`);
    }
    const frozen = freezeAssignment(assignment);
    this.assignments.set(key, frozen);
    return frozen;
  }

  get(
    runId: string,
    endpointId: string,
  ): TrustedExecutionAssignmentV1 | undefined {
    return this.assignments.get(assignmentKey(runId, endpointId));
  }

  authorize(input: AuthorizeTrustedProducerInputV1): {
    authorized: boolean;
    error?: string;
    assignment?: TrustedExecutionAssignmentV1;
  } {
    const assignment = this.get(input.run_id, input.endpoint_id);
    if (!assignment) {
      return {
        authorized: false,
        error: "endpoint is not trusted for this run",
      };
    }
    if (assignment.task_id !== input.task_id) {
      return {
        authorized: false,
        error: "trusted endpoint is assigned to another task",
      };
    }
    if (assignment.contract_hash !== input.contract_hash) {
      return {
        authorized: false,
        error: "trusted endpoint is assigned to another contract",
      };
    }
    if (assignment.role !== input.role) {
      return {
        authorized: false,
        error: "producer role does not match trusted assignment",
      };
    }
    if (assignment.execution_domain !== input.execution_domain) {
      return {
        authorized: false,
        error: "execution domain does not match trusted assignment",
      };
    }
    if (
      input.required_capability &&
      !assignment.capabilities.includes(input.required_capability)
    ) {
      return {
        authorized: false,
        error: `trusted endpoint lacks ${input.required_capability}`,
      };
    }
    return { authorized: true, assignment };
  }

  assignmentsForRun(runId: string): TrustedExecutionAssignmentV1[] {
    return [...this.assignments.values()]
      .filter((assignment) => assignment.run_id === runId)
      .map((assignment) => freezeAssignment({ ...assignment }));
  }
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
