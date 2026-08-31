import { deepFreeze, hashCanonical } from "./hash.js";
import type {
  CapabilityEvidence,
  ExecutionMode,
  LabModelSpec,
  ModelRevisionResolution,
  ProviderModelProfile,
  ProviderRoutingPolicy,
  ProtocolProfile,
  ResolvedExecutionEnvelope,
  ResolvedSamplingPolicy,
  HarnessTuningProfile,
} from "./types.js";

export interface ExecutionEnvelopeErrorDetails {
  code:
    | "EXECUTION_ENVELOPE_REJECTED"
    | "MODEL_REVISION_UNRESOLVED"
    | "MODEL_REVISION_DRIFT";
  field: string;
  resolution: "rejected";
  message: string;
}

/** Typed fail-closed error for an unsupported or ambiguous execution choice. */
export class ExecutionEnvelopeError extends Error {
  readonly details: ExecutionEnvelopeErrorDetails;

  constructor(details: ExecutionEnvelopeErrorDetails) {
    super(details.message);
    this.name = "ExecutionEnvelopeError";
    this.details = details;
  }
}

export interface ResolveModelRevisionInput {
  requested: string;
  resolved?: string;
  catalogModelId?: string;
  canonicalRevisionSlug?: string;
  aliasUsed?: boolean;
  aliasId?: string | null;
  aliasTarget?: string | null;
  aliases?: Readonly<Record<string, string>>;
  observedAt?: string;
  source?: "provider_api" | "manual_override" | "already_concrete";
}

/** Resolve an alias once and preserve both the operator request and concrete revision. */
export function resolveModelRevision(
  input: ResolveModelRevisionInput,
): ModelRevisionResolution {
  const requested = input.requested.trim();
  if (!requested) {
    throw new ExecutionEnvelopeError({
      code: "MODEL_REVISION_UNRESOLVED",
      field: "model.requested",
      resolution: "rejected",
      message:
        "A model selector is required before a campaign can be identified.",
    });
  }
  const aliasLike = /(?:latest|preview|:free|:batch|^~)/i.test(requested);
  // Exact concrete IDs are never looked up through an alias target. This is
  // deliberately independent of catalog ordering and protects strict runs
  // from moving aliases such as ~...-latest.
  const resolved = aliasLike
    ? input.resolved?.trim() || input.aliases?.[requested] || requested
    : requested;
  if (!resolved || (aliasLike && resolved === requested && !input.resolved)) {
    throw new ExecutionEnvelopeError({
      code: "MODEL_REVISION_UNRESOLVED",
      field: "model.resolved",
      resolution: "rejected",
      message: `Model selector "${requested}" has no concrete revision mapping.`,
    });
  }
  const source =
    input.source ??
    (resolved === requested ? "already_concrete" : "provider_api");
  return {
    requested,
    resolved,
    userRequestedModelId: requested,
    catalogModelId: input.catalogModelId?.trim() || resolved,
    wireModelId: resolved,
    canonicalRevisionSlug: input.canonicalRevisionSlug?.trim() || resolved,
    aliasUsed: input.aliasUsed ?? (aliasLike && resolved !== requested),
    aliasId:
      input.aliasId ?? (aliasLike && resolved !== requested ? requested : null),
    aliasTarget:
      input.aliasTarget ??
      (aliasLike && resolved !== requested ? resolved : null),
    observedAt: input.observedAt ?? new Date().toISOString(),
    source,
  };
}

/** Fail closed when an alias resolves to a different revision mid-campaign. */
export function assertModelRevisionStable(
  initial: Pick<ModelRevisionResolution, "requested" | "resolved">,
  current: Pick<ModelRevisionResolution, "requested" | "resolved">,
): void {
  if (
    initial.requested !== current.requested ||
    initial.resolved !== current.resolved
  ) {
    throw new ExecutionEnvelopeError({
      code: "MODEL_REVISION_DRIFT",
      field: "model.resolved",
      resolution: "rejected",
      message:
        `Model revision drift detected: campaign froze ${initial.requested} → ${initial.resolved}, ` +
        `but metadata now resolves ${current.requested} → ${current.resolved}.`,
    });
  }
}

export interface AffordabilityPreflightInput {
  inputPerToken?: number;
  outputPerToken?: number;
  promptTokens?: number;
  maximumOutputTokens?: number;
  expectedOutputTokens?: number;
  cells: number;
  maxEstimatedCostUsd?: number;
  availableUsd?: number;
}

export interface AffordabilityPreflightResult {
  status: "within_guardrail" | "blocked" | "unknown";
  estimatedWorstCaseCost?: number;
  estimatedExpectedCost?: number;
  reason?: string;
}

/** Calculate a conservative cost envelope without inventing missing provider data. */
export function preflightAffordability(
  input: AffordabilityPreflightInput,
): AffordabilityPreflightResult {
  const cells =
    Number.isInteger(input.cells) && input.cells > 0 ? input.cells : 0;
  const hasRates =
    typeof input.inputPerToken === "number" &&
    Number.isFinite(input.inputPerToken) &&
    typeof input.outputPerToken === "number" &&
    Number.isFinite(input.outputPerToken);
  const hasPrompt =
    typeof input.promptTokens === "number" && input.promptTokens >= 0;
  const hasMaximum =
    typeof input.maximumOutputTokens === "number" &&
    input.maximumOutputTokens >= 0;
  if (!hasRates || !hasPrompt || !hasMaximum || cells === 0) {
    return {
      status: "unknown",
      reason:
        "Pricing, prompt estimate, maximum output, or cell count is unavailable.",
    };
  }
  const estimatedWorstCaseCost =
    cells *
    (input.promptTokens! * input.inputPerToken! +
      input.maximumOutputTokens! * input.outputPerToken!);
  const estimatedExpectedCost =
    typeof input.expectedOutputTokens === "number" &&
    input.expectedOutputTokens >= 0
      ? cells *
        (input.promptTokens! * input.inputPerToken! +
          input.expectedOutputTokens * input.outputPerToken!)
      : undefined;
  const guard = input.maxEstimatedCostUsd ?? input.availableUsd;
  if (typeof guard === "number" && estimatedWorstCaseCost > guard) {
    return {
      status: "blocked",
      estimatedWorstCaseCost,
      ...(estimatedExpectedCost === undefined ? {} : { estimatedExpectedCost }),
      reason: `Worst-case cost $${estimatedWorstCaseCost.toFixed(6)} exceeds guardrail $${guard.toFixed(6)}.`,
    };
  }
  return {
    status: "within_guardrail",
    estimatedWorstCaseCost,
    ...(estimatedExpectedCost === undefined ? {} : { estimatedExpectedCost }),
  };
}

export interface ResolveExecutionEnvelopeInput {
  mode: ExecutionMode;
  model: ResolveModelRevisionInput;
  labModel: LabModelSpec;
  providerProfile: ProviderModelProfile;
  protocol?: ProtocolProfile["protocol"];
  harnessProfile?: HarnessTuningProfile;
  output?: {
    requested?: number | null;
    allowProductionClamp?: boolean;
  };
  contextBudget?: number;
  reasoning?: {
    requestedEffort?: string;
    allowTranslation?: boolean;
    translation?: Readonly<Record<string, string>>;
  };
  sampling?: {
    temperature?: number;
    topP?: number;
    seed?: number;
  };
  tools?: {
    enabled?: boolean;
    choice?: "auto" | "required" | "specific";
    parallel?: boolean;
  };
  structuredOutput?: {
    mode?: "none" | "json_object" | "json_schema";
    strict?: boolean;
    schema?: Record<string, unknown>;
  };
  routing?: ProviderRoutingPolicy;
  affordability?: Omit<
    AffordabilityPreflightInput,
    "maximumOutputTokens" | "cells"
  > & {
    cells: number;
    maxEstimatedCostUsd?: number;
    availableUsd?: number;
  };
}

function reject(field: string, message: string): never {
  throw new ExecutionEnvelopeError({
    code: "EXECUTION_ENVELOPE_REJECTED",
    field,
    resolution: "rejected",
    message,
  });
}

function observationState(observation: { state: string } | undefined): string {
  return observation?.state ?? "unknown";
}

function requireCapability(
  mode: ExecutionMode,
  field: string,
  state: string,
  requested: boolean,
): void {
  if (!requested) return;
  if (state === "behaviorally_rejected")
    reject(field, `${field} is behaviorally rejected by the profile.`);
  if (
    (mode === "benchmark_strict" || mode === "qualification") &&
    state === "unknown"
  ) {
    reject(
      field,
      `${field} is unknown; strict execution cannot assume support.`,
    );
  }
}

function chooseProtocol(
  providerProfile: ProviderModelProfile,
  requested: ProtocolProfile["protocol"] | undefined,
): ProtocolProfile {
  const protocol = requested ?? providerProfile.protocolProfiles[0]?.protocol;
  const selected = providerProfile.protocolProfiles.find(
    (profile) => profile.protocol === protocol,
  );
  if (!selected)
    reject(
      "protocol",
      `Protocol ${protocol ?? "(unspecified)"} is not profiled for this provider.`,
    );
  return selected;
}

function resolveOutput(
  mode: ExecutionMode,
  input: ResolveExecutionEnvelopeInput,
): ResolvedExecutionEnvelope["output"] {
  const requested = input.output?.requested ?? null;
  const modelLimit = input.labModel.declaredLimits.maxOutputTokens;
  const providerLimit = input.providerProfile.providerLimits.maxOutputTokens;
  const evidenceStatus =
    input.labModel.limitEvidenceStatus === "conflicting" ||
    input.providerProfile.limitEvidenceStatus === "conflicting"
      ? "conflicting"
      : input.labModel.limitEvidenceStatus === "supported" ||
          input.providerProfile.limitEvidenceStatus === "supported"
        ? "supported"
        : "unknown";
  const limits = [modelLimit, providerLimit].filter(
    (value): value is number => value !== undefined,
  );
  const limit = limits.length > 0 ? Math.min(...limits) : undefined;
  if (requested !== null && (!Number.isInteger(requested) || requested <= 0)) {
    reject(
      "output.requested",
      "Output budget must be a positive integer or null.",
    );
  }
  if (requested === null) {
    return {
      ...(modelLimit === undefined ? {} : { hardModelLimit: modelLimit }),
      ...(providerLimit === undefined ? {} : { providerLimit }),
      requested: null,
      effective: null,
      source: "explicitly_omitted",
      resolution: "omitted",
      evidenceStatus,
    };
  }
  if (limit !== undefined && requested > limit) {
    if (
      mode === "production_resilient" &&
      input.output?.allowProductionClamp === true
    ) {
      return {
        ...(modelLimit === undefined ? {} : { hardModelLimit: modelLimit }),
        ...(providerLimit === undefined ? {} : { providerLimit }),
        requested,
        effective: limit,
        source: "provider/model intersection",
        resolution: "clamped",
        evidenceStatus,
      };
    }
    reject(
      "output.requested",
      `Requested output ${requested} exceeds the effective model/provider limit ${limit}; silent clamping is disabled.`,
    );
  }
  return {
    ...(modelLimit === undefined ? {} : { hardModelLimit: modelLimit }),
    ...(providerLimit === undefined ? {} : { providerLimit }),
    requested,
    effective: requested,
    source: "explicit request within model/provider limits",
    resolution: "pass",
    evidenceStatus,
  };
}

function resolveReasoning(
  mode: ExecutionMode,
  profile: ProtocolProfile,
  input: ResolveExecutionEnvelopeInput,
): ResolvedExecutionEnvelope["reasoning"] {
  const requested = input.reasoning?.requestedEffort;
  if (!requested) {
    return { resolution: "omitted", semanticEffectVerified: null };
  }
  const supported = profile.reasoning.supportedEfforts ?? [];
  if (supported.includes(requested)) {
    const evidence = profile.reasoning.semanticEffectEvidence ?? [];
    const semanticEffectVerified = evidence.some(
      (item: CapabilityEvidence) =>
        item.capability === `reasoning_effort:${requested}` &&
        item.state === "behaviorally_verified",
    );
    return {
      requestedEffort: requested,
      effectiveEffort: requested,
      wireParameter: "reasoning_effort",
      resolution: "pass",
      semanticEffectVerified,
    };
  }
  const translated = input.reasoning?.translation?.[requested];
  if (
    mode === "production_resilient" &&
    input.reasoning?.allowTranslation === true &&
    translated
  ) {
    return {
      requestedEffort: requested,
      effectiveEffort: translated,
      wireParameter: "reasoning_effort",
      resolution: "translated",
      semanticEffectVerified: null,
    };
  }
  reject(
    "reasoning.requestedEffort",
    `Reasoning effort "${requested}" is unsupported; supported values are ${supported.join(", ") || "(none)"}.`,
  );
}

function resolveSampling(
  mode: ExecutionMode,
  profile: ProtocolProfile,
  input: ResolveExecutionEnvelopeInput,
): ResolvedSamplingPolicy {
  const requested = input.sampling;
  const entries: Array<{
    key: "temperature" | "topP" | "seed";
    canonicalParameter: string;
    wireParameter: string;
    value: number | undefined;
    validate: (value: number) => boolean;
  }> = [
    {
      key: "temperature",
      canonicalParameter: "temperature",
      wireParameter: "temperature",
      value: requested?.temperature,
      validate: (value) => value >= 0 && value <= 2,
    },
    {
      key: "topP",
      canonicalParameter: "top_p",
      wireParameter: "top_p",
      value: requested?.topP,
      validate: (value) => value > 0 && value <= 1,
    },
    {
      key: "seed",
      canonicalParameter: "seed",
      wireParameter: "seed",
      value: requested?.seed,
      validate: (value) => Number.isInteger(value) && value >= 0,
    },
  ];
  const resolved: ResolvedSamplingPolicy = {};
  for (const entry of entries) {
    if (entry.value === undefined) continue;
    if (!Number.isFinite(entry.value) || !entry.validate(entry.value)) {
      reject(
        `sampling.${entry.key}`,
        `Invalid ${entry.key} value ${entry.value}.`,
      );
    }
    const capability = profile.supportedParameters.find(
      (candidate) => candidate.canonicalParameter === entry.canonicalParameter,
    );
    const state = capability?.state ?? "unknown";
    if (state === "behaviorally_rejected") {
      reject(
        `sampling.${entry.key}`,
        `sampling.${entry.key} is behaviorally rejected by the profile.`,
      );
    }
    if (
      (mode === "benchmark_strict" || mode === "qualification") &&
      state === "unknown"
    ) {
      reject(
        `sampling.${entry.key}`,
        `sampling.${entry.key} is unknown; strict execution cannot assume support.`,
      );
    }
    const result = {
      requested: entry.value,
      accepted:
        state === "request_accepted" || state === "behaviorally_verified",
      ...(state === "unknown" ? {} : { effective: entry.value }),
      resolution:
        state === "unknown" ? ("omitted" as const) : ("pass" as const),
      semanticEffectVerified: capability?.semanticEffectVerified ?? false,
    };
    resolved[entry.key] = result;
  }
  return resolved;
}

/** Resolve every material policy choice into one immutable request envelope. */
export function resolveExecutionEnvelope(
  input: ResolveExecutionEnvelopeInput,
): ResolvedExecutionEnvelope {
  const revision = resolveModelRevision(input.model);
  const protocol = chooseProtocol(input.providerProfile, input.protocol);
  const output = resolveOutput(input.mode, input);
  if (input.contextBudget !== undefined && input.contextBudget <= 0) {
    reject("contextBudget", "Context budget must be positive when supplied.");
  }

  const requestedTools = input.tools?.enabled === true;
  requireCapability(
    input.mode,
    "tools.basicTools",
    observationState(protocol.tools.basicTools),
    requestedTools,
  );
  if (input.tools?.parallel === true) {
    requireCapability(
      input.mode,
      "tools.parallelTools",
      observationState(protocol.tools.parallelTools),
      true,
    );
  }
  if (input.tools?.choice === "required") {
    requireCapability(
      input.mode,
      "tools.toolChoiceRequired",
      observationState(protocol.tools.toolChoiceRequired),
      true,
    );
  }
  const requestedStructuredMode = input.structuredOutput?.mode ?? "none";
  if (requestedStructuredMode === "json_schema") {
    requireCapability(
      input.mode,
      "structuredOutput.jsonSchemaMode",
      observationState(protocol.structuredOutput.jsonSchemaMode),
      true,
    );
    if (input.structuredOutput?.strict === true) {
      requireCapability(
        input.mode,
        "structuredOutput.strictSchemaEnforcement",
        observationState(protocol.structuredOutput.strictSchemaEnforcement),
        true,
      );
    }
  }
  if (requestedStructuredMode === "json_object") {
    requireCapability(
      input.mode,
      "structuredOutput.jsonObjectMode",
      observationState(protocol.structuredOutput.jsonObjectMode),
      true,
    );
  }

  const routing = input.routing ?? {};
  const upstream = routing.upstream ?? input.providerProfile.upstreamProvider;
  if (input.mode === "benchmark_strict" && !upstream) {
    reject(
      "routing.upstream",
      "benchmark_strict requires an explicit upstream or a frozen provider profile endpoint.",
    );
  }
  if (input.mode === "benchmark_strict" && routing.allowFallbacks === true) {
    reject(
      "routing.allowFallbacks",
      "benchmark_strict cannot enable upstream fallbacks.",
    );
  }
  const resolvedRouting: ResolvedExecutionEnvelope["routing"] = {
    allowFallbacks:
      input.mode === "benchmark_strict"
        ? false
        : (routing.allowFallbacks ?? true),
    requireParameters:
      input.mode === "benchmark_strict"
        ? true
        : (routing.requireParameters ?? false),
    metadataEnabled:
      input.mode === "benchmark_strict"
        ? true
        : (routing.metadataEnabled ?? true),
    order: Object.freeze([...(routing.order ?? [])]),
    ...(upstream === undefined ? {} : { upstream }),
    allowContextTransformation:
      input.mode === "benchmark_strict"
        ? false
        : (routing.allowContextTransformation ?? true),
    resolution: "pass",
  };

  const affordability = input.affordability
    ? preflightAffordability({
        ...input.affordability,
        maximumOutputTokens:
          output.effective ??
          input.providerProfile.providerLimits.maxOutputTokens ??
          0,
      })
    : {
        status: "unknown" as const,
        reason: "No affordability preflight supplied.",
      };
  if (affordability.status === "blocked")
    reject(
      "affordability",
      affordability.reason ?? "Affordability guard blocked execution.",
    );
  if (input.mode === "qualification" && output.effective === null) {
    reject(
      "output.requested",
      "Qualification requires an explicit output budget; provider defaults are not reproducible.",
    );
  }

  const hardContext = input.labModel.declaredLimits.contextTokens;
  const providerContext = input.providerProfile.providerLimits.contextTokens;
  const effectiveContext =
    input.contextBudget === undefined
      ? undefined
      : Math.min(
          input.contextBudget,
          ...[hardContext, providerContext].filter(
            (value): value is number => value !== undefined,
          ),
        );
  const envelope: ResolvedExecutionEnvelope = {
    schemaVersion: 1,
    mode: input.mode,
    labModelHash: input.labModel.profileHash,
    providerProfileHash: input.providerProfile.profileHash,
    ...(input.harnessProfile
      ? { harnessProfileHash: input.harnessProfile.profileHash }
      : {}),
    model: {
      requested: revision.requested,
      resolved: revision.resolved,
      userRequestedModelId: revision.userRequestedModelId,
      catalogModelId: revision.catalogModelId,
      wireModelId: revision.wireModelId,
      canonicalRevisionSlug: revision.canonicalRevisionSlug,
      aliasUsed: revision.aliasUsed,
      aliasId: revision.aliasId,
      aliasTarget: revision.aliasTarget,
    },
    provider: {
      gateway: input.providerProfile.provider,
      ...(upstream === undefined ? {} : { upstream }),
      ...((routing.endpoint ?? input.providerProfile.endpointId)
        ? { endpoint: routing.endpoint ?? input.providerProfile.endpointId }
        : {}),
    },
    protocol: protocol.protocol,
    context: {
      ...(hardContext === undefined ? {} : { hardModelLimit: hardContext }),
      ...(providerContext === undefined
        ? {}
        : { providerLimit: providerContext }),
      ...(input.contextBudget === undefined
        ? {}
        : { requestedBudget: input.contextBudget }),
      ...(effectiveContext === undefined
        ? {}
        : { effectiveBudget: effectiveContext }),
    },
    output,
    reasoning: resolveReasoning(input.mode, protocol, input),
    sampling: resolveSampling(input.mode, protocol, input),
    tools: {
      requested: requestedTools,
      effective: requestedTools,
      choice: requestedTools ? (input.tools?.choice ?? "auto") : null,
      parallel: requestedTools && input.tools?.parallel === true,
      resolution: requestedTools ? "pass" : "omitted",
    },
    structuredOutput: {
      mode: requestedStructuredMode,
      strict: input.structuredOutput?.strict === true,
      ...(input.structuredOutput?.schema === undefined
        ? {}
        : { schema: input.structuredOutput.schema }),
      resolution: requestedStructuredMode === "none" ? "omitted" : "pass",
    },
    routing: resolvedRouting,
    affordability: {
      status: affordability.status,
      ...(affordability.estimatedWorstCaseCost === undefined
        ? {}
        : { estimatedWorstCaseCost: affordability.estimatedWorstCaseCost }),
      ...(affordability.estimatedExpectedCost === undefined
        ? {}
        : { estimatedExpectedCost: affordability.estimatedExpectedCost }),
    },
    configurationHash: "",
  };
  envelope.configurationHash = hashCanonical({
    ...envelope,
    configurationHash: undefined,
  });
  return deepFreeze(envelope);
}
