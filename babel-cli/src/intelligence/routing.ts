import { hashCanonical } from "./hash.js";
import type {
  OpenRouterExecutionObservation,
  ProviderAttempt,
  ProviderRoutingPolicy,
  ExecutionMode,
} from "./types.js";

interface RawRouterMetadata {
  provider?: string;
  model?: string;
  endpoints?: {
    available?: Array<{
      provider?: string;
      model?: string;
      selected?: boolean;
      endpoint?: string;
    }>;
  };
  attempts?: Array<{
    provider?: string;
    model?: string;
    status?: number;
    endpoint?: string;
  }>;
  route?: unknown;
  pipeline?: unknown;
  context_transformation?: boolean;
}

type RawAttempt = {
  provider?: string;
  model?: string;
  status?: number;
  endpoint?: string;
};

function normalizeAttempt(value: RawAttempt): ProviderAttempt {
  return {
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.endpoint === "string" ? { endpoint: value.endpoint } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
  };
}

/** Normalize gateway metadata while retaining only content-free routing fields. */
export function normalizeOpenRouterExecutionObservation(input: {
  requestedModel: string;
  resolvedModel: string;
  requestedProviderPolicy: ProviderRoutingPolicy;
  response: unknown;
  routerMetadataRequired?: boolean;
}): OpenRouterExecutionObservation {
  const response =
    input.response && typeof input.response === "object"
      ? (input.response as {
          provider?: unknown;
          model?: unknown;
          openrouter_metadata?: RawRouterMetadata;
        })
      : {};
  const metadata = response.openrouter_metadata;
  const attempts = (metadata?.attempts ?? []).map(normalizeAttempt);
  const available = metadata?.endpoints?.available ?? [];
  const selected = available.find((item) => item.selected === true);
  const selectedUpstream =
    (typeof response.provider === "string" ? response.provider : undefined) ??
    (typeof selected?.provider === "string" ? selected.provider : undefined) ??
    attempts.find((item) => item.status === 200)?.provider;
  const fallbackOccurred =
    attempts.filter((attempt) => attempt.status !== 200).length > 0 ||
    attempts.length > 1;
  const retryOccurred = attempts.length > 1;
  const contextTransformationOccurred =
    metadata?.context_transformation === true;
  const sanitized = {
    ...(metadata === undefined ? {} : { metadata }),
    selectedUpstream,
    attempts,
  };
  if (input.routerMetadataRequired && metadata === undefined) {
    throw new Error(
      "OpenRouter router metadata is required for this strict observation.",
    );
  }
  return {
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    requestedProviderPolicy: { ...input.requestedProviderPolicy },
    ...(selectedUpstream === undefined ? {} : { selectedUpstream }),
    ...(typeof selected?.endpoint === "string"
      ? { selectedEndpoint: selected.endpoint }
      : {}),
    attempts,
    fallbackOccurred,
    retryOccurred,
    contextTransformationOccurred,
    ...(metadata?.pipeline === undefined && metadata?.route === undefined
      ? {}
      : { routerPipeline: metadata.pipeline ?? metadata.route }),
    rawMetadataHash: hashCanonical(sanitized),
  };
}

/** Enforce strict benchmark routing against the actual gateway observation. */
export function validateOpenRouterExecutionObservation(input: {
  mode: ExecutionMode;
  requestedUpstream?: string;
  observation: OpenRouterExecutionObservation;
}): { valid: true } {
  const { observation } = input;
  if (input.mode !== "benchmark_strict") return { valid: true };
  if (!observation.rawMetadataHash)
    throw new Error("Strict routing observation has no metadata hash.");
  if (!observation.selectedUpstream)
    throw new Error("Strict routing observation has no selected upstream.");
  if (
    input.requestedUpstream &&
    observation.selectedUpstream !== input.requestedUpstream
  ) {
    throw new Error(
      `campaign-invalid: requested upstream ${input.requestedUpstream}, received ${observation.selectedUpstream}.`,
    );
  }
  if (observation.fallbackOccurred)
    throw new Error("campaign-invalid: OpenRouter fallback occurred.");
  if (observation.contextTransformationOccurred) {
    throw new Error(
      "campaign-invalid: OpenRouter context transformation occurred.",
    );
  }
  return { valid: true };
}
