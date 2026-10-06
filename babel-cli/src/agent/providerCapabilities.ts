/**
 * Provider capability truth, context budget, failover helpers.
 *
 * One ProviderCapabilities record per resolved route. Capability defaults are
 * keyed by an explicit provider, never by substrings of a model name: a routed
 * model keeps the provider that serves it. Budget formula:
 *   context_budget = context_window - requested_output - tool/schema_reserve - safety_margin
 */

import type { ProviderCapabilities } from '../runners/base.js';
import { isProviderId, type ProviderId } from '../runners/providerRegistry.js';
import type { ModelRef } from '../intelligence/model-ref.js';
import {
  getAvailableModels,
  getModelContextWindow,
  getNormalizedModelCapabilities,
  type ModelPolicyModelEntry,
} from '../modelPolicy.js';
import { computeRequestBudget } from './context-budget.js';

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
 * Compatibility projection over {@link computeRequestBudget}.
 *
 * Never fabricates capacity: an unknown or infeasible request reports 0 here
 * (the typed status lives in `computeRequestBudget`). `maxOutputTokens` is used
 * as the requested per-turn output for these legacy callers.
 */
export function computeContextBudget(input: ContextBudgetInput): ContextBudget {
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const toolSchemaReserve = input.toolSchemaReserve ?? DEFAULT_TOOL_SCHEMA_RESERVE;
  const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const budget = computeRequestBudget({
    contextWindow: input.contextWindow,
    requestedOutputTokens: maxOutputTokens,
    maxOutputTokens,
    toolSchemaReserve,
    safetyMargin,
  });
  return {
    contextWindow: budget.contextWindow ?? 0,
    maxOutputTokens,
    toolSchemaReserve,
    safetyMargin,
    contextBudget: budget.capacityTokens,
  };
}

/** Built-in capability defaults keyed by explicit provider identity. */
const CAPABILITY_DEFAULTS: Partial<Record<ProviderId, Partial<ProviderCapabilities>>> = {
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
  openrouter: {
    maxOutputTokens: 131_072,
    supportsThinking: true,
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
    supportsStreaming: true,
    // OpenRouter exposes the model's reasoning/tool surface, but this
    // campaign has not yet established that GLM reasoning is reliable while
    // tools are active. Keep the uncertainty visible to routing.
    thinkingWithTools: 'unknown',
  },
};

/** Conservative defaults when a provider has no registered capability profile. */
const GENERIC_CAPABILITY_DEFAULTS: Partial<ProviderCapabilities> = {
  // No `maxOutputTokens`: a provider without a capability profile has an
  // unknown output ceiling, not a supported one. Fabricating a positive value
  // here would turn a missing fact into an asserted limit.
  supportsThinking: false,
  supportsToolChoice: true,
  supportsParallelToolCalls: true,
  supportsStreaming: true,
  thinkingWithTools: 'unknown',
};

/** A provider identity that could not be resolved from a bare selector. */
export type ResolvedProviderId = ProviderId | 'unknown';

/** Capability record bound to the explicit route that produced it. */
export interface RoutedProviderCapabilities extends ProviderCapabilities {
  /** Hosting provider of the resolved route; never inferred from model text. */
  readonly provider: ResolvedProviderId;
  readonly modelId: string;
}

function safeAvailableModels(): ReturnType<typeof getAvailableModels> {
  try {
    return getAvailableModels();
  } catch {
    return [];
  }
}

/** Find the single policy entry for an explicit provider + model tuple. */
function findRoutePolicyEntry(
  provider: ProviderId,
  modelId: string,
): ModelPolicyModelEntry | null {
  const matches = safeAvailableModels().filter(
    ({ key, entry }) =>
      entry.provider === provider && (entry.model_id === modelId || key === modelId),
  );
  if (matches.length === 0) return null;
  // Multiple backend keys may reference one served model (the shipped v2 policy
  // does). That is one tuple, not ambiguity. Distinct served model IDs for the
  // same selector are ambiguous and rejected.
  const distinctServedModels = new Set(matches.map((match) => match.entry.model_id));
  if (distinctServedModels.size > 1) {
    throw new Error(
      `Ambiguous model policy entries for provider "${provider}" and model "${modelId}": ${[
        ...distinctServedModels,
      ]
        .sort()
        .join(', ')}.`,
    );
  }
  const exactKey = matches.find((match) => match.key === modelId);
  return (exactKey ?? matches[0]!).entry;
}

/**
 * Resolve the hosting provider for a bare model selector.
 *
 * Deterministic tuple lookup only. A selector that matches entries from more
 * than one provider is ambiguous and rejected rather than guessed.
 */
export function resolveProviderIdForSelector(modelId: string): ResolvedProviderId {
  const candidates = new Set<ProviderId>();
  const normalized = getNormalizedModelCapabilities(modelId);
  if (normalized && isProviderId(normalized.provider)) {
    candidates.add(normalized.provider);
  }
  for (const { key, entry } of safeAvailableModels()) {
    if (key === modelId || entry.model_id === modelId) {
      if (isProviderId(entry.provider)) {
        candidates.add(entry.provider);
      }
    }
  }
  if (candidates.size === 0) return 'unknown';
  if (candidates.size > 1) {
    throw new Error(
      `Ambiguous provider identity for model selector "${modelId}": ${[...candidates]
        .sort()
        .join(', ')}. Supply an explicit route provider instead of relying on a model-name lookup.`,
    );
  }
  return [...candidates][0]!;
}

function resolveCapabilities(
  provider: ResolvedProviderId,
  modelId: string,
  overrides?: Partial<ProviderCapabilities>,
): RoutedProviderCapabilities {
  const defaults =
    (provider !== 'unknown' ? CAPABILITY_DEFAULTS[provider] : undefined) ??
    GENERIC_CAPABILITY_DEFAULTS;
  const entry = provider === 'unknown' ? null : findRoutePolicyEntry(provider, modelId);
  const normalized = getNormalizedModelCapabilities(modelId);
  // A legacy policy record is trusted only when it names the same provider as
  // the explicit route; otherwise the route wins.
  const providerAgrees =
    normalized !== null && isProviderId(normalized.provider) && normalized.provider === provider;
  const normalizedWindow = providerAgrees ? normalized?.contextWindow : undefined;
  // For an explicit route, only a provider-qualified entry (or a record that
  // names the same provider) may supply the window; a provider-agnostic policy
  // lookup is reserved for the `unknown` compatibility path.
  const contextWindow =
    entry?.context_window ??
    entry?.context_limit ??
    normalizedWindow ??
    (provider === 'unknown' ? getModelContextWindow(modelId) : undefined) ??
    0;
  const maxOutputTokens =
    entry?.max_output_tokens ??
    (providerAgrees ? normalized?.maxOutputTokens : undefined) ??
    defaults.maxOutputTokens ??
    // Unknown is 0, matching the unknown contextWindow convention. Callers that
    // need a per-turn output default must supply it from policy, not here.
    0;

  const base: ProviderCapabilities = {
    contextWindow,
    maxOutputTokens,
    supportsThinking: defaults.supportsThinking ?? false,
    supportsToolChoice: defaults.supportsToolChoice ?? true,
    supportsParallelToolCalls: defaults.supportsParallelToolCalls ?? true,
    supportsStreaming: defaults.supportsStreaming ?? true,
    thinkingWithTools: defaults.thinkingWithTools ?? 'unknown',
  };

  return {
    ...base,
    ...overrides,
    contextWindow: overrides?.contextWindow ?? base.contextWindow,
    provider,
    modelId,
  };
}

/**
 * Resolve capabilities for an explicit routed identity.
 *
 * This is the primary entrypoint: the supplied provider is authoritative. A
 * model ID that merely contains "deepseek" or ":" never changes the provider.
 */
export function resolveProviderCapabilitiesForRoute(
  ref: ModelRef,
  overrides?: Partial<ProviderCapabilities>,
): RoutedProviderCapabilities {
  return resolveCapabilities(ref.provider, ref.modelId, overrides);
}

/**
 * Compatibility adapter over {@link resolveProviderCapabilitiesForRoute}.
 *
 * The provider is resolved from the model-policy tuple graph — never from
 * model-name substrings. An ambiguous selector throws.
 */
export function resolveProviderCapabilities(
  modelId: string,
  overrides?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  const resolved = resolveCapabilities(resolveProviderIdForSelector(modelId), modelId, overrides);
  return {
    contextWindow: resolved.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens,
    supportsThinking: resolved.supportsThinking,
    supportsToolChoice: resolved.supportsToolChoice,
    supportsParallelToolCalls: resolved.supportsParallelToolCalls,
    supportsStreaming: resolved.supportsStreaming,
    thinkingWithTools: resolved.thinkingWithTools,
  };
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
  if (budget.contextWindow <= 0 || budget.contextBudget <= 0) {
    return false;
  }
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
    rawObservationRefs: [...(input.rawObservationRefs ?? [])],
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
    capsule.rawObservationRefs.length > 0 && capsule.rawObservationRefs.length <= 4
      ? `RawObservationRefs: ${capsule.rawObservationRefs.join(', ')}`
      : capsule.rawObservationRefs.length > 4
        ? `RawObservationRefs: ${capsule.rawObservationRefs.length} exact references retained durably`
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
  /** Per-turn output actually requested; defaults to `maxOutputTokens`. */
  requestedOutputTokens?: number;
  toolSchemaReserve?: number;
  safetyMargin?: number;
  /**
   * Set when canonical/retrieved tokens are NOT already part of
   * `nextRequestTokens`. `nextRequestTokens` is the total payload estimate, so
   * by default the breakdown fields are informational and counted once. Only
   * set this when the caller passes a total that excludes the breakdown.
   */
  breakdownExcludedFromNextRequest?: boolean;
}): ContextBudgetSnapshot {
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const requestedOutputTokens = input.requestedOutputTokens ?? maxOutputTokens;
  const toolSchemaReserve = input.toolSchemaReserve ?? DEFAULT_TOOL_SCHEMA_RESERVE;
  const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const activeWindowTokens = input.activeWindowTokens ?? input.nextRequestTokens;
  const canonicalStateTokens = input.canonicalStateTokens ?? 0;
  const retrievedContextTokens = input.retrievedContextTokens ?? 0;
  const systemToolReserve = toolSchemaReserve + safetyMargin;
  const promptTokens =
    input.breakdownExcludedFromNextRequest === true
      ? input.nextRequestTokens + canonicalStateTokens + retrievedContextTokens
      : input.nextRequestTokens;
  const budget = computeRequestBudget({
    contextWindow: input.contextWindow,
    requestedOutputTokens,
    maxOutputTokens,
    promptTokens,
    toolSchemaReserve,
    safetyMargin,
  });
  return {
    nextRequestTokens: input.nextRequestTokens,
    systemToolReserve,
    activeWindowTokens,
    canonicalStateTokens,
    retrievedContextTokens,
    outputReserve: budget.selectedOutputReserve,
    headroom: budget.status === 'fit' ? budget.capacityTokens - promptTokens : 0,
    contextWindow: budget.contextWindow ?? 0,
    contextBudget: budget.capacityTokens,
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
