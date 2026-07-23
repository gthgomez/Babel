/**
 * P1-E — Provider capability truth, context budget, failover helpers.
 *
 * One ProviderCapabilities record per model. Budget formula:
 *   context_budget = context_window - max_output - tool/schema_reserve - safety_margin
 */

import type { ProviderCapabilities } from '../runners/base.js';
import { getModelContextWindow } from '../modelPolicy.js';

export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_TOOL_SCHEMA_RESERVE = 4_096;
export const DEFAULT_SAFETY_MARGIN = 1_024;

export interface ContextBudgetInput {
  contextWindow: number;
  maxOutputTokens?: number;
  toolSchemaReserve?: number;
  safetyMargin?: number;
}

export interface ContextBudget {
  contextWindow: number;
  maxOutputTokens: number;
  toolSchemaReserve: number;
  safetyMargin: number;
  /** Tokens available for conversation/history before compaction. */
  contextBudget: number;
}

/**
 * Canonical budget formula (P1-E).
 * Never returns negative; floors at 1_024 for pathological configs.
 */
export function computeContextBudget(input: ContextBudgetInput): ContextBudget {
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const toolSchemaReserve = input.toolSchemaReserve ?? DEFAULT_TOOL_SCHEMA_RESERVE;
  const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const raw =
    input.contextWindow - maxOutputTokens - toolSchemaReserve - safetyMargin;
  const contextBudget = Math.max(1_024, raw);
  return {
    contextWindow: input.contextWindow,
    maxOutputTokens,
    toolSchemaReserve,
    safetyMargin,
    contextBudget,
  };
}

/** Built-in capability defaults when policy lacks detail. */
const CAPABILITY_DEFAULTS: Record<string, Partial<ProviderCapabilities>> = {
  deepseek: {
    maxOutputTokens: 8_192,
    supportsThinking: true,
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
    supportsStreaming: true,
    thinkingWithTools: 'unsupported',
  },
  deepinfra: {
    maxOutputTokens: 8_192,
    supportsThinking: false,
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
    supportsStreaming: true,
    thinkingWithTools: 'unsupported',
  },
  ollama: {
    maxOutputTokens: 4_096,
    supportsThinking: false,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
    supportsStreaming: true,
    thinkingWithTools: 'unsupported',
  },
};

function inferProvider(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('ollama') || m.includes(':')) return 'ollama';
  if (m.includes('qwen') || m.includes('llama') || m.includes('deepinfra')) {
    return 'deepinfra';
  }
  return 'unknown';
}

/**
 * Resolve one ProviderCapabilities record for a model.
 * Uses model-policy context_window only (never conflicting context_limit).
 */
export function resolveProviderCapabilities(
  modelId: string,
  overrides?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  const provider = inferProvider(modelId);
  const defaults = CAPABILITY_DEFAULTS[provider] ?? {
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    supportsThinking: false,
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
    supportsStreaming: true,
    thinkingWithTools: 'unknown' as const,
  };

  // Canonical window from policy; fallback 128k for DeepSeek-class, 200k else.
  const fromPolicy = getModelContextWindow(modelId);
  const contextWindow =
    fromPolicy ??
    (provider === 'deepseek' ? 128_000 : 200_000);

  const base: ProviderCapabilities = {
    contextWindow,
    maxOutputTokens: defaults.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    supportsThinking: defaults.supportsThinking ?? false,
    supportsToolChoice: defaults.supportsToolChoice ?? true,
    supportsParallelToolCalls: defaults.supportsParallelToolCalls ?? true,
    supportsStreaming: defaults.supportsStreaming ?? true,
    thinkingWithTools: defaults.thinkingWithTools ?? 'unknown',
  };

  return { ...base, ...overrides, contextWindow: overrides?.contextWindow ?? base.contextWindow };
}

export function contextBudgetForModel(modelId: string): ContextBudget {
  const caps = resolveProviderCapabilities(modelId);
  return computeContextBudget({
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
  });
}

/**
 * Compaction should trigger when estimated request tokens exceed the budget,
 * not only on message count.
 */
export function shouldCompactByTokens(
  estimatedRequestTokens: number,
  modelId: string,
): boolean {
  const budget = contextBudgetForModel(modelId);
  return estimatedRequestTokens >= budget.contextBudget;
}

export interface CompactionCapsule {
  task: string;
  progressSummary: string;
  patchSummary: string;
  verifierSummary: string;
  approvalsSummary: string;
  recentToolResults: string[];
  createdAt: string;
}

export function buildCompactionCapsule(input: {
  task: string;
  progressSummary?: string;
  patchSummary?: string;
  verifierSummary?: string;
  approvalsSummary?: string;
  recentToolResults?: string[];
}): CompactionCapsule {
  return {
    task: input.task,
    progressSummary: input.progressSummary ?? '',
    patchSummary: input.patchSummary ?? '',
    verifierSummary: input.verifierSummary ?? '',
    approvalsSummary: input.approvalsSummary ?? '',
    recentToolResults: (input.recentToolResults ?? []).slice(-8),
    createdAt: new Date().toISOString(),
  };
}

export function formatCompactionCapsule(capsule: CompactionCapsule): string {
  const parts = [
    '# Compaction capsule (state preserved)',
    `Task: ${capsule.task}`,
    capsule.progressSummary ? `Progress: ${capsule.progressSummary}` : null,
    capsule.patchSummary ? `Patch: ${capsule.patchSummary}` : null,
    capsule.verifierSummary ? `Verifier: ${capsule.verifierSummary}` : null,
    capsule.approvalsSummary ? `Approvals: ${capsule.approvalsSummary}` : null,
    capsule.recentToolResults.length > 0
      ? `Recent tools:\n${capsule.recentToolResults.map((r) => `- ${r}`).join('\n')}`
      : null,
  ].filter(Boolean);
  return parts.join('\n');
}

// ─── Runtime Pro → Flash failover ───────────────────────────────────────────

export interface FailoverDecision {
  fromModel: string;
  toModel: string;
  reason: string;
  /** Failover is NOT independent verification. */
  countsAsVerification: false;
}

const RETRYABLE_ERROR_RE =
  /rate.?limit|429|503|502|timeout|ECONNRESET|temporar|overloaded|capacity/i;

export function isRetryableProviderFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERROR_RE.test(msg);
}

/**
 * Pro → Flash same-family failover for retryable failures.
 * Returns null when failover is not applicable.
 */
export function decideProToFlashFailover(
  modelId: string,
  error: unknown,
): FailoverDecision | null {
  if (!isRetryableProviderFailure(error)) return null;
  const m = modelId.toLowerCase();
  if (!m.includes('deepseek') || !m.includes('pro')) return null;
  return {
    fromModel: modelId,
    toModel: 'deepseek-v4-flash',
    reason: `Retryable provider failure on ${modelId}; failing over to deepseek-v4-flash`,
    countsAsVerification: false,
  };
}
