import { z } from "zod";

import {
  isCapabilityId,
  type CapabilityId,
} from "../authority/capabilities.js";

export const AGENT_ENDPOINT_VERSION = 1 as const;

export interface AgentEndpointV1 {
  schema_version: typeof AGENT_ENDPOINT_VERSION;
  endpoint_id: string;
  identity: string;
  harness: string;
  model: string;
  provider: string;
  capabilities: CapabilityId[];
  location: string;
  execution_domain: string;
}

const endpointSchema = z
  .object({
    schema_version: z.literal(AGENT_ENDPOINT_VERSION),
    endpoint_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]{2,127}$/),
    identity: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]{2,127}$/),
    harness: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    capabilities: z.array(z.string().min(1)).min(1),
    location: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    execution_domain: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
  })
  .strict();

function endpointInvariantErrors(endpoint: AgentEndpointV1): string[] {
  const errors: string[] = [];
  if (endpoint.identity !== endpoint.endpoint_id)
    errors.push("identity must match endpoint_id");
  if (new Set(endpoint.capabilities).size !== endpoint.capabilities.length)
    errors.push("capabilities must be unique");
  if (
    endpoint.capabilities.some(
      (capability) => !isCapabilityId(capability) || capability === "unknown",
    )
  )
    errors.push("capabilities");
  return errors;
}

export function buildAgentEndpointV1(
  input: Omit<AgentEndpointV1, "schema_version">,
): AgentEndpointV1 {
  const candidate = {
    schema_version: AGENT_ENDPOINT_VERSION,
    ...input,
    capabilities: [...input.capabilities],
  } as AgentEndpointV1;
  const errors = validateAgentEndpointV1(candidate);
  if (errors.length > 0)
    throw new Error(`Invalid agent endpoint: ${errors.join(", ")}`);
  return candidate;
}

export function endpointHasCapability(
  endpoint: AgentEndpointV1,
  capability: CapabilityId,
): boolean {
  return endpoint.capabilities.includes(capability);
}

export function validateAgentEndpointV1(value: unknown): string[] {
  const parsed = endpointSchema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => issue.path.join(".") || "$");
  const endpoint = parsed.data;
  return endpointInvariantErrors(endpoint as AgentEndpointV1);
}
