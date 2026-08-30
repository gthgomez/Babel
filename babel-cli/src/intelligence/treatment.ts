import { hashCanonical } from "./hash.js";
import type {
  AuxiliaryInferencePolicy,
  CampaignIdentityInputs,
  CompactionTreatmentEvidence,
  ContextEnvelopeCalculation,
  TokenCountEstimate,
} from "./types.js";

/** Preserve the method and confidence whenever a prompt is converted to tokens. */
export function estimateTokenCount(input: {
  text: string;
  tokenizer?: (text: string) => number;
  tokenizerName?: string;
  providerReported?: number;
}): TokenCountEstimate {
  if (
    input.providerReported !== undefined &&
    Number.isFinite(input.providerReported)
  ) {
    return {
      tokens: input.providerReported,
      method: "provider_reported",
      confidence: "exact",
      ...(input.tokenizerName === undefined
        ? {}
        : { tokenizer: input.tokenizerName }),
    };
  }
  if (input.tokenizer) {
    return {
      tokens: input.tokenizer(input.text),
      method: input.tokenizerName ? "model_tokenizer" : "heuristic",
      confidence: input.tokenizerName ? "high" : "medium",
      ...(input.tokenizerName === undefined
        ? {}
        : { tokenizer: input.tokenizerName }),
    };
  }
  return {
    tokens: Math.max(1, Math.ceil(input.text.length / 4)),
    method: "heuristic",
    confidence: "low",
  };
}

/** Resolve input headroom from the provider/model ceiling rather than character budgets. */
export function calculateContextEnvelope(input: {
  contextLimit?: number;
  reservedOutputTokens: number;
  reservedReasoningTokens?: number;
  protocolToolOverheadTokens?: number;
  safetyMarginTokens?: number;
}): ContextEnvelopeCalculation {
  const protocolToolOverheadTokens = input.protocolToolOverheadTokens ?? 0;
  const safetyMarginTokens = input.safetyMarginTokens ?? 0;
  const reservedReasoningTokens = input.reservedReasoningTokens ?? 0;
  const reserved =
    input.reservedOutputTokens +
    reservedReasoningTokens +
    protocolToolOverheadTokens +
    safetyMarginTokens;
  return {
    ...(input.contextLimit === undefined
      ? {}
      : { contextLimit: input.contextLimit }),
    reservedOutputTokens: input.reservedOutputTokens,
    ...(input.reservedReasoningTokens === undefined
      ? {}
      : { reservedReasoningTokens }),
    protocolToolOverheadTokens,
    safetyMarginTokens,
    ...(input.contextLimit === undefined
      ? {}
      : {
          maximumAdmissibleInputTokens: Math.max(
            0,
            input.contextLimit - reserved,
          ),
        }),
  };
}

/** Make auxiliary model choice explicit before it can participate in an experiment. */
export function resolveAuxiliaryInferencePolicy(input: {
  policy: AuxiliaryInferencePolicy;
  primaryProviderProfileHash: string;
}): AuxiliaryInferencePolicy {
  const { policy } = input;
  if (
    policy.modelPolicy.mode === "explicit" &&
    policy.modelPolicy.providerProfileHash.length === 0
  ) {
    throw new Error(
      `Auxiliary ${policy.role} requires a provider profile hash.`,
    );
  }
  if (
    policy.experimentalTreatment === "part_of_primary_treatment" &&
    policy.modelPolicy.mode === "disabled"
  ) {
    throw new Error(
      `Disabled auxiliary ${policy.role} cannot be part of the primary treatment.`,
    );
  }
  if (
    policy.modelPolicy.mode === "inherit_primary" &&
    input.primaryProviderProfileHash.length === 0
  ) {
    throw new Error(
      `Auxiliary ${policy.role} cannot inherit an unknown primary profile.`,
    );
  }
  return Object.freeze({
    ...policy,
    modelPolicy:
      policy.modelPolicy.mode === "explicit"
        ? Object.freeze({ ...policy.modelPolicy })
        : Object.freeze({ ...policy.modelPolicy }),
  });
}

/** Record context transformation as part of the experimental treatment. */
export function buildCompactionTreatmentEvidence(input: {
  algorithm: string;
  model?: string;
  provider?: string;
  protocol?: CompactionTreatmentEvidence["protocol"];
  inputState: unknown;
  outputSummary?: string;
  targetTokenBudget?: number;
  estimatedTokensRemoved?: number;
  actualTokensRemoved?: number;
  preservedEventIds?: readonly string[];
  summarizedEventIds?: readonly string[];
  droppedEventIds?: readonly string[];
}): CompactionTreatmentEvidence {
  return {
    algorithm: input.algorithm,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
    inputStateHash: hashCanonical(input.inputState),
    ...(input.outputSummary === undefined
      ? {}
      : { outputSummaryHash: hashCanonical(input.outputSummary) }),
    ...(input.targetTokenBudget === undefined
      ? {}
      : { targetTokenBudget: input.targetTokenBudget }),
    ...(input.estimatedTokensRemoved === undefined
      ? {}
      : { estimatedTokensRemoved: input.estimatedTokensRemoved }),
    ...(input.actualTokensRemoved === undefined
      ? {}
      : { actualTokensRemoved: input.actualTokensRemoved }),
    preservedEventIds: [...(input.preservedEventIds ?? [])],
    summarizedEventIds: [...(input.summarizedEventIds ?? [])],
    droppedEventIds: [...(input.droppedEventIds ?? [])],
  };
}

/** Campaign identity includes policy hashes so changed treatment creates a new campaign. */
export function campaignIdentityHash(input: CampaignIdentityInputs): string {
  return hashCanonical(input);
}
