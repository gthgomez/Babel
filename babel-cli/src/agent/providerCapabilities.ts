/**
 * Provider capability truth, context budget, failover helpers.
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

/**
 * Deterministic operational state capsule (H1 expanded).
 * Survives compaction into the next provider request and cold-resume rebuild.
 */
export interface CompactionCapsule {
  task: string;
  /** Immutable task / acceptance identity when available. */
  taskAcceptanceId: string;
  /** Current plan step id or label. */
  planStep: string;
  progressSummary: string;
  patchSummary: string;
  /** Paths known changed in this session (filesystem/Git evidence). */
  changedPaths: string[];
  /** Unresolved failure capsules (short digests). */
  unresolvedFailures: string[];
  verifierSummary: string;
  /** Verifier freshness: bound revision or "stale"/empty. */
  verifierFreshness: string;
  approvalsSummary: string;
  /** Remaining budget summary (turns/tokens). */
  budgetsSummary: string;
  /** Workspace revision (git HEAD or harness revision id). */
  workspaceRevision: string;
  /** Evidence references (event ids, receipt digests). */
  evidenceRefs: string[];
  recentToolResults: string[];
  /** Immutable refs to raw observation logs reduced out of the active window. */
  rawObservationRefs: string[];
  createdAt: string;
}

export function buildCompactionCapsule(input: {
  task: string;
  taskAcceptanceId?: string;
  planStep?: string;
  progressSummary?: string;
  patchSummary?: string;
  changedPaths?: string[];
  unresolvedFailures?: string[];
  verifierSummary?: string;
  verifierFreshness?: string;
  approvalsSummary?: string;
  budgetsSummary?: string;
  workspaceRevision?: string;
  evidenceRefs?: string[];
  recentToolResults?: string[];
  rawObservationRefs?: string[];
}): CompactionCapsule {
  return {
    task: input.task,
    taskAcceptanceId: input.taskAcceptanceId ?? '',
    planStep: input.planStep ?? '',
    progressSummary: input.progressSummary ?? '',
    patchSummary: input.patchSummary ?? '',
    changedPaths: (input.changedPaths ?? []).slice(0, 64),
    unresolvedFailures: (input.unresolvedFailures ?? []).slice(0, 16),
    verifierSummary: input.verifierSummary ?? '',
    verifierFreshness: input.verifierFreshness ?? '',
    approvalsSummary: input.approvalsSummary ?? '',
    budgetsSummary: input.budgetsSummary ?? '',
    workspaceRevision: input.workspaceRevision ?? '',
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, 32),
    recentToolResults: (input.recentToolResults ?? []).slice(-8),
    rawObservationRefs: (input.rawObservationRefs ?? []).slice(0, 32),
    createdAt: new Date().toISOString(),
  };
}

export function formatCompactionCapsule(capsule: CompactionCapsule): string {
  const parts = [
    '# Compaction capsule (state preserved)',
    `Task: ${capsule.task}`,
    capsule.taskAcceptanceId ? `TaskAcceptanceId: ${capsule.taskAcceptanceId}` : null,
    capsule.planStep ? `PlanStep: ${capsule.planStep}` : null,
    capsule.progressSummary ? `Progress: ${capsule.progressSummary}` : null,
    capsule.patchSummary ? `Patch: ${capsule.patchSummary}` : null,
    capsule.changedPaths.length > 0
      ? `ChangedPaths:\n${capsule.changedPaths.map((p) => `- ${p}`).join('\n')}`
      : null,
    capsule.unresolvedFailures.length > 0
      ? `UnresolvedFailures:\n${capsule.unresolvedFailures.map((f) => `- ${f}`).join('\n')}`
      : null,
    capsule.verifierSummary ? `Verifier: ${capsule.verifierSummary}` : null,
    capsule.verifierFreshness ? `VerifierFreshness: ${capsule.verifierFreshness}` : null,
    capsule.approvalsSummary ? `Approvals: ${capsule.approvalsSummary}` : null,
    capsule.budgetsSummary ? `Budgets: ${capsule.budgetsSummary}` : null,
    capsule.workspaceRevision ? `WorkspaceRevision: ${capsule.workspaceRevision}` : null,
    capsule.evidenceRefs.length > 0
      ? `EvidenceRefs: ${capsule.evidenceRefs.join(', ')}`
      : null,
    capsule.recentToolResults.length > 0
      ? `Recent tools:\n${capsule.recentToolResults.map((r) => `- ${r}`).join('\n')}`
      : null,
    capsule.rawObservationRefs.length > 0
      ? `RawObservationRefs: ${capsule.rawObservationRefs.join(', ')}`
      : null,
  ].filter(Boolean);
  return parts.join('\n');
}

/**
 * One complete operational context-budget contract (H1).
 * Covers next-request size, reserves, active window, canonical state,
 * retrieved context, output reserve, and headroom.
 */
export interface ContextBudgetSnapshot {
  /** Estimated tokens for the next provider request payload. */
  nextRequestTokens: number;
  /** System + tool-schema reserve. */
  systemToolReserve: number;
  /** Tokens in the active working-set window. */
  activeWindowTokens: number;
  /** Tokens in the deterministic capsule / canonical state. */
  canonicalStateTokens: number;
  /** Tokens attributed to retrieved/external context (0 when none). */
  retrievedContextTokens: number;
  /** Output / response reserve. */
  outputReserve: number;
  /** Remaining headroom before the model context window is exceeded. */
  headroom: number;
  /** Model context window. */
  contextWindow: number;
  /** Effective conversation budget (window − output − tool reserve − margin). */
  contextBudget: number;
}

export function buildContextBudgetSnapshot(input: {
  nextRequestTokens: number;
  activeWindowTokens?: number;
  canonicalStateTokens?: number;
  retrievedContextTokens?: number;
  contextWindow: number;
  maxOutputTokens?: number;
  toolSchemaReserve?: number;
  safetyMargin?: number;
}): ContextBudgetSnapshot {
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const toolSchemaReserve = input.toolSchemaReserve ?? DEFAULT_TOOL_SCHEMA_RESERVE;
  const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const budget = computeContextBudget({
    contextWindow: input.contextWindow,
    maxOutputTokens,
    toolSchemaReserve,
    safetyMargin,
  });
  const activeWindowTokens = input.activeWindowTokens ?? input.nextRequestTokens;
  const canonicalStateTokens = input.canonicalStateTokens ?? 0;
  const retrievedContextTokens = input.retrievedContextTokens ?? 0;
  const systemToolReserve = toolSchemaReserve + safetyMargin;
  const headroom = Math.max(
    0,
    budget.contextBudget - input.nextRequestTokens - canonicalStateTokens - retrievedContextTokens,
  );
  return {
    nextRequestTokens: input.nextRequestTokens,
    systemToolReserve,
    activeWindowTokens,
    canonicalStateTokens,
    retrievedContextTokens,
    outputReserve: maxOutputTokens,
    headroom,
    contextWindow: budget.contextWindow,
    contextBudget: budget.contextBudget,
  };
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
