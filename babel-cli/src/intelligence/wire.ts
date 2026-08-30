import { hashCanonical } from "./hash.js";
import type { ProviderMessage, ToolDefinition } from "../runners/base.js";
import type { ResolvedExecutionEnvelope } from "./types.js";

export interface WireRequestOptions {
  messages: ProviderMessage[];
  stream: boolean;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "specific";
}

/** The provider-neutral request body generated only from a resolved envelope. */
export interface WireRequest {
  model: string;
  stream: boolean;
  messages: unknown[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  reasoning_effort?: string;
  tools?: ToolDefinition[];
  tool_choice?: string;
  response_format?: Record<string, unknown>;
  provider?: {
    allow_fallbacks: boolean;
    require_parameters: boolean;
    order?: readonly string[];
  };
}

function toWireMessage(message: ProviderMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_call_id === undefined
      ? {}
      : { tool_call_id: message.tool_call_id }),
    ...(message.tool_calls === undefined
      ? {}
      : { tool_calls: message.tool_calls }),
    ...(message.name === undefined ? {} : { name: message.name }),
  };
}

/** Serialize routing, generation, tool, and structured-output policy exactly once. */
export function buildWireRequestFromEnvelope(
  envelope: ResolvedExecutionEnvelope,
  options: WireRequestOptions,
): WireRequest {
  if (envelope.configurationHash.length === 0) {
    throw new Error(
      "Cannot serialize an execution envelope without a configuration hash.",
    );
  }
  const output = envelope.output.effective;
  const request: WireRequest = {
    model: envelope.model.resolved,
    stream: options.stream,
    messages: options.messages.map(toWireMessage),
    ...(output === null || output === undefined ? {} : { max_tokens: output }),
  };
  if (
    envelope.reasoning.effectiveEffort &&
    envelope.reasoning.wireParameter === "reasoning_effort"
  ) {
    request.reasoning_effort = envelope.reasoning.effectiveEffort;
  }
  if (envelope.sampling.temperature?.effective !== undefined) {
    request.temperature = envelope.sampling.temperature.effective;
  }
  if (envelope.sampling.topP?.effective !== undefined) {
    request.top_p = envelope.sampling.topP.effective;
  }
  if (envelope.sampling.seed?.effective !== undefined) {
    request.seed = envelope.sampling.seed.effective;
  }
  if (envelope.tools.effective && options.tools) {
    request.tools = options.tools;
    request.tool_choice = options.toolChoice ?? envelope.tools.choice ?? "auto";
  }
  if (envelope.structuredOutput.mode === "json_object") {
    request.response_format = { type: "json_object" };
  } else if (envelope.structuredOutput.mode === "json_schema") {
    request.response_format = {
      type: "json_schema",
      ...(envelope.structuredOutput.schema === undefined
        ? {}
        : { schema: envelope.structuredOutput.schema }),
      ...(envelope.structuredOutput.strict ? { strict: true } : {}),
    };
  }
  if (envelope.provider.gateway === "openrouter") {
    request.provider = {
      allow_fallbacks: envelope.routing.allowFallbacks,
      require_parameters: envelope.routing.requireParameters,
      ...(envelope.routing.order.length > 0
        ? { order: envelope.routing.order }
        : {}),
    };
  }
  return request;
}

/** Assert that an intercepted wire body still matches the resolved policy. */
export function assertWireRequestMatchesEnvelope(
  request: Record<string, unknown>,
  envelope: ResolvedExecutionEnvelope,
): void {
  if (request.model !== envelope.model.resolved) {
    throw new Error(
      `Wire model ${String(request.model)} does not match ${envelope.model.resolved}.`,
    );
  }
  const expectedOutput = envelope.output.effective;
  if (expectedOutput === null || expectedOutput === undefined) {
    if ("max_tokens" in request || "max_completion_tokens" in request) {
      throw new Error(
        "Wire request introduced an output default that the envelope omitted.",
      );
    }
  } else if (
    request.max_tokens !== expectedOutput &&
    request.max_completion_tokens !== expectedOutput
  ) {
    throw new Error(
      `Wire output budget does not match envelope value ${expectedOutput}.`,
    );
  }
  if (
    envelope.reasoning.effectiveEffort &&
    envelope.reasoning.wireParameter === "reasoning_effort"
  ) {
    if (request.reasoning_effort !== envelope.reasoning.effectiveEffort) {
      throw new Error(
        "Wire reasoning effort does not match the resolved envelope.",
      );
    }
  }
  const samplingFields: Array<[string, number | undefined]> = [
    ["temperature", envelope.sampling.temperature?.effective],
    ["top_p", envelope.sampling.topP?.effective],
    ["seed", envelope.sampling.seed?.effective],
  ];
  for (const [field, expected] of samplingFields) {
    if (expected === undefined) {
      if (field in request)
        throw new Error(
          `Wire request introduced unsupported sampling default ${field}.`,
        );
    } else if (request[field] !== expected) {
      throw new Error(`Wire ${field} does not match the resolved envelope.`);
    }
  }
  if (envelope.provider.gateway === "openrouter") {
    const provider = request.provider as Record<string, unknown> | undefined;
    if (!provider)
      throw new Error(
        "OpenRouter wire request is missing provider routing policy.",
      );
    if (provider.allow_fallbacks !== envelope.routing.allowFallbacks) {
      throw new Error(
        "Wire fallback policy does not match the resolved envelope.",
      );
    }
    if (provider.require_parameters !== envelope.routing.requireParameters) {
      throw new Error(
        "Wire require_parameters policy does not match the resolved envelope.",
      );
    }
  }
}

/** Hash the sanitized wire policy for receipts without retaining request content. */
export function hashWirePolicy(request: WireRequest): string {
  return hashCanonical({
    ...request,
    messages: request.messages.map((message) => ({
      role: (message as { role: string }).role,
    })),
  });
}
