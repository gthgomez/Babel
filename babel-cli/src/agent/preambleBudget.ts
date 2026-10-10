/**
 * Packet B5: token-budget the chat preamble (instructions + repo map +
 * summaries) against the measured chat context state.
 *
 * Aider-style scaling: the repo-map share is a fraction of the tokens still
 * free in the context window, so it shrinks monotonically as the conversation
 * grows, with a hard floor so orientation never disappears entirely. The whole
 * preamble is capped at a fraction of the window. Pure helpers so unit and
 * property tests cover the budget without spinning ChatEngine.
 */

/** ~4 characters per token (matches chatCompaction.estimateTokens heuristic). */
const CHARS_PER_TOKEN = 4;

/** The whole preamble may consume at most this fraction of the window. */
export const PREAMBLE_WINDOW_SHARE = 0.25;

/** Below this floor the preamble is allowed regardless of window share. */
export const PREAMBLE_HARD_FLOOR_TOKENS = 1_024;

/** The repo map targets this fraction of the still-free context tokens. */
export const MAP_FREE_SHARE = 0.1;

/** Hard floor for the map share (Aider keeps a minimal map when full). */
export const MAP_HARD_FLOOR_TOKENS = 256;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface PreambleBudgetInput {
  /** Measured tokens of the current conversation history (compaction counter). */
  historyTokens: number;
  /** Model context window in tokens (ChatEngineLimits.maxEstimatedTokens). */
  contextWindowTokens: number;
}

export interface PreambleBudget {
  /** Total tokens the preamble (instructions + map + summaries) may occupy. */
  readonly maxPreambleTokens: number;
  /** Tokens the repo map may occupy this turn. */
  readonly maxMapTokens: number;
  /** Fraction of free context tokens the map targeted before clamping. */
  readonly mapFreeShare: number;
  readonly contextWindowTokens: number;
  readonly historyTokens: number;
}

/**
 * Compute the preamble and map budgets for the current chat state.
 *
 * Map share = MAP_FREE_SHARE of (window - history), clamped to
 * [MAP_HARD_FLOOR_TOKENS, maxPreambleTokens]; therefore monotonically
 * non-increasing in historyTokens.
 */
export function computePreambleBudget(input: PreambleBudgetInput): PreambleBudget {
  const contextWindowTokens = Math.max(1, Math.floor(input.contextWindowTokens));
  const historyTokens = Math.max(0, Math.floor(input.historyTokens));
  const maxPreambleTokens = Math.max(
    PREAMBLE_HARD_FLOOR_TOKENS,
    Math.min(contextWindowTokens, Math.ceil(contextWindowTokens * PREAMBLE_WINDOW_SHARE)),
  );
  const freeTokens = Math.max(0, contextWindowTokens - historyTokens);
  const rawMapShare = Math.ceil(freeTokens * MAP_FREE_SHARE);
  const maxMapTokens = Math.min(
    maxPreambleTokens,
    Math.max(MAP_HARD_FLOOR_TOKENS, rawMapShare),
  );
  return {
    maxPreambleTokens,
    maxMapTokens,
    mapFreeShare: MAP_FREE_SHARE,
    contextWindowTokens,
    historyTokens,
  };
}

/**
 * Trim a rendered repo map to a token budget by dropping whole lines from the
 * end (the map is ranked head-first by the PageRank graph). The result is
 * guaranteed to satisfy estimateTextTokens(result) <= maxTokens whenever the
 * first line alone fits.
 */
export function trimRepoMapToBudget(map: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTextTokens(map) <= maxTokens) return map;
  const kept: string[] = [];
  let used = 0;
  for (const line of map.split("\n")) {
    const lineTokens = Math.ceil((line.length + 1) / CHARS_PER_TOKEN);
    if (used + lineTokens > maxTokens) break;
    kept.push(line);
    used += lineTokens;
  }
  return kept.join("\n");
}

export interface EnforcedPreambleBudget {
  /** Instructions (+ summaries) text, passed through unmodified. */
  readonly instructions: string;
  /** Map text trimmed to this turn's map share. */
  readonly map: string;
  /** Budget actually applied (telemetry). */
  readonly budget: PreambleBudget;
  /** Measured total preamble tokens after enforcement. */
  readonly totalPreambleTokens: number;
}

/**
 * Enforce the budget over the whole preamble: the map never pushes the total
 * past `budget.maxPreambleTokens`. Instruction text is never truncated (it
 * carries behavioral contract); the map absorbs the pressure instead.
 */
export function enforcePreambleBudget(
  instructions: string,
  map: string,
  input: PreambleBudgetInput,
): EnforcedPreambleBudget {
  const budget = computePreambleBudget(input);
  const instructionTokens = estimateTextTokens(instructions);
  const mapAllowance = Math.max(
    0,
    Math.min(budget.maxMapTokens, budget.maxPreambleTokens - instructionTokens),
  );
  const trimmedMap = trimRepoMapToBudget(map, mapAllowance);
  return {
    instructions,
    map: trimmedMap,
    budget,
    totalPreambleTokens: instructionTokens + estimateTextTokens(trimmedMap),
  };
}

/**
 * Log-only telemetry (packet B5 task 2: the RuntimeFactV1 union has no generic
 * telemetry payload type, so this lane deliberately does not churn the fact
 * union). Shape mirrors what a future fact payload would carry.
 */
export function describePreambleBudget(
  enforced: EnforcedPreambleBudget,
): Record<string, number | string> {
  return {
    type: "context.preamble.budgeted",
    historyTokens: enforced.budget.historyTokens,
    contextWindowTokens: enforced.budget.contextWindowTokens,
    maxPreambleTokens: enforced.budget.maxPreambleTokens,
    maxMapTokens: enforced.budget.maxMapTokens,
    totalPreambleTokens: enforced.totalPreambleTokens,
  };
}
