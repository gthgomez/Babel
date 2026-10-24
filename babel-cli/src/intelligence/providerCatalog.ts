/**
 * Two-provider model route resolution from official public catalogs.
 *
 * `refreshProviderCatalogs` fetches fresh snapshots; `resolveModelRoute` is a
 * pure mapping from a Babel selector key to one catalog-evidenced route.
 * Missing, ambiguous, or unsupported selections fail explicitly — the resolver
 * never substitutes another family, provider, or cheaper fallback, and catalog
 * data can never change which credential a route uses.
 */
import { createHash } from "node:crypto";
import {
  RouteResolutionError,
  type ModelRouteProtocol,
  type ResolvedModelRoute,
  type RouteCapabilityEvidence,
  type RouteProviderId,
} from "./types.js";
import {
  COMMANDCODE_MODELS_URL,
  fetchCommandCodeCatalog,
  type CommandCodeCatalogSnapshot,
} from "./commandCodeMetadata.js";

export const OPENROUTER_MODELS_URL =
  "https://openrouter.ai/api/v1/models" as const;
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1" as const;

export interface OpenRouterCatalogEntry {
  id: string;
  canonicalSlug: string | null;
  created: number | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
}

export interface OpenRouterCatalogSnapshot {
  provider: "openrouter";
  url: string;
  fetchedAt: string;
  sha256: string;
  entries: OpenRouterCatalogEntry[];
}

/** The catalogs a selector family needs, addressable by provider identity. */
export type ProviderCatalogSet = {
  openrouter?: OpenRouterCatalogSnapshot | undefined;
  commandcode?: CommandCodeCatalogSnapshot | undefined;
};

/** The five requested families, one route per provider. */
export const REQUESTED_SELECTOR_KEYS = [
  "deepseek-v4.1-flash-latest-openrouter",
  "deepseek-v4.1-flash-latest-commandcode",
  "glm-5.3-flash-openrouter",
  "glm-5.3-flash-commandcode",
  "mimo-v2.6-flash-openrouter",
  "mimo-v2.6-flash-commandcode",
  "gpt-6-luna-openrouter",
  "gpt-6-luna-commandcode",
  "claude-haiku-5.5-openrouter",
  "claude-haiku-5.5-commandcode",
] as const;

/** Credential references are fixed by provider identity, never by catalog data. */
const ROUTE_CREDENTIAL_ENV_VARS: Readonly<
  Record<RouteProviderId, "OPENROUTER_API_KEY" | "CMD_API_KEY">
> = Object.freeze({
  openrouter: "OPENROUTER_API_KEY",
  commandcode: "CMD_API_KEY",
});

/** Fixed public API bases; a catalog cannot relocate a gateway. */
const ROUTE_API_BASES: Readonly<Record<RouteProviderId, string>> =
  Object.freeze({
    openrouter: OPENROUTER_API_BASE,
    commandcode: "https://api.commandcode.ai/provider/v1",
  });

interface CatalogModelEntryLike {
  id: string;
  canonicalRevision: string | null;
  created: number | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
  supportedEndpoints: readonly string[];
}

/** Exact catalog identifiers for the four non-latest families. */
const EXACT_MODEL_IDS: Readonly<
  Record<string, { openrouter: string; commandcode: string }>
> = Object.freeze({
  "glm-5.3-flash": {
    openrouter: "z-ai/glm-5.3-flash",
    commandcode: "z-ai/glm-5.3-flash",
  },
  "mimo-v2.6-flash": {
    openrouter: "xiaomi/mimo-v2.6-flash",
    commandcode: "xiaomi/mimo-v2.6-flash",
  },
  "gpt-6-luna": {
    openrouter: "openai/gpt-6-luna",
    commandcode: "gpt-6-luna",
  },
  "claude-haiku-5.5": {
    openrouter: "anthropic/claude-haiku-5.5",
    commandcode: "claude-haiku-5-5",
  },
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Parse the OpenRouter public models response into the shared entry shape. */
export function parseOpenRouterCatalog(
  body: string,
  options: { url?: string; fetchedAt?: string } = {},
): OpenRouterCatalogSnapshot {
  let payload: { data?: unknown };
  try {
    payload = JSON.parse(body) as { data?: unknown };
  } catch {
    throw new Error("OpenRouter catalog response was not valid JSON.");
  }
  if (!Array.isArray(payload.data)) {
    throw new Error("OpenRouter catalog is missing its `data` array.");
  }
  const entries: OpenRouterCatalogEntry[] = [];
  for (const raw of payload.data) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as {
      id?: unknown;
      canonical_slug?: unknown;
      created?: unknown;
      context_length?: unknown;
      top_provider?: { max_completion_tokens?: unknown } | null;
    };
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    entries.push({
      id: record.id,
      canonicalSlug:
        typeof record.canonical_slug === "string" && record.canonical_slug
          ? record.canonical_slug
          : null,
      created:
        typeof record.created === "number" && Number.isFinite(record.created)
          ? record.created
          : null,
      contextLength:
        typeof record.context_length === "number" &&
        Number.isFinite(record.context_length)
          ? record.context_length
          : null,
      maxOutputTokens:
        typeof record.top_provider?.max_completion_tokens === "number" &&
        Number.isFinite(record.top_provider.max_completion_tokens)
          ? record.top_provider.max_completion_tokens
          : null,
    });
  }
  return {
    provider: "openrouter",
    url: options.url ?? OPENROUTER_MODELS_URL,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    sha256: sha256(body),
    entries,
  };
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const composite = signal
    ? AbortSignal.any([timeout, signal])
    : timeout;
  return fetch(url, { signal: composite, headers: { accept: "application/json" } });
}

/** Fetch the OpenRouter public catalog with a bounded timeout. */
export async function fetchOpenRouterCatalog(input: {
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => Date) | undefined;
}): Promise<OpenRouterCatalogSnapshot> {
  const fetchedAt = (input.now ?? (() => new Date()))().toISOString();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const response = input.fetchImpl
    ? await input.fetchImpl(OPENROUTER_MODELS_URL, {
        signal: input.signal ?? AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      })
    : await fetchWithTimeout(OPENROUTER_MODELS_URL, timeoutMs, input.signal);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenRouter catalog request failed (HTTP ${response.status}).`,
    );
  }
  const snapshot = parseOpenRouterCatalog(body, {
    url: OPENROUTER_MODELS_URL,
    fetchedAt,
  });
  if (snapshot.entries.length === 0) {
    throw new Error("OpenRouter catalog contained no parseable model entries.");
  }
  return snapshot;
}

/** Refresh one or both official public catalogs; each fetch is independent. */
export async function refreshProviderCatalogs(input: {
  providers: readonly RouteProviderId[];
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => Date) | undefined;
  timeoutMs?: number | undefined;
}): Promise<ProviderCatalogSet> {
  const set: ProviderCatalogSet = {};
  const results = await Promise.allSettled(
    input.providers.map((provider) =>
      provider === "openrouter"
        ? fetchOpenRouterCatalog({
            fetchImpl: input.fetchImpl,
            signal: input.signal,
            now: input.now,
          })
        : fetchCommandCodeCatalog({ fetchImpl: input.fetchImpl, now: input.now }),
    ),
  );
  results.forEach((result, index) => {
    const provider = input.providers[index]!;
    if (result.status === "fulfilled") {
      if (provider === "openrouter")
        set.openrouter = result.value as OpenRouterCatalogSnapshot;
      else set.commandcode = result.value as CommandCodeCatalogSnapshot;
      return;
    }
    throw new Error(
      `Failed to refresh ${provider} catalog: ${String(
        result.reason instanceof Error ? result.reason.message : result.reason,
      )}`,
    );
  });
  return set;
}

function entryFromSnapshot(
  snapshot: OpenRouterCatalogSnapshot | CommandCodeCatalogSnapshot,
  modelId: string,
): CatalogModelEntryLike | null {
  if (snapshot.provider === "openrouter") {
    const entry = (snapshot as OpenRouterCatalogSnapshot).entries.find(
      (candidate) => candidate.id === modelId,
    );
    if (!entry) return null;
    return {
      id: entry.id,
      canonicalRevision: entry.canonicalSlug,
      created: entry.created,
      contextLength: entry.contextLength,
      maxOutputTokens: entry.maxOutputTokens,
      supportedEndpoints: ["/chat/completions"],
    };
  }
  const entry = (snapshot as CommandCodeCatalogSnapshot).entries.find(
    (candidate) => candidate.id === modelId,
  );
  if (!entry) return null;
  return {
    id: entry.id,
    canonicalRevision: null,
    created: entry.createdAt,
    contextLength: entry.contextLength,
    maxOutputTokens: null,
    supportedEndpoints: entry.supportedEndpoints,
  };
}

/**
 * Resolve the OpenRouter latest DeepSeek V4.1 Flash revision: filter to the
 * exact family and standard routes, exclude V4, Pro, FlashX/Fast, free, batch,
 * and router entries, then select the newest unambiguous revision by catalog
 * creation time. Ambiguous or missing evidence fails selection.
 */
export function selectLatestOpenRouterDeepSeekV41Flash(
  snapshot: OpenRouterCatalogSnapshot,
): CatalogModelEntryLike {
  const familyPrefix = "deepseek/deepseek-v4.1-flash";
  const candidates = snapshot.entries.filter((entry) => {
    if (!entry.id.startsWith(familyPrefix)) return false;
    if (entry.id.startsWith("~")) return false; // router aliases are separate entries
    if (entry.id.includes(":")) return false; // batch/free/router variants
    if (/(flashx|fast|free|pro)/i.test(entry.id)) return false;
    return true;
  });
  if (candidates.length === 0) {
    throw new RouteResolutionError(
      "model_missing_from_catalog",
      "deepseek-v4.1-flash-latest-openrouter",
      "no DeepSeek V4.1 Flash family entries in the OpenRouter catalog",
    );
  }
  const dated = candidates.filter((entry) => entry.created !== null);
  if (dated.length === 0) {
    throw new RouteResolutionError(
      "ambiguous_latest_revision",
      "deepseek-v4.1-flash-latest-openrouter",
      "family entries carry no creation timestamps",
    );
  }
  const newest = Math.max(...dated.map((entry) => entry.created!));
  const newestEntries = dated.filter((entry) => entry.created === newest);
  if (newestEntries.length !== 1) {
    throw new RouteResolutionError(
      "ambiguous_latest_revision",
      "deepseek-v4.1-flash-latest-openrouter",
      `${newestEntries.length} entries share the newest revision timestamp`,
    );
  }
  const selected = newestEntries[0]!;
  return {
    id: selected.id,
    canonicalRevision: selected.canonicalSlug,
    created: selected.created,
    contextLength: selected.contextLength,
    maxOutputTokens: selected.maxOutputTokens,
    supportedEndpoints: ["/chat/completions"],
  };
}

function protocolFor(
  provider: RouteProviderId,
  supportedEndpoints: readonly string[],
  modelId: string,
): ModelRouteProtocol {
  if (provider === "openrouter") return "chat_completions";
  if (supportedEndpoints.includes("/messages")) return "anthropic_messages";
  if (supportedEndpoints.includes("/chat/completions"))
    return "chat_completions";
  throw new RouteResolutionError(
    "endpoint_unsupported",
    modelId,
    `catalog lists no supported gateway endpoint for ${modelId}`,
  );
}

function parseSelectorKey(selectorKey: string): {
  family: string;
  provider: RouteProviderId;
} {
  for (const provider of ["openrouter", "commandcode"] as const) {
    const suffix = `-${provider}`;
    if (selectorKey.endsWith(suffix)) {
      return { family: selectorKey.slice(0, -suffix.length), provider };
    }
  }
  throw new RouteResolutionError(
    "unknown_selector_key",
    selectorKey,
    "selector keys must end in -openrouter or -commandcode",
  );
}

function routeHash(route: {
  selectorKey: string;
  provider: RouteProviderId;
  modelId: string;
  protocol: ModelRouteProtocol;
  apiBase: string;
  canonicalRevision: string | null;
  catalogSha256: string;
}): string {
  return sha256(
    JSON.stringify([
      route.selectorKey,
      route.provider,
      route.modelId,
      route.protocol,
      route.apiBase,
      route.canonicalRevision,
      route.catalogSha256,
    ]),
  );
}

/**
 * Pure resolution of one selector key against loaded catalogs. Throws a
 * `RouteResolutionError` with an explicit reason instead of substituting.
 */
export function resolveModelRoute(
  selectorKey: string,
  catalogs: ProviderCatalogSet,
  _resolvedAt: string,
): ResolvedModelRoute {
  const { family, provider } = parseSelectorKey(selectorKey);
  const snapshot = catalogs[provider];
  if (!snapshot) {
    throw new RouteResolutionError(
      "catalog_not_loaded",
      selectorKey,
      `the ${provider} catalog was not loaded`,
    );
  }

  let modelId: string;
  let revisionKind: ResolvedModelRoute["revisionKind"];
  let canonicalRevision: string | null;
  let entry: CatalogModelEntryLike | null;

  if (family === "deepseek-v4.1-flash-latest") {
    if (provider === "openrouter") {
      const selected = selectLatestOpenRouterDeepSeekV41Flash(snapshot as OpenRouterCatalogSnapshot);
      modelId = selected.id;
      canonicalRevision = selected.canonicalRevision;
      revisionKind = "dated_id";
      entry = selected;
    } else {
      // The exact V4.1 latest alias currently in the Command Code catalog;
      // its concrete revision is unknown unless stronger evidence arrives.
      modelId = "deepseek/deepseek-v4.1-flash";
      canonicalRevision = null;
      revisionKind = "provider_alias";
      entry = entryFromSnapshot(snapshot, modelId);
      if (!entry) {
        throw new RouteResolutionError(
          "model_missing_from_catalog",
          selectorKey,
          `expected latest alias ${modelId} is absent from the Command Code catalog`,
        );
      }
    }
  } else {
    const exact = EXACT_MODEL_IDS[family];
    if (!exact) {
      throw new RouteResolutionError(
        "unknown_selector_key",
        selectorKey,
        `family ${family} is not one of the requested selection families`,
      );
    }
    modelId = exact[provider];
    revisionKind = "catalog_id";
    entry = entryFromSnapshot(snapshot, modelId);
    if (!entry) {
      throw new RouteResolutionError(
        "model_missing_from_catalog",
        selectorKey,
        `${modelId} is not present in the ${provider} catalog`,
      );
    }
    canonicalRevision = entry.canonicalRevision;
  }

  const protocol = protocolFor(provider, entry.supportedEndpoints, modelId);
  const capabilities: RouteCapabilityEvidence = {
    contextLength: entry.contextLength,
    maxOutputTokens: entry.maxOutputTokens,
    supportedEndpoints: [...entry.supportedEndpoints],
    source: "official_catalog",
  };
  return {
    selectorKey,
    provider,
    modelId,
    protocol,
    apiBase: ROUTE_API_BASES[provider],
    canonicalRevision,
    revisionKind,
    catalog: {
      url: snapshot.url,
      fetchedAt: snapshot.fetchedAt,
      sha256: snapshot.sha256,
    },
    capabilities,
    routeHash: routeHash({
      selectorKey,
      provider,
      modelId,
      protocol,
      apiBase: ROUTE_API_BASES[provider],
      canonicalRevision,
      catalogSha256: snapshot.sha256,
    }),
    credentialEnvVar: ROUTE_CREDENTIAL_ENV_VARS[provider],
  };
}

/** Resolve all ten requested selector keys; any failure aborts the whole set. */
export function resolveRequestedRoutes(
  catalogs: ProviderCatalogSet,
  resolvedAt: string,
): ResolvedModelRoute[] {
  return REQUESTED_SELECTOR_KEYS.map((key) =>
    resolveModelRoute(key, catalogs, resolvedAt),
  );
}

/**
 * Build a route from a frozen model-policy selection without a network fetch.
 *
 * The campaign pins its ten routes into `config/model-policy.json`; this maps
 * one pinned selection back onto the shared `ResolvedModelRoute` contract so
 * the chat runtime can construct the exact transport for a policy-selected
 * backend. Evidence is marked `policy_pinned` and must never be described as
 * a freshly verified catalog resolution. The pinned model id is validated
 * against the same exact-family identities the catalog resolver enforces — a
 * stale or wrong pin fails explicitly instead of dispatching to another model.
 */
export function routeFromPolicySelection(input: {
  selectorKey: string;
  provider: RouteProviderId;
  modelId: string;
  sourceUrl: string | null;
  verifiedAt: string | null;
  contextLength: number | null;
  maxOutputTokens: number | null;
}): ResolvedModelRoute {
  const { family, provider } = parseSelectorKey(input.selectorKey);
  if (provider !== input.provider) {
    throw new RouteResolutionError(
      "unknown_selector_key",
      input.selectorKey,
      `selector key declares provider ${provider} but the policy entry says ${input.provider}`,
    );
  }
  if (!(REQUESTED_SELECTOR_KEYS as readonly string[]).includes(input.selectorKey)) {
    throw new RouteResolutionError(
      "unknown_selector_key",
      input.selectorKey,
      "only the ten campaign selector keys may be resolved from policy pins",
    );
  }

  let canonicalRevision: string | null = null;
  let revisionKind: ResolvedModelRoute["revisionKind"];
  if (family === "deepseek-v4.1-flash-latest") {
    if (provider === "commandcode") {
      if (input.modelId !== "deepseek/deepseek-v4.1-flash") {
        throw new RouteResolutionError(
          "model_missing_from_catalog",
          input.selectorKey,
          `pinned Command Code latest alias must be deepseek/deepseek-v4.1-flash, got ${input.modelId}`,
        );
      }
      revisionKind = "provider_alias";
    } else {
      // The pinned OpenRouter id must still satisfy the family-latest filter.
      const valid = input.modelId.startsWith("deepseek/deepseek-v4.1-flash") &&
        !input.modelId.startsWith("~") &&
        !input.modelId.includes(":") &&
        !/(flashx|fast|free|pro)/i.test(input.modelId);
      if (!valid) {
        throw new RouteResolutionError(
          "ambiguous_latest_revision",
          input.selectorKey,
          `pinned model ${input.modelId} is not an unambiguous V4.1 Flash family revision`,
        );
      }
      revisionKind = "dated_id";
    }
  } else {
    const exact = EXACT_MODEL_IDS[family];
    if (!exact || input.modelId !== exact[provider]) {
      throw new RouteResolutionError(
        "model_missing_from_catalog",
        input.selectorKey,
        `pinned model ${input.modelId} does not match the exact ${family} identity for ${provider}`,
      );
    }
    revisionKind = "catalog_id";
  }

  const protocol: ModelRouteProtocol =
    provider === "openrouter"
      ? "chat_completions"
      : family === "claude-haiku-5.5"
        ? "anthropic_messages"
        : "chat_completions";

  return {
    selectorKey: input.selectorKey,
    provider,
    modelId: input.modelId,
    protocol,
    apiBase: ROUTE_API_BASES[provider],
    canonicalRevision,
    revisionKind,
    catalog: {
      url: input.sourceUrl ?? ROUTE_API_BASES[provider],
      fetchedAt: input.verifiedAt ?? "",
      sha256: sha256(
        JSON.stringify([
          "policy_pinned",
          input.selectorKey,
          input.modelId,
          input.sourceUrl,
          input.verifiedAt,
        ]),
      ),
    },
    capabilities: {
      contextLength: input.contextLength,
      maxOutputTokens: input.maxOutputTokens,
      supportedEndpoints:
        protocol === "anthropic_messages" ? ["/messages"] : ["/chat/completions"],
      source: "policy_pinned",
    },
    routeHash: routeHash({
      selectorKey: input.selectorKey,
      provider,
      modelId: input.modelId,
      protocol,
      apiBase: ROUTE_API_BASES[provider],
      canonicalRevision,
      catalogSha256: sha256(
        JSON.stringify([
          "policy_pinned",
          input.selectorKey,
          input.modelId,
          input.sourceUrl,
          input.verifiedAt,
        ]),
      ),
    }),
    credentialEnvVar: ROUTE_CREDENTIAL_ENV_VARS[provider],
  };
}

/**
 * Reverse lookup: the unique campaign selector key whose pinned identity is
 * this provider/model pair, or null when the pair is not one of the ten
 * campaign routes. Used to bind auxiliary calls (critic, repair) to the exact
 * selected route instead of model-name heuristics.
 */
export function campaignSelectorKeyFor(
  provider: RouteProviderId,
  modelId: string,
): string | null {
  for (const key of REQUESTED_SELECTOR_KEYS) {
    const { family, provider: keyProvider } = parseSelectorKey(key);
    if (keyProvider !== provider) continue;
    if (family === "deepseek-v4.1-flash-latest") {
      if (
        provider === "commandcode" && modelId === "deepseek/deepseek-v4.1-flash"
      ) return key;
      if (
        provider === "openrouter" &&
        modelId.startsWith("deepseek/deepseek-v4.1-flash") &&
        !modelId.includes(":") && !/(flashx|fast|free|pro)/i.test(modelId)
      ) return key;
    } else if (EXACT_MODEL_IDS[family]?.[provider] === modelId) {
      return key;
    }
  }
  return null;
}
