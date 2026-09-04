import type { ProviderId } from "../runners/providerRegistry.js";

/** Execution behavior is explicit so production resilience cannot leak into experiments. */
export type ExecutionMode =
  | "benchmark_strict"
  | "production_resilient"
  | "qualification";

/** Modalities exposed by a model or provider endpoint. */
export type Modality =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "file"
  | "unknown";

/** Evidence strength is deliberately ordered by source, not by confidence. */
export type CapabilityEvidenceState =
  | "declared"
  | "api_advertised"
  | "request_accepted"
  | "behaviorally_verified"
  | "behaviorally_rejected"
  | "unknown";

export type CapabilityState = CapabilityEvidenceState;
/** What the available observations say about a capability. */
export type CapabilitySupport =
  | "supported"
  | "unsupported"
  | "conditional"
  | "conflicting"
  | "unknown";

/** How the observation was established; this is intentionally separate from support. */
export type CapabilityEvidenceLevel =
  | "declared"
  | "api_advertised"
  | "request_accepted"
  | "behavioral";
export type CapabilityEvidenceSource =
  | "official_docs"
  | "provider_api"
  | "babel_probe"
  | "manual_override"
  | "legacy";
export type CapabilityConfidence = "high" | "medium" | "low" | "unknown";

/** A traceable observation about one capability or parameter. */
export interface CapabilityEvidence {
  capability: string;
  state: CapabilityEvidenceState;
  support?: CapabilitySupport;
  evidenceLevel?: CapabilityEvidenceLevel;
  provider?: string;
  model?: string;
  protocol?: string;
  upstream?: string;
  observedAt: string;
  source: CapabilityEvidenceSource;
  evidenceArtifactId?: string;
  confidence: CapabilityConfidence;
  notes?: string;
}

/** A capability observation keeps advertised and behavioral evidence separate. */
export interface CapabilityObservation {
  state: CapabilityEvidenceState;
  support: CapabilitySupport;
  evidenceLevel: CapabilityEvidenceLevel;
  semanticEffectVerified?: boolean;
  confidence?: CapabilityConfidence;
  evidence?: CapabilityEvidence[];
  notes?: string;
}

export type LimitEvidenceScope =
  | "lab_model"
  | "gateway"
  | "top_provider"
  | "endpoint"
  | "behavioral";

export type LimitEvidenceClaim =
  | "MODEL_AUTHOR_DECLARED_LIMIT"
  | "OPENROUTER_MODEL_DOCUMENTATION_LIMIT"
  | "OPENROUTER_GATEWAY_CATALOG_LIMIT"
  | "OPENROUTER_TOP_PROVIDER_LIMIT"
  | "EXACT_UPSTREAM_ENDPOINT_LIMIT"
  | "BEHAVIORALLY_TESTED_LIMIT";

/** A limit observation retains scope and provenance instead of becoming one blended maximum. */
export interface LimitEvidence {
  scope: LimitEvidenceScope;
  claim?: LimitEvidenceClaim;
  value?: number;
  field: "contextTokens" | "maxPromptTokens" | "maxOutputTokens";
  source: CapabilitySourceRef;
  observedAt: string;
  confidence: "high" | "medium" | "low";
  status: "supported" | "conflicting" | "unknown";
  notes?: string;
}

export type ParameterTransformation =
  | "identity"
  | "translated"
  | "clamped"
  | "omitted"
  | "provider_default"
  | "unknown";

/** Provider/protocol-specific support for a canonical generation parameter. */
export interface ParameterCapability {
  canonicalParameter: string;
  wireParameter?: string;
  state: CapabilityEvidenceState;
  allowedValues?: unknown[];
  transformation?: ParameterTransformation;
  semanticEffectVerified?: boolean;
}

export type ProtocolId =
  | "chat_completions"
  | "responses"
  | "anthropic_messages"
  | "custom";

export interface ReplayRequirement {
  field: string;
  required: boolean;
  notes?: string;
}

export interface ReasoningCapabilityProfile {
  enabled: CapabilityObservation;
  mechanism?:
    | "effort"
    | "token_budget"
    | "always_on"
    | "provider_specific"
    | "unknown";
  supportedEfforts?: string[];
  defaultEffort?: string;
  mandatory?: boolean;
  reasoningTokensCountAgainstOutput?: boolean;
  reasoningVisible?: boolean;
  reasoningReplayRequired?: boolean;
  semanticEffectEvidence?: CapabilityEvidence[];
}

export interface ToolCapabilityProfile {
  basicTools: CapabilityObservation;
  streamingTools: CapabilityObservation;
  sequentialTools: CapabilityObservation;
  parallelTools: CapabilityObservation;
  toolChoiceAuto: CapabilityObservation;
  toolChoiceRequired: CapabilityObservation;
  toolChoiceSpecific: CapabilityObservation;
  strictArgumentSchema: CapabilityObservation;
  reasoningToolInterleave: CapabilityObservation;
  reasoningReplayAcrossTurns: CapabilityObservation;
  multipleToolRounds: CapabilityObservation;
}

export interface StructuredOutputProfile {
  jsonObjectMode: CapabilityObservation;
  jsonSchemaMode: CapabilityObservation;
  strictSchemaEnforcement: CapabilityObservation;
  structuredOutputWithTools: CapabilityObservation;
  structuredOutputStreaming: CapabilityObservation;
}

export interface ProtocolProfile {
  protocol: ProtocolId;
  endpoint?: string;
  streaming: CapabilityObservation;
  reasoning: ReasoningCapabilityProfile;
  tools: ToolCapabilityProfile;
  structuredOutput: StructuredOutputProfile;
  supportedParameters: ParameterCapability[];
  replayRequirements?: ReplayRequirement[];
  qualificationStatus:
    | "unqualified"
    | "partially_qualified"
    | "qualified"
    | "failed";
}

export interface CapabilitySourceRef {
  source: CapabilityEvidenceSource;
  uri?: string;
  retrievedAt: string;
  artifactId?: string;
}

export interface RoutingCapabilityProfile {
  supportsProviderOrder?: CapabilityObservation;
  supportsFallbackControl?: CapabilityObservation;
  supportsRequireParameters?: CapabilityObservation;
  supportsRouterMetadata?: CapabilityObservation;
  supportsContextTransformationReporting?: CapabilityObservation;
}

export interface CacheCapabilityProfile {
  supportsPromptCaching?: CapabilityObservation;
  reportsCacheHitTokens?: CapabilityObservation;
  reportsCacheMissTokens?: CapabilityObservation;
}

export interface PricingProfile {
  inputPerToken?: number;
  outputPerToken?: number;
  cacheReadPerToken?: number;
  cacheWritePerToken?: number;
}

/** Per-endpoint hosted limits and advertised wire parameters. */
export interface ProviderEndpointProfile {
  endpointId: string;
  upstreamProvider?: string;
  quantization?: string;
  limits: {
    contextTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
  };
  supportedParameters?: ParameterCapability[];
  limitEvidence?: LimitEvidence[];
  sourceEvidence: CapabilitySourceRef[];
}

/** Provider-independent model facts. Provider routing must not be stored here. */
export interface LabModelSpec {
  schemaVersion: number;
  canonicalModelId: string;
  family: string;
  revision?: string;
  releaseDate?: string;
  modalities: { input: Modality[]; output: Modality[] };
  declaredLimits: { contextTokens?: number; maxOutputTokens?: number };
  limitEvidence?: LimitEvidence[];
  limitEvidenceStatus?: "supported" | "conflicting" | "unknown";
  nativeCapabilities: {
    reasoning?: CapabilityObservation;
    tools?: CapabilityObservation;
    structuredOutput?: CapabilityObservation;
    vision?: CapabilityObservation;
    audio?: CapabilityObservation;
  };
  sourceEvidence: CapabilitySourceRef[];
  profileHash: string;
}

/** How one provider hosts a model, including endpoint and protocol differences. */
export interface ProviderModelProfile {
  schemaVersion: number;
  provider: ProviderId;
  canonicalModelId: string;
  providerModelId: string;
  upstreamProvider?: string;
  endpointId?: string;
  protocolProfiles: ProtocolProfile[];
  endpointProfiles?: ProviderEndpointProfile[];
  providerLimits: {
    contextTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
  };
  limitEvidence?: LimitEvidence[];
  limitEvidenceStatus?: "supported" | "conflicting" | "unknown";
  tokenizer?: string;
  quantization?: string;
  pricing?: PricingProfile;
  routingCapabilities?: RoutingCapabilityProfile;
  cacheCapabilities?: CacheCapabilityProfile;
  lifecycle: {
    status: "active" | "deprecated" | "compatibility_only" | "unknown";
    expiresAt?: string;
  };
  sourceEvidence: CapabilitySourceRef[];
  observedEvidence: CapabilityEvidence[];
  profileHash: string;
}

export interface QualificationEvidenceRef {
  artifactId: string;
  capability?: string;
  observedAt?: string;
  notes?: string;
}

/** Harness recommendations are data, not facts about the model. */
export interface HarnessTuningProfile {
  schemaVersion: number;
  modelProfileHash: string;
  status: "provisional" | "qualified" | "experimental";
  outputBudgetPolicy: {
    smoke?: number;
    normalRepoTask?: number;
    longHorizon?: number;
  };
  contextStrategy: {
    strategy: "retrieve" | "repo_map" | "large_context" | "hybrid";
    preferredWorkingSetTokens?: number;
    compactionThreshold?: number;
  };
  reasoningPolicy?: { defaultMode?: string; supportedModes?: string[] };
  toolPolicy?: { maxToolTurns?: number; parallelTools?: boolean };
  editingPolicy?: {
    mode?: "patch" | "diff" | "full_file" | "model_native" | "unknown";
  };
  evidence: QualificationEvidenceRef[];
  profileHash: string;
}

export type Resolution =
  | "pass"
  | "translated"
  | "clamped"
  | "omitted"
  | "rejected";

export interface ResolvedReasoningPolicy {
  requestedEffort?: string;
  effectiveEffort?: string;
  wireParameter?: string;
  resolution: Resolution;
  semanticEffectVerified: boolean | null;
}

export interface ResolvedToolPolicy {
  requested: boolean;
  effective: boolean;
  choice: "auto" | "required" | "specific" | null;
  parallel: boolean;
  resolution: Resolution;
}

export interface ResolvedStructuredOutputPolicy {
  mode: "none" | "json_object" | "json_schema";
  strict: boolean;
  schema?: Record<string, unknown>;
  resolution: Resolution;
}

/** Sampling controls are resolved like every other material request choice. */
export interface ResolvedSamplingPolicy {
  temperature?: {
    requested: number;
    accepted: boolean;
    effective?: number;
    resolution: Resolution;
    semanticEffectVerified: boolean | null;
  };
  topP?: {
    requested: number;
    accepted: boolean;
    effective?: number;
    resolution: Resolution;
    semanticEffectVerified: boolean | null;
  };
  seed?: {
    requested: number;
    accepted: boolean;
    effective?: number;
    resolution: Resolution;
    semanticEffectVerified: boolean | null;
  };
}

/** The policy used to select an upstream through a gateway such as OpenRouter. */
export interface ProviderRoutingPolicy {
  allowFallbacks?: boolean;
  order?: readonly string[];
  requireParameters?: boolean;
  metadataEnabled?: boolean;
  allowContextTransformation?: boolean;
  upstream?: string;
  endpoint?: string;
}

export interface ResolvedRoutingPolicy {
  allowFallbacks: boolean;
  requireParameters: boolean;
  metadataEnabled: boolean;
  order: readonly string[];
  upstream?: string;
  allowContextTransformation: boolean;
  resolution: Resolution;
}

/** All material request choices after capability and affordability resolution. */
export interface ResolvedExecutionEnvelope {
  schemaVersion: number;
  mode: ExecutionMode;
  labModelHash: string;
  providerProfileHash: string;
  harnessProfileHash?: string;
  model: {
    requested: string;
    resolved: string;
    userRequestedModelId: string;
    catalogModelId: string;
    wireModelId: string;
    canonicalRevisionSlug: string;
    aliasUsed: boolean;
    aliasId: string | null;
    aliasTarget: string | null;
  };
  provider: { gateway: ProviderId; upstream?: string; endpoint?: string };
  protocol: ProtocolId;
  context: {
    hardModelLimit?: number;
    providerLimit?: number;
    requestedBudget?: number;
    effectiveBudget?: number;
  };
  output: {
    hardModelLimit?: number;
    providerLimit?: number;
    requested?: number | null;
    effective?: number | null;
    source: string;
    resolution: Resolution;
    evidenceStatus?: "supported" | "conflicting" | "unknown";
  };
  reasoning: ResolvedReasoningPolicy;
  sampling: ResolvedSamplingPolicy;
  tools: ResolvedToolPolicy;
  structuredOutput: ResolvedStructuredOutputPolicy;
  routing: ResolvedRoutingPolicy;
  affordability: {
    status: "within_guardrail" | "blocked" | "unknown";
    estimatedWorstCaseCost?: number;
    estimatedExpectedCost?: number;
  };
  configurationHash: string;
}

export interface ModelRevisionResolution {
  requested: string;
  resolved: string;
  userRequestedModelId: string;
  catalogModelId: string;
  wireModelId: string;
  canonicalRevisionSlug: string;
  aliasUsed: boolean;
  aliasId: string | null;
  aliasTarget: string | null;
  observedAt: string;
  source: "provider_api" | "manual_override" | "already_concrete";
}

export interface ProviderAttempt {
  provider?: string;
  endpoint?: string;
  model?: string;
  status?: number;
}

/** Normalized, content-free provenance from a gateway response. */
export interface OpenRouterExecutionObservation {
  requestedModel: string;
  resolvedModel: string;
  requestedProviderPolicy: ProviderRoutingPolicy;
  selectedUpstream?: string;
  selectedEndpoint?: string;
  attempts: ProviderAttempt[];
  fallbackOccurred: boolean;
  retryOccurred: boolean;
  contextTransformationOccurred: boolean;
  routerPipeline?: unknown;
  rawMetadataHash?: string;
}

export interface EffectiveContextEvidence {
  advertisedHardLimit?: number;
  qualificationPoints: Array<{
    testedTokens: number;
    taskType: string;
    placementPattern?: string;
    outcome: "pass" | "degraded" | "fail";
    score?: number;
    evidenceArtifactId: string;
  }>;
}

export interface ProbeExpectation {
  kind: string;
  [key: string]: unknown;
}

export interface QualificationProbeSpec {
  id: string;
  purpose: string;
  paid: boolean;
  maxCalls: number;
  maxOutputTokens: number;
  requiredCapabilities: string[];
  expectedBehavior: ProbeExpectation;
  stopOnFailure: boolean;
}

export interface QualificationProbeResult {
  probeId: string;
  requestArtifactId: string;
  responseArtifactId?: string;
  actualProvider?: string;
  actualEndpoint?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  capabilityEvidence: CapabilityEvidence[];
  cost?: number;
  status: "pass" | "fail" | "inconclusive" | "blocked";
}

export interface ModelQualificationRecord {
  schemaVersion: number;
  qualificationId: string;
  createdAt: string;
  modelProfileHash: string;
  providerProfileHash: string;
  protocol: ProtocolId;
  upstream?: string;
  harnessVersion: string;
  probes: QualificationProbeResult[];
  declaredCapabilitiesHash: string;
  overallStatus: "qualified" | "partially_qualified" | "failed" | "blocked";
  staleReason?: string;
}

export type FailureAttributionKind =
  | "MODEL_CAPABILITY_FAILURE"
  | "HARNESS_POLICY_CONSTRAINT"
  | "PROVIDER_CAPABILITY_MISMATCH"
  | "PROVIDER_SERVICE_FAILURE"
  | "PROTOCOL_ADAPTER_FAILURE"
  | "PROVIDER_ROUTING_VARIANCE"
  | "BUDGET_GUARDRAIL"
  | "CONTEXT_MANAGEMENT_FAILURE"
  | "VERIFIER_FAILURE"
  | "ENVIRONMENT_FAILURE"
  | "UNKNOWN";

export interface FailureAttribution {
  kind: FailureAttributionKind;
  subcause?:
    | "OUTPUT_BUDGET"
    | "CONTEXT_POLICY"
    | "TOOL_BUDGET"
    | "PROMPT_INTERFACE"
    | "EDIT_INTERFACE";
  evidence: string[];
}

export type ReadinessState =
  | "READY"
  | "INVALID"
  | "UNKNOWN"
  | "DIAGNOSTIC_ONLY"
  | "BLOCKED";

export interface ReadinessDimension {
  status: ReadinessState;
  reason?: string;
}

/** Campaign readiness separates instrumentation from executable comparison validity. */
export interface CampaignReadiness {
  instrumentation: ReadinessDimension;
  execution: ReadinessDimension;
  comparison: ReadinessDimension;
  publication: ReadinessDimension;
}

export interface CampaignFailureSignature {
  provider: string;
  modelProfileHash?: string;
  executionEnvelopeHash?: string;
  httpStatus?: number;
  normalizedFailureClass: string;
  providerErrorCode?: string;
  configurationRelevant: boolean;
  retryableWithoutChange: boolean;
}

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CampaignCircuitBreakerSnapshot {
  state: CircuitBreakerState;
  triggeringFailure?: CampaignFailureSignature;
  affectedExecutionEnvelopeHashes: string[];
  affectedProvider?: string;
  affectedModels: string[];
  cellsPrevented: number;
  estimatedSpendAvoided?: number;
  recoveryCondition: string;
}

export type BudgetExhaustionKind =
  | "HARNESS_OUTPUT_TOKEN_BUDGET_EXHAUSTED"
  | "HARNESS_CONTEXT_BUDGET_EXHAUSTED"
  | "HARNESS_TOOL_TURN_BUDGET_EXHAUSTED"
  | "HARNESS_STEP_BUDGET_EXHAUSTED"
  | "HARNESS_WALLCLOCK_BUDGET_EXHAUSTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_ACCOUNT_CREDIT_INSUFFICIENT"
  | "PROVIDER_REQUEST_AFFORDABILITY_REJECTED"
  | "QUALIFICATION_COST_GUARD_TRIGGERED"
  | "BUDGET_EXHAUSTION_UNKNOWN";

export type Retryability =
  | "retryable_same_request"
  | "retryable_after_delay"
  | "retryable_after_configuration_change"
  | "retryable_after_account_change"
  | "not_retryable";

export interface RetryPolicy {
  maxAttempts: number;
  retryOn: {
    rateLimit: boolean;
    serverError: boolean;
    timeout: boolean;
    transport: boolean;
    streamIdle: boolean;
    affordability: false;
    auth: false;
    invalidParameters: false;
  };
  backoff: {
    strategy: "fixed" | "exponential" | "provider_hint";
    baseMs?: number;
    maxMs?: number;
  };
  modelSubstitutionAllowed: boolean;
  providerSubstitutionAllowed: boolean;
}

export interface AuxiliaryInferencePolicy {
  role: "compaction" | "critic" | "reviewer" | "summarizer" | "verifier";
  modelPolicy:
    | { mode: "inherit_primary" }
    | { mode: "explicit"; providerProfileHash: string }
    | { mode: "disabled" };
  experimentalTreatment:
    | "part_of_primary_treatment"
    | "fixed_control"
    | "out_of_band";
}

export interface TokenCountEstimate {
  tokens: number;
  method:
    | "provider_tokenizer"
    | "model_tokenizer"
    | "provider_reported"
    | "heuristic";
  confidence: "exact" | "high" | "medium" | "low";
  tokenizer?: string;
}

export interface ContextEnvelopeCalculation {
  contextLimit?: number;
  reservedOutputTokens: number;
  reservedReasoningTokens?: number;
  protocolToolOverheadTokens: number;
  safetyMarginTokens: number;
  maximumAdmissibleInputTokens?: number;
}

export interface CompactionTreatmentEvidence {
  algorithm: string;
  model?: string;
  provider?: string;
  protocol?: ProtocolId;
  inputStateHash: string;
  outputSummaryHash?: string;
  targetTokenBudget?: number;
  estimatedTokensRemoved?: number;
  actualTokensRemoved?: number;
  preservedEventIds: string[];
  summarizedEventIds: string[];
  droppedEventIds: string[];
}

export interface AggregateMetric<T> {
  value: T | null;
  validity: "performance_comparable" | "diagnostic_only" | "insufficient_data";
  includedCells: string[];
  excludedCells: string[];
}

export interface CampaignIdentityInputs {
  taskHashes: readonly string[];
  scheduleSeed: string;
  scheduleHash: string;
  babelSha: string;
  runnerSourceHash: string;
  analyzerHash: string;
  packageLockHash: string;
  buildArtifactHash: string;
  labModelProfileHash: string;
  providerModelProfileHash: string;
  protocolProfileHash: string;
  harnessTuningProfileHash: string;
  executionEnvelopeTemplateHash: string;
  routingPolicyHash: string;
  auxiliaryInferencePolicyHash: string;
  tokenEstimationPolicyHash: string;
  qualificationRecordHash: string;
}

export interface ObservationDistribution {
  sampleCount: number;
  p50?: number;
  p95?: number;
  mean?: number;
  unit: "ms" | "tokens_per_second" | "requests_per_minute" | "fraction";
  observedAt?: string;
}

export interface RateLimitEvidence {
  status: "observed" | "not_observed" | "unknown";
  retryAfterObserved?: boolean;
  rateLimitHeadersObserved?: boolean;
  notes?: string;
}

export interface AffordabilityEvidence {
  status: "sufficient" | "insufficient" | "unknown";
  observedAt: string;
  source: "provider_response" | "account_api" | "campaign_guard" | "unknown";
  details?: string;
}

export interface RetrySemantics {
  rateLimit: Retryability;
  serverError: Retryability;
  timeout: Retryability;
  affordability: Retryability;
  auth: Retryability;
}

/** Volatile provider/account observations are kept out of immutable model identity. */
export interface ProviderOperationalProfile {
  schemaVersion: number;
  provider: ProviderId;
  rateLimitEvidence?: RateLimitEvidence;
  affordabilityEvidence?: AffordabilityEvidence;
  retrySemantics: RetrySemantics;
  latencyObservations?: ObservationDistribution;
  throughputObservations?: ObservationDistribution;
  availabilityObservations?: ObservationDistribution;
  lastValidatedAt?: string;
}
