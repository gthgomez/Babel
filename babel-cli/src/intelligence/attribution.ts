import type {
  BudgetExhaustionKind,
  FailureAttribution,
  CampaignFailureSignature,
  Retryability,
} from "./types.js";

export type NormalizedFinishReason =
  | "NATURAL_COMPLETION"
  | "OUTPUT_BUDGET_EXHAUSTED"
  | "TOOL_CALL"
  | "CONTENT_FILTER"
  | "PROVIDER_ERROR"
  | "PROTOCOL_ERROR"
  | "INTERRUPTED"
  | "UNKNOWN";

export interface FinishReasonObservation {
  raw: string | null;
  normalized: NormalizedFinishReason;
  budgetKind?: BudgetExhaustionKind;
  attribution: FailureAttribution;
}

/** Attribute a provider finish reason without blaming the model for harness limits. */
export function normalizeBabelFinishReason(input: {
  raw?: string | null;
  configuredOutputBudget?: number | null;
  actualCompletionTokens?: number | null;
  interrupted?: boolean;
  providerError?: boolean;
  protocolError?: boolean;
  toolCall?: boolean;
}): FinishReasonObservation {
  const raw = input.raw ?? null;
  const lower = raw?.toLowerCase() ?? "";
  if (input.interrupted) {
    return {
      raw,
      normalized: "INTERRUPTED",
      attribution: {
        kind: "HARNESS_POLICY_CONSTRAINT",
        evidence: ["execution interrupted"],
      },
    };
  }
  if (input.providerError) {
    return {
      raw,
      normalized: "PROVIDER_ERROR",
      attribution: {
        kind: "PROVIDER_SERVICE_FAILURE",
        evidence: ["provider error"],
      },
    };
  }
  if (input.protocolError) {
    return {
      raw,
      normalized: "PROTOCOL_ERROR",
      attribution: {
        kind: "PROTOCOL_ADAPTER_FAILURE",
        evidence: ["protocol error"],
      },
    };
  }
  if (input.toolCall || lower === "tool_calls" || lower === "function_call") {
    return {
      raw,
      normalized: "TOOL_CALL",
      attribution: {
        kind: "UNKNOWN",
        evidence: ["provider requested a tool call"],
      },
    };
  }
  if (lower === "content_filter" || lower === "safety") {
    return {
      raw,
      normalized: "CONTENT_FILTER",
      attribution: {
        kind: "PROVIDER_CAPABILITY_MISMATCH",
        evidence: [`finish_reason=${raw}`],
      },
    };
  }
  const budgetExhausted =
    (lower === "length" ||
      lower === "max_tokens" ||
      lower === "max_output_tokens") &&
    input.configuredOutputBudget !== null &&
    input.configuredOutputBudget !== undefined &&
    (input.actualCompletionTokens === null ||
      input.actualCompletionTokens === undefined ||
      input.actualCompletionTokens >= input.configuredOutputBudget);
  if (budgetExhausted) {
    return {
      raw,
      normalized: "OUTPUT_BUDGET_EXHAUSTED",
      budgetKind: "HARNESS_OUTPUT_TOKEN_BUDGET_EXHAUSTED",
      attribution: {
        kind: "HARNESS_POLICY_CONSTRAINT",
        subcause: "OUTPUT_BUDGET",
        evidence: [
          `finish_reason=${raw}`,
          `configured_output_budget=${input.configuredOutputBudget}`,
        ],
      },
    };
  }
  if (lower === "stop" || lower === "end_turn" || lower === "completed") {
    return {
      raw,
      normalized: "NATURAL_COMPLETION",
      attribution: { kind: "UNKNOWN", evidence: [`finish_reason=${raw}`] },
    };
  }
  return {
    raw,
    normalized: "UNKNOWN",
    attribution: {
      kind: "UNKNOWN",
      evidence: [raw ? `finish_reason=${raw}` : "finish reason unavailable"],
    },
  };
}

export type NormalizedFailureClass =
  | "INSUFFICIENT_CREDITS"
  | "AUTH_FAILURE"
  | "MODEL_NOT_FOUND"
  | "REQUIRE_PARAMETERS_REJECTED"
  | "INVALID_ENDPOINT"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "TRANSPORT_FAILURE"
  | "PROTOCOL_ERROR"
  | "UNKNOWN";

/** Normalize HTTP/provider failures into operationally distinct classes. */
export function normalizeProviderFailure(input: {
  status?: number;
  message?: string;
  providerErrorCode?: string;
}): { failureClass: NormalizedFailureClass; retryability: Retryability } {
  const message =
    `${input.providerErrorCode ?? ""} ${input.message ?? ""}`.toLowerCase();
  if (
    input.status === 402 ||
    /insufficient.?credit|payment required|quota exceeded/.test(message)
  ) {
    return {
      failureClass: "INSUFFICIENT_CREDITS",
      retryability: "retryable_after_account_change",
    };
  }
  if (
    input.status === 401 ||
    input.status === 403 ||
    /unauthorized|invalid api key|authentication/.test(message)
  ) {
    return {
      failureClass: "AUTH_FAILURE",
      retryability: "retryable_after_account_change",
    };
  }
  if (input.status === 404 || /model not found|unknown model/.test(message)) {
    return {
      failureClass: "MODEL_NOT_FOUND",
      retryability: "retryable_after_configuration_change",
    };
  }
  if (
    /require.?parameters|unsupported parameter|invalid parameter/.test(message)
  ) {
    return {
      failureClass: "REQUIRE_PARAMETERS_REJECTED",
      retryability: "retryable_after_configuration_change",
    };
  }
  if (input.status === 429 || /rate.?limit|too many requests/.test(message)) {
    return {
      failureClass: "RATE_LIMITED",
      retryability: "retryable_after_delay",
    };
  }
  if (input.status !== undefined && input.status >= 500) {
    return {
      failureClass: "SERVER_ERROR",
      retryability: "retryable_after_delay",
    };
  }
  if (/timeout/.test(message))
    return { failureClass: "TIMEOUT", retryability: "retryable_after_delay" };
  if (/network|transport|econnreset|connection/.test(message)) {
    return {
      failureClass: "TRANSPORT_FAILURE",
      retryability: "retryable_after_delay",
    };
  }
  if (/protocol|parse|schema/.test(message))
    return {
      failureClass: "PROTOCOL_ERROR",
      retryability: "retryable_after_configuration_change",
    };
  return { failureClass: "UNKNOWN", retryability: "not_retryable" };
}

/** Build the signature used by a campaign circuit breaker. */
export function buildCampaignFailureSignature(input: {
  provider: string;
  modelProfileHash?: string;
  executionEnvelopeHash?: string;
  status?: number;
  message?: string;
  providerErrorCode?: string;
  configurationRelevant?: boolean;
}): CampaignFailureSignature {
  const normalized = normalizeProviderFailure(input);
  return {
    provider: input.provider,
    ...(input.modelProfileHash === undefined
      ? {}
      : { modelProfileHash: input.modelProfileHash }),
    ...(input.executionEnvelopeHash === undefined
      ? {}
      : { executionEnvelopeHash: input.executionEnvelopeHash }),
    ...(input.status === undefined ? {} : { httpStatus: input.status }),
    normalizedFailureClass: normalized.failureClass,
    ...(input.providerErrorCode === undefined
      ? {}
      : { providerErrorCode: input.providerErrorCode }),
    configurationRelevant:
      input.configurationRelevant ??
      [
        "INSUFFICIENT_CREDITS",
        "AUTH_FAILURE",
        "MODEL_NOT_FOUND",
        "REQUIRE_PARAMETERS_REJECTED",
        "INVALID_ENDPOINT",
        "PROTOCOL_ERROR",
      ].includes(normalized.failureClass),
    retryableWithoutChange:
      normalized.retryability === "retryable_same_request" ||
      normalized.retryability === "retryable_after_delay",
  };
}

/** Map generic local budget signals to the explicit taxonomy used in receipts. */
export function classifyBudgetExhaustion(input: {
  output?: boolean;
  context?: boolean;
  toolTurns?: boolean;
  steps?: boolean;
  wallclock?: boolean;
}): BudgetExhaustionKind {
  if (input.output) return "HARNESS_OUTPUT_TOKEN_BUDGET_EXHAUSTED";
  if (input.context) return "HARNESS_CONTEXT_BUDGET_EXHAUSTED";
  if (input.toolTurns) return "HARNESS_TOOL_TURN_BUDGET_EXHAUSTED";
  if (input.steps) return "HARNESS_STEP_BUDGET_EXHAUSTED";
  if (input.wallclock) return "HARNESS_WALLCLOCK_BUDGET_EXHAUSTED";
  return "BUDGET_EXHAUSTION_UNKNOWN";
}
