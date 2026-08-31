import { writeFile } from "node:fs/promises";
import { createLabModelSpec, createProviderModelProfile } from "./profiles.js";
import type {
  CapabilityEvidence,
  CapabilityObservation,
  LabModelSpec,
  ProviderModelProfile,
  ProtocolProfile,
  Modality,
  ProviderEndpointProfile,
  LimitEvidence,
} from "./types.js";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_ENDPOINTS_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_NORMALIZER_VERSION = "openrouter-normalizer-v2";

export interface OpenRouterModelEntry {
  id: string;
  canonical_slug?: string;
  alias_target?: { name?: string; slug?: string };
  created?: number;
  context_length?: number;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  supported_parameters?: string[];
  expiration_date?: string | null;
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
    default_effort?: string;
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelEntry[];
}

export interface OpenRouterCatalogSelection {
  entry: OpenRouterModelEntry;
  aliasUsed: boolean;
  aliasId: string | null;
  aliasTarget: string | null;
}

/** Alias selectors are the only requests allowed to resolve through alias_target. */
export function isAliasModelSelector(requestedModel: string): boolean {
  return /(^~|latest|preview|:free|:batch)/i.test(requestedModel.trim());
}

/** Select catalog rows with exact-id precedence over canonical and alias matches. */
export function selectOpenRouterModelEntry(
  entries: readonly OpenRouterModelEntry[],
  requestedModel: string,
): OpenRouterCatalogSelection | undefined {
  const requested = requestedModel.trim();
  const exactId = entries.find((candidate) => candidate.id === requested);
  if (exactId) {
    const aliasUsed = isAliasModelSelector(requested);
    return {
      entry: exactId,
      aliasUsed,
      aliasId: aliasUsed ? exactId.id : null,
      aliasTarget: aliasUsed ? (exactId.alias_target?.slug ?? null) : null,
    };
  }
  const canonical = entries.find(
    (candidate) => candidate.canonical_slug === requested,
  );
  if (canonical) {
    return {
      entry: canonical,
      aliasUsed: false,
      aliasId: null,
      aliasTarget: null,
    };
  }
  if (!isAliasModelSelector(requested)) return undefined;
  const aliasTarget = entries.find(
    (candidate) => candidate.alias_target?.slug === requested,
  );
  return aliasTarget
    ? {
        entry: aliasTarget,
        aliasUsed: true,
        aliasId: aliasTarget.id,
        aliasTarget: aliasTarget.alias_target?.slug ?? null,
      }
    : undefined;
}

function evidence(input: {
  capability: string;
  model: string;
  observedAt: string;
  state?: CapabilityEvidence["state"];
  notes?: string;
}): CapabilityEvidence {
  return {
    capability: input.capability,
    state: input.state ?? "api_advertised",
    provider: "openrouter",
    model: input.model,
    protocol: "chat_completions",
    observedAt: input.observedAt,
    source: "provider_api",
    confidence: "high",
    support: "supported",
    evidenceLevel: input.state === "declared" ? "declared" : "api_advertised",
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

function observation(
  item: OpenRouterModelEntry,
  capability: string,
  observedAt: string,
): CapabilityObservation {
  const supported = item.supported_parameters?.includes(capability) === true;
  return {
    state: supported ? "api_advertised" : "unknown",
    support: supported ? "supported" : "unknown",
    evidenceLevel: "api_advertised",
    confidence: supported ? "high" : "unknown",
    evidence: [evidence({ capability, model: item.id, observedAt })],
  };
}

function unknownObservation(): CapabilityObservation {
  return {
    state: "unknown",
    support: "unknown",
    evidenceLevel: "api_advertised",
    confidence: "unknown",
  };
}

function advertisedObservation(
  capability: string,
  model: string,
  observedAt: string,
): CapabilityObservation {
  return {
    state: "api_advertised",
    support: "supported",
    evidenceLevel: "api_advertised",
    confidence: "high",
    evidence: [evidence({ capability, model, observedAt })],
  };
}

function limitStatus(
  evidence: readonly LimitEvidence[],
): "supported" | "conflicting" | "unknown" {
  const values = evidence
    .map((item) => item.value)
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return "unknown";
  return new Set(values).size > 1 ? "conflicting" : "supported";
}

function catalogLimitEvidence(
  item: OpenRouterModelEntry,
  observedAt: string,
): LimitEvidence[] {
  const source = {
    source: "provider_api" as const,
    uri: OPENROUTER_MODELS_URL,
    retrievedAt: observedAt,
  };
  const result: LimitEvidence[] = [];
  if (item.context_length !== undefined) {
    result.push({
      scope: "gateway",
      claim: "OPENROUTER_GATEWAY_CATALOG_LIMIT",
      field: "contextTokens",
      value: item.context_length,
      source,
      observedAt,
      confidence: "high",
      status: "supported",
    });
  }
  if (item.top_provider?.context_length !== undefined) {
    result.push({
      scope: "top_provider",
      claim: "OPENROUTER_TOP_PROVIDER_LIMIT",
      field: "contextTokens",
      value: item.top_provider.context_length,
      source,
      observedAt,
      confidence: "high",
      status: "supported",
    });
  }
  if (item.top_provider?.max_completion_tokens !== undefined) {
    result.push({
      scope: "top_provider",
      claim: "OPENROUTER_TOP_PROVIDER_LIMIT",
      field: "maxOutputTokens",
      value: item.top_provider.max_completion_tokens,
      source,
      observedAt,
      confidence: "high",
      status: "supported",
    });
  }
  return result;
}

function modality(value: string): Modality {
  if (
    value === "text" ||
    value === "image" ||
    value === "audio" ||
    value === "video" ||
    value === "file"
  ) {
    return value;
  }
  return "unknown";
}

function dateFromUnixSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function numberFromString(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildProtocolProfile(
  item: OpenRouterModelEntry,
  observedAt: string,
): ProtocolProfile {
  const supported = item.supported_parameters ?? [];
  const supportedParameters = supported.map((canonicalParameter) => ({
    canonicalParameter,
    wireParameter: canonicalParameter,
    state: "api_advertised" as const,
    transformation: "identity" as const,
  }));
  const reasoningEnabled =
    item.reasoning !== undefined ||
    supported.includes("reasoning") ||
    supported.includes("reasoning_effort");
  const reasoning: ProtocolProfile["reasoning"] = {
    enabled: {
      state: reasoningEnabled ? "api_advertised" : "unknown",
      support: reasoningEnabled ? "supported" : "unknown",
      evidenceLevel: "api_advertised",
      confidence: reasoningEnabled ? "high" : "unknown",
      evidence: [
        evidence({ capability: "reasoning", model: item.id, observedAt }),
      ],
    },
    ...(item.reasoning?.supported_efforts === undefined
      ? {}
      : { supportedEfforts: [...item.reasoning.supported_efforts] }),
    ...(item.reasoning?.default_effort === undefined
      ? {}
      : { defaultEffort: item.reasoning.default_effort }),
    ...(item.reasoning?.mandatory === undefined
      ? {}
      : { mandatory: item.reasoning.mandatory }),
    mechanism: item.reasoning?.supported_efforts ? "effort" : "unknown",
    semanticEffectEvidence: [],
  };
  const tools = {
    basicTools: observation(item, "tools", observedAt),
    streamingTools: observation(item, "tools", observedAt),
    sequentialTools: observation(item, "tools", observedAt),
    parallelTools: observation(item, "parallel_tool_calls", observedAt),
    toolChoiceAuto: observation(item, "tool_choice", observedAt),
    toolChoiceRequired: observation(item, "tool_choice", observedAt),
    toolChoiceSpecific: observation(item, "tool_choice", observedAt),
    strictArgumentSchema: unknownObservation(),
    reasoningToolInterleave: unknownObservation(),
    reasoningReplayAcrossTurns: unknownObservation(),
    multipleToolRounds: unknownObservation(),
  };
  const structuredOutput = {
    jsonObjectMode: observation(item, "response_format", observedAt),
    jsonSchemaMode: observation(item, "structured_outputs", observedAt),
    strictSchemaEnforcement: unknownObservation(),
    structuredOutputWithTools: unknownObservation(),
    structuredOutputStreaming: unknownObservation(),
  };
  return {
    protocol: "chat_completions",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    streaming: {
      state: "api_advertised",
      support: "supported",
      evidenceLevel: "api_advertised",
      confidence: "high",
      evidence: [
        evidence({ capability: "streaming", model: item.id, observedAt }),
      ],
    },
    reasoning,
    tools,
    structuredOutput,
    supportedParameters,
    qualificationStatus: "unqualified",
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize endpoint-specific metadata without treating it as model-invariant. */
export function normalizeOpenRouterEndpointMetadata(input: {
  modelId: string;
  raw: unknown;
  observedAt?: string;
}): ProviderEndpointProfile[] {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const root = objectValue(input.raw);
  const data = root?.data;
  const dataObject = objectValue(data);
  const endpointValues = Array.isArray(data)
    ? data
    : Array.isArray(dataObject?.endpoints)
      ? dataObject.endpoints
      : Array.isArray(root?.endpoints)
        ? root.endpoints
        : [];
  return endpointValues.flatMap((value, index) => {
    const item = objectValue(value);
    if (!item) return [];
    const provider = stringValue(item.provider_name);
    const tag = stringValue(item.tag);
    const name = stringValue(item.name);
    const endpointId =
      tag ?? name ?? `${provider ?? "unknown-provider"}:${index}`;
    const supported = Array.isArray(item.supported_parameters)
      ? item.supported_parameters.filter(
          (parameter): parameter is string => typeof parameter === "string",
        )
      : [];
    const sourceEvidence = [
      {
        source: "provider_api" as const,
        uri: `${OPENROUTER_ENDPOINTS_URL}/${input.modelId}/endpoints`,
        retrievedAt: observedAt,
      },
    ];
    const contextTokens = numberValue(item.context_length);
    const maxPromptTokens = numberValue(item.max_prompt_tokens);
    const maxOutputTokens = numberValue(item.max_completion_tokens);
    const quantization = stringValue(item.quantization);
    const limitEvidence: LimitEvidence[] = [];
    for (const [field, value] of [
      ["contextTokens", contextTokens],
      ["maxPromptTokens", maxPromptTokens],
      ["maxOutputTokens", maxOutputTokens],
    ] as const) {
      if (value === undefined) continue;
      limitEvidence.push({
        scope: "endpoint",
        claim: "EXACT_UPSTREAM_ENDPOINT_LIMIT",
        field,
        value,
        source: sourceEvidence[0]!,
        observedAt,
        confidence: "high",
        status: "supported",
      });
    }
    return [
      {
        endpointId,
        ...(provider === undefined ? {} : { upstreamProvider: provider }),
        ...(quantization === undefined ? {} : { quantization }),
        limits: {
          ...(contextTokens === undefined ? {} : { contextTokens }),
          ...(maxPromptTokens === undefined ? {} : { maxPromptTokens }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        },
        ...(supported.length === 0
          ? {}
          : {
              supportedParameters: supported.map((parameter) => ({
                canonicalParameter: parameter,
                wireParameter: parameter,
                state: "api_advertised" as const,
                transformation: "identity" as const,
              })),
            }),
        limitEvidence,
        sourceEvidence,
      },
    ];
  });
}

/** Attach endpoint variants to a provider-hosted profile and rederive its hash. */
export function attachOpenRouterEndpointMetadata(
  profile: ProviderModelProfile,
  input: { raw: unknown; observedAt?: string },
): ProviderModelProfile {
  return createProviderModelProfile({
    ...profile,
    endpointProfiles: normalizeOpenRouterEndpointMetadata({
      modelId: profile.providerModelId,
      raw: input.raw,
      ...(input.observedAt === undefined
        ? {}
        : { observedAt: input.observedAt }),
    }),
  });
}

/** Normalize one OpenRouter catalog entry into separate model and hosted profiles. */
export function normalizeOpenRouterModelMetadata(input: {
  requestedModel: string;
  entry: OpenRouterModelEntry;
  observedAt?: string;
}): {
  requestedModel: string;
  resolvedModel: string;
  catalogModelId: string;
  canonicalRevisionSlug: string;
  aliasUsed: boolean;
  aliasId: string | null;
  aliasTarget: string | null;
  labModel: LabModelSpec;
  providerProfile: ProviderModelProfile;
} {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const item = input.entry;
  const requestedModel = input.requestedModel.trim();
  const aliasUsed = isAliasModelSelector(requestedModel);
  const canonicalRevisionSlug =
    item.alias_target?.slug ?? item.canonical_slug ?? item.id;
  // A concrete request remains concrete. Canonical slugs are retained as
  // descriptive metadata, never used to replace the wire identity.
  const resolvedModel = aliasUsed
    ? canonicalRevisionSlug
    : item.id === requestedModel || item.canonical_slug === requestedModel
      ? requestedModel
      : item.id;
  const limits = catalogLimitEvidence(item, observedAt);
  const revision = canonicalRevisionSlug.includes("-")
    ? canonicalRevisionSlug.split("-").at(-1)
    : undefined;
  const releaseDate = dateFromUnixSeconds(item.created);
  const inputPerToken = numberFromString(item.pricing?.prompt);
  const outputPerToken = numberFromString(item.pricing?.completion);
  const cacheReadPerToken = numberFromString(item.pricing?.input_cache_read);
  const cacheWritePerToken = numberFromString(item.pricing?.input_cache_write);
  const modalities = item.architecture?.input_modalities ?? ["text"];
  const outputs = item.architecture?.output_modalities ?? ["text"];
  const modelEvidence = [
    evidence({
      capability: "model_metadata",
      model: resolvedModel,
      observedAt,
    }),
    ...(item.reasoning
      ? [
          evidence({
            capability: "reasoning",
            model: resolvedModel,
            observedAt,
          }),
        ]
      : []),
  ];
  const labModel = createLabModelSpec({
    schemaVersion: 1,
    canonicalModelId: canonicalRevisionSlug,
    family: canonicalRevisionSlug.split("/")[0] ?? "unknown",
    ...(revision === undefined ? {} : { revision }),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    modalities: {
      input: modalities.map(modality),
      output: outputs.map(modality),
    },
    declaredLimits: {},
    limitEvidence: limits,
    limitEvidenceStatus: limitStatus(limits),
    nativeCapabilities: {
      ...(item.reasoning
        ? {
            reasoning: {
              ...advertisedObservation("reasoning", resolvedModel, observedAt),
              evidence: modelEvidence,
            },
          }
        : {}),
      ...(item.supported_parameters?.includes("tools")
        ? {
            tools: advertisedObservation("tools", resolvedModel, observedAt),
          }
        : {}),
      ...(item.supported_parameters?.includes("response_format")
        ? {
            structuredOutput: advertisedObservation(
              "structured_output",
              resolvedModel,
              observedAt,
            ),
          }
        : {}),
      ...(modalities.includes("image")
        ? {
            vision: advertisedObservation("vision", resolvedModel, observedAt),
          }
        : {}),
      ...(modalities.includes("audio")
        ? {
            audio: advertisedObservation("audio", resolvedModel, observedAt),
          }
        : {}),
    },
    sourceEvidence: [
      {
        source: "provider_api",
        uri: OPENROUTER_MODELS_URL,
        retrievedAt: observedAt,
      },
    ],
  });
  const protocolProfile = buildProtocolProfile(item, observedAt);
  const providerProfile = createProviderModelProfile({
    schemaVersion: 1,
    provider: "openrouter",
    canonicalModelId: canonicalRevisionSlug,
    providerModelId: item.id,
    protocolProfiles: [protocolProfile],
    providerLimits: {
      ...(item.top_provider?.context_length === undefined
        ? {}
        : { contextTokens: item.top_provider.context_length }),
      ...(item.top_provider?.max_completion_tokens === undefined
        ? {}
        : { maxOutputTokens: item.top_provider.max_completion_tokens }),
    },
    limitEvidence: limits,
    limitEvidenceStatus: limitStatus(limits),
    ...(item.architecture?.tokenizer
      ? { tokenizer: item.architecture.tokenizer }
      : {}),
    pricing: {
      ...(inputPerToken === undefined ? {} : { inputPerToken }),
      ...(outputPerToken === undefined ? {} : { outputPerToken }),
      ...(cacheReadPerToken === undefined ? {} : { cacheReadPerToken }),
      ...(cacheWritePerToken === undefined ? {} : { cacheWritePerToken }),
    },
    routingCapabilities: {
      supportsProviderOrder: advertisedObservation(
        "provider.order",
        item.id,
        observedAt,
      ),
      supportsFallbackControl: advertisedObservation(
        "provider.allow_fallbacks",
        item.id,
        observedAt,
      ),
      supportsRequireParameters: advertisedObservation(
        "provider.require_parameters",
        item.id,
        observedAt,
      ),
      supportsRouterMetadata: advertisedObservation(
        "router_metadata",
        item.id,
        observedAt,
      ),
    },
    cacheCapabilities: {
      supportsPromptCaching: item.pricing?.input_cache_read
        ? advertisedObservation("prompt_caching", item.id, observedAt)
        : unknownObservation(),
      reportsCacheHitTokens: unknownObservation(),
      reportsCacheMissTokens: unknownObservation(),
    },
    lifecycle: {
      status:
        item.expiration_date &&
        new Date(item.expiration_date).getTime() < Date.now()
          ? "deprecated"
          : "active",
      ...(item.expiration_date ? { expiresAt: item.expiration_date } : {}),
    },
    sourceEvidence: [
      {
        source: "provider_api",
        uri: OPENROUTER_MODELS_URL,
        retrievedAt: observedAt,
      },
    ],
    observedEvidence: [],
  });
  return {
    requestedModel,
    resolvedModel,
    catalogModelId: item.id,
    canonicalRevisionSlug,
    aliasUsed,
    aliasId: aliasUsed ? item.id : null,
    aliasTarget: aliasUsed ? canonicalRevisionSlug : null,
    labModel,
    providerProfile,
  };
}

/** Fetch current public catalog metadata; endpoint details remain optional and explicit. */
export async function fetchOpenRouterModelMetadata(input: {
  requestedModel: string;
  fetchImpl?: typeof fetch;
  observedAt?: string;
}): Promise<ReturnType<typeof normalizeOpenRouterModelMetadata>> {
  const response = await (input.fetchImpl ?? fetch)(OPENROUTER_MODELS_URL);
  if (!response.ok)
    throw new Error(
      `OpenRouter metadata request failed with HTTP ${response.status}.`,
    );
  const body = (await response.json()) as OpenRouterModelsResponse;
  const requested = input.requestedModel;
  const selection = selectOpenRouterModelEntry(body.data ?? [], requested);
  if (!selection)
    throw new Error(
      `OpenRouter metadata did not contain model "${requested}".`,
    );
  return normalizeOpenRouterModelMetadata({
    requestedModel: requested,
    entry: selection.entry,
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
  });
}

/** Fetch endpoint-specific limits and parameters when the caller has access. */
export async function fetchOpenRouterEndpointMetadata(input: {
  modelId: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const [author, ...slugParts] = input.modelId.split("/");
  const slug = slugParts.join("/");
  if (!author || !slug)
    throw new Error(
      `OpenRouter endpoint lookup requires an author/model id: ${input.modelId}.`,
    );
  const response = await (input.fetchImpl ?? fetch)(
    `${OPENROUTER_ENDPOINTS_URL}/${author}/${slug}/endpoints`,
  );
  if (!response.ok)
    throw new Error(
      `OpenRouter endpoint metadata request failed with HTTP ${response.status}.`,
    );
  return response.json();
}

/** Persist a timestamped, credential-free normalized snapshot for reproducible audits. */
export async function writeOpenRouterMetadataSnapshot(input: {
  path: string;
  retrievedAt: string;
  models: readonly ReturnType<typeof normalizeOpenRouterModelMetadata>[];
  endpointMetadata?: unknown;
}): Promise<void> {
  await writeFile(
    input.path,
    JSON.stringify(
      {
        schemaVersion: 1,
        retrievedAt: input.retrievedAt,
        source: OPENROUTER_MODELS_URL,
        models: input.models,
        ...(input.endpointMetadata === undefined
          ? {}
          : { endpointMetadata: input.endpointMetadata }),
      },
      null,
      2,
    ),
    "utf8",
  );
}
