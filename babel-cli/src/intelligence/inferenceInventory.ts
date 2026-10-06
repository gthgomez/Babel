import type { AuxiliaryInferencePolicy, ExecutionMode } from "./types.js";
import type { ModelRef } from "./model-ref.js";

export type InferenceComponentRole =
  | "PRIMARY"
  | "AUXILIARY_COMPACTION"
  | "AUXILIARY_CRITIC"
  | "AUXILIARY_REVIEWER"
  | "AUXILIARY_SUMMARIZER"
  | "AUXILIARY_VERIFIER"
  | "OTHER";

/** Who owns per-attempt usage/cost settlement for a component. */
export type InferenceAccountingOwner =
  | "chatEngineProviderAccounting"
  | "liteProvider"
  | "campaignRunner";

export interface InferenceComponent {
  id: string;
  role: InferenceComponentRole;
  policyRequired: boolean;
  notes: string;
  /**
   * The actual source symbols that perform this inference. This is an
   * inventory pointer, not an authority: the owning module remains the single
   * implementation.
   */
  callSite: string;
  /**
   * Exact provider-qualified identity when the lane pins one. A policy-resolved
   * lane leaves this absent and states its selector in {@link modelSelector}
   * instead of inventing a model.
   */
  effectiveRef?: ModelRef;
  /** Declared selector for a policy-resolved lane (never a concrete guess). */
  modelSelector?: string;
  /** Owner of per-attempt usage/cost settlement. */
  accountingOwner: InferenceAccountingOwner;
  /** Execution mode this lane is expected to run under. */
  executionMode?: ExecutionMode;
}

/** The known inference-producing roles that must be represented in a campaign manifest. */
export const KNOWN_INFERENCE_COMPONENTS: readonly InferenceComponent[] =
  Object.freeze([
    {
      id: "primary",
      role: "PRIMARY",
      policyRequired: true,
      notes: "Task-facing model calls.",
      callSite:
        "chatEngineProviderRuntime.deliberateChatTurn; synthesizeChatAnswer; executeChatRunnerWithTimeout",
      modelSelector: "resolveChatModelPolicy (family/stage/backend key)",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "lite",
      role: "OTHER",
      policyRequired: false,
      notes: "Babel Lite ask/patch inference through a concrete Lite provider.",
      callSite: "lite/commands.runLiteAsk; runLitePatch; lite/provider.complete",
      effectiveRef: { provider: "deepseek", modelId: "deepseek-v4-flash" },
      accountingOwner: "liteProvider",
      executionMode: "production_resilient",
    },
    {
      id: "subagent-router",
      role: "OTHER",
      policyRequired: true,
      notes: "Sub-agent route selection and connection-keyed runner reuse.",
      callSite: "agent/modelRouter.ModelRouter.resolve; beginRouteAttempt; recordRouteAttemptUsage",
      modelSelector: "ModelRouterOptions.defaultBackendKey / cheapest admitted",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "compaction",
      role: "AUXILIARY_COMPACTION",
      policyRequired: true,
      notes: "Conversation compaction or summarization.",
      callSite: "agent/chatCompaction; agent/compactionCommit",
      modelSelector: "BABEL_COMPACTION_MODEL / AuxiliaryInferencePolicy.inherit_primary",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "diff-critic",
      role: "AUXILIARY_CRITIC",
      policyRequired: true,
      notes: "Diff-focused critique.",
      callSite: "agent/diffCritic",
      modelSelector: "BABEL_DIFF_CRITIC_MODEL / AuxiliaryInferencePolicy",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "pro-critic",
      role: "AUXILIARY_CRITIC",
      policyRequired: true,
      notes: "Pro/quality critique.",
      callSite: "agent/chatEngineCriticBudget; agent/chatEngineProviderRuntime",
      modelSelector: "AuxiliaryInferencePolicy.critic",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "reviewer",
      role: "AUXILIARY_REVIEWER",
      policyRequired: true,
      notes: "Review or adjudication inference.",
      callSite: "agent/reviewOnDiffAgent",
      modelSelector: "AuxiliaryInferencePolicy.reviewer",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "summarizer",
      role: "AUXILIARY_SUMMARIZER",
      policyRequired: true,
      notes: "Explicit summarization inference.",
      callSite: "agent/turnSummaryScheduler",
      modelSelector: "AuxiliaryInferencePolicy.summarizer",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "verifier",
      role: "AUXILIARY_VERIFIER",
      policyRequired: true,
      notes: "Model-based verification inference.",
      callSite: "agent/verifierKernel; agent/chatEngineVerifierAdapter",
      modelSelector: "AuxiliaryInferencePolicy.verifier",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
    {
      id: "fallback",
      role: "OTHER",
      policyRequired: true,
      notes: "Any model fallback path.",
      callSite:
        "chatEngineProviderRuntime.resolveChatFallbackOrFail; resolveChatFallbackRunner; resolveChatSynthesisRunner",
      modelSelector: "configured ordered routes only (no hard-coded ultimate fallback)",
      accountingOwner: "chatEngineProviderAccounting",
      executionMode: "production_resilient",
    },
  ]);

/** Require a declared policy for every auxiliary role before strict fan-out. */
export function assertAuxiliaryInferenceInventory(
  policies: ReadonlyMap<string, AuxiliaryInferencePolicy>,
  options: { strict: boolean } = { strict: true },
): void {
  if (!options.strict) return;
  const requiredRoles = new Set<AuxiliaryInferencePolicy["role"]>([
    "compaction",
    "critic",
    "reviewer",
    "summarizer",
    "verifier",
  ]);
  for (const role of requiredRoles) {
    if (!policies.has(role)) {
      throw new Error(
        `Strict execution has no explicit auxiliary inference policy for ${role}.`,
      );
    }
  }
}
