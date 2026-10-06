/**
 * context-budget.ts — canonical per-request context budget arithmetic.
 *
 * One arithmetic owner. The contract deliberately never fabricates capacity:
 * an infeasible request is reported as `over_limit` with zero capacity rather
 * than a positive floor. The output reserve is the output actually requested
 * for this turn, never the provider/model catalog maximum.
 *
 * Counts are heuristic token estimates, not exact tokenizer counts; the exact
 * serialized byte identity lives in `preparedProviderRequest.ts`.
 */

export const DEFAULT_REQUEST_OUTPUT_TOKENS = 4_096;
export const DEFAULT_TOOL_SCHEMA_RESERVE = 4_096;
export const DEFAULT_SAFETY_MARGIN = 1_024;

/** Outcome of evaluating one request against a context window. */
export type RequestBudgetStatus = 'fit' | 'over_limit' | 'unknown' | 'invalid';

/** Input for the canonical request budget. */
export interface RequestBudgetInput {
  /**
   * Authoritative context window (prompt + output). `null`, absent or a
   * non-positive value means the ceiling is unknown, not zero capacity.
   */
  readonly contextWindow: number | null | undefined;
  /**
   * Output tokens actually requested for this turn. When omitted, the maximum
   * (when known) is used as a conservative fallback.
   */
  readonly requestedOutputTokens?: number | null;
  /**
   * Provider/model maximum output. Used only to validate the request; it never
   * becomes the output reserve by itself.
   */
  readonly maxOutputTokens?: number | null;
  /** Prompt tokens already counted once (messages + canonical + retrieved). */
  readonly promptTokens?: number;
  /** System + tool/schema reserve. */
  readonly toolSchemaReserve?: number;
  /** Safety margin. */
  readonly safetyMargin?: number;
  /** Reasoning/thinking tokens reserved against the window. */
  readonly reasoningReserveTokens?: number;
}

/** Result of the canonical request budget. All capacity values are nonnegative. */
export interface RequestBudgetResult {
  readonly status: RequestBudgetStatus;
  /** Nonnegative tokens available for prompt/history before overflow. */
  readonly capacityTokens: number;
  /** Output reserve selected for this request; 0 when unknown or invalid. */
  readonly selectedOutputReserve: number;
  /** Positive context window, or null when the ceiling is unknown. */
  readonly contextWindow: number | null;
  readonly promptTokens: number;
  readonly toolSchemaReserve: number;
  readonly safetyMargin: number;
  readonly reasoningReserveTokens: number;
  readonly requestedOutputTokens: number | null;
  readonly maxOutputTokens: number | null;
  /** Tokens over the window (or over capacity); 0 when fit or unknown. */
  readonly overByTokens: number;
  readonly reason?: string;
}

type RequestBudgetCommon = Pick<
  RequestBudgetResult,
  | 'toolSchemaReserve'
  | 'safetyMargin'
  | 'reasoningReserveTokens'
  | 'promptTokens'
  | 'requestedOutputTokens'
  | 'maxOutputTokens'
>;

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function result(
  common: RequestBudgetCommon,
  status: RequestBudgetStatus,
  fields: {
    capacityTokens: number;
    selectedOutputReserve: number;
    contextWindow: number | null;
    overByTokens: number;
    reason?: string;
  },
): RequestBudgetResult {
  return {
    status,
    ...common,
    capacityTokens: fields.capacityTokens,
    selectedOutputReserve: fields.selectedOutputReserve,
    contextWindow: fields.contextWindow,
    overByTokens: fields.overByTokens,
    ...(fields.reason === undefined ? {} : { reason: fields.reason }),
  };
}

/**
 * Compute the nonnegative conversation capacity for one request.
 *
 * `capacity = contextWindow - selectedOutputReserve - toolSchemaReserve -
 * safetyMargin - reasoningReserveTokens`. A negative result is reported as
 * `over_limit` with `capacityTokens: 0`; it is never floored to a positive
 * value. Unknown or contradictory inputs are `unknown`/`invalid` respectively.
 */
export function computeRequestBudget(input: RequestBudgetInput): RequestBudgetResult {
  const toolSchemaReserve = input.toolSchemaReserve ?? DEFAULT_TOOL_SCHEMA_RESERVE;
  const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const reasoningReserveTokens = input.reasoningReserveTokens ?? 0;
  const promptTokens = input.promptTokens ?? 0;
  const requestedRaw = input.requestedOutputTokens;
  const maxRaw = input.maxOutputTokens;

  const common: RequestBudgetCommon = {
    toolSchemaReserve,
    safetyMargin,
    reasoningReserveTokens,
    promptTokens,
    requestedOutputTokens: requestedRaw ?? null,
    maxOutputTokens: maxRaw ?? null,
  };

  const reserves = [toolSchemaReserve, safetyMargin, reasoningReserveTokens, promptTokens];
  if (reserves.some((value) => !isNonNegativeSafeInteger(value))) {
    return result(common, 'invalid', {
      capacityTokens: 0,
      selectedOutputReserve: 0,
      contextWindow: null,
      overByTokens: 0,
      reason: 'Budget reserves and prompt tokens must be non-negative safe integers.',
    });
  }
  if (requestedRaw !== undefined && requestedRaw !== null && !isNonNegativeSafeInteger(requestedRaw)) {
    return result(common, 'invalid', {
      capacityTokens: 0,
      selectedOutputReserve: 0,
      contextWindow: null,
      overByTokens: 0,
      reason: 'requestedOutputTokens must be a non-negative safe integer or null.',
    });
  }
  if (maxRaw !== undefined && maxRaw !== null && !isNonNegativeSafeInteger(maxRaw)) {
    return result(common, 'invalid', {
      capacityTokens: 0,
      selectedOutputReserve: 0,
      contextWindow: null,
      overByTokens: 0,
      reason: 'maxOutputTokens must be a non-negative safe integer or null.',
    });
  }
  if (
    requestedRaw !== undefined &&
    requestedRaw !== null &&
    maxRaw !== undefined &&
    maxRaw !== null &&
    requestedRaw > maxRaw
  ) {
    return result(common, 'invalid', {
      capacityTokens: 0,
      selectedOutputReserve: 0,
      contextWindow: null,
      overByTokens: 0,
      reason: `Requested output ${requestedRaw} exceeds the model/provider maximum ${maxRaw}.`,
    });
  }

  const requestedOutputTokens = requestedRaw ?? null;
  const maxOutputTokens = maxRaw ?? null;
  // Prefer the requested per-turn output; fall back to the catalog maximum only
  // when the request did not state one.
  const outputReserve = requestedOutputTokens ?? maxOutputTokens;

  const contextWindow =
    typeof input.contextWindow === 'number' &&
    Number.isSafeInteger(input.contextWindow) &&
    input.contextWindow > 0
      ? input.contextWindow
      : null;

  if (contextWindow === null) {
    return result(common, 'unknown', {
      capacityTokens: 0,
      selectedOutputReserve: outputReserve ?? 0,
      contextWindow: null,
      overByTokens: 0,
      reason: 'Context window is unknown; capacity cannot be qualified.',
    });
  }
  if (outputReserve === null) {
    return result(common, 'unknown', {
      capacityTokens: 0,
      selectedOutputReserve: 0,
      contextWindow,
      overByTokens: 0,
      reason: 'Output reserve is unknown; capacity cannot be qualified.',
    });
  }

  const capacityRaw =
    contextWindow - outputReserve - toolSchemaReserve - safetyMargin - reasoningReserveTokens;
  if (capacityRaw < 0) {
    return result(common, 'over_limit', {
      capacityTokens: 0,
      selectedOutputReserve: outputReserve,
      contextWindow,
      overByTokens: -capacityRaw,
      reason: `Reserves exceed the ${contextWindow}-token context window by ${-capacityRaw} tokens.`,
    });
  }
  if (promptTokens > capacityRaw) {
    return result(common, 'over_limit', {
      capacityTokens: capacityRaw,
      selectedOutputReserve: outputReserve,
      contextWindow,
      overByTokens: promptTokens - capacityRaw,
      reason: `Prompt of ${promptTokens} tokens exceeds the ${capacityRaw}-token capacity by ${promptTokens - capacityRaw}.`,
    });
  }
  return result(common, 'fit', {
    capacityTokens: capacityRaw,
    selectedOutputReserve: outputReserve,
    contextWindow,
    overByTokens: 0,
  });
}
