import { z } from "zod";

import {
  isCapabilityId,
  type CapabilityId,
} from "../authority/capabilities.js";
import {
  assertDurableValueSafe,
  sanitizeDurableString,
} from "../utils/redaction.js";

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
    endpoint_id: z.string().min(1),
    identity: z.string().min(1),
    harness: z.string().min(1),
    model: z.string().min(1),
    provider: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
    location: z.string().min(1),
    execution_domain: z.string().min(1),
  })
  .strict();

export function buildAgentEndpointV1(
  input: Omit<AgentEndpointV1, "schema_version">,
): AgentEndpointV1 {
  const unknown = input.capabilities.filter(
    (capability) => !isCapabilityId(capability),
  );
  if (unknown.length > 0 || input.capabilities.includes("unknown")) {
    throw new Error(
      `Agent endpoint has invalid capabilities: ${unknown.join(", ") || "unknown"}`,
    );
  }
  return {
    schema_version: AGENT_ENDPOINT_VERSION,
    endpoint_id: sanitizeDurableString(input.endpoint_id, "endpoint_id"),
    identity: sanitizeDurableString(input.identity, "identity"),
    harness: sanitizeDurableString(input.harness, "harness"),
    model: sanitizeDurableString(input.model, "model"),
    provider: sanitizeDurableString(input.provider, "provider"),
    capabilities: [...input.capabilities],
    location: sanitizeDurableString(input.location, "location"),
    execution_domain: sanitizeDurableString(
      input.execution_domain,
      "execution_domain",
    ),
  };
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
  const errors: string[] = [];
  try {
    assertDurableValueSafe(endpoint, "agent_endpoint");
  } catch {
    errors.push("durable_secret");
  }
  if (
    endpoint.capabilities.some(
      (capability) => !isCapabilityId(capability) || capability === "unknown",
    )
  )
    errors.push("capabilities");
  return errors;
}
