import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashCanonical } from "./hash.js";
import {
  OPENROUTER_MODELS_URL,
  OPENROUTER_NORMALIZER_VERSION,
  normalizeOpenRouterModelMetadata,
  selectOpenRouterModelEntry,
  type OpenRouterModelEntry,
} from "./openrouterMetadata.js";

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  return new Set([
    "authorization",
    "apikey",
    "cookie",
    "setcookie",
    "secret",
    "accesstoken",
    "refreshtoken",
  ]).has(normalized);
}

const CREDENTIAL_VALUE = /^(?:bearer\s+|sk-or-v1-)[a-z0-9._-]{16,}$/i;
type HeaderInput = Headers | Record<string, string> | Array<[string, string]>;

/** A persisted external response with credentials and authorization material removed. */
export interface RawProviderEvidence {
  schemaVersion: 1;
  kind: "raw_provider_evidence";
  request: { method: string; url: string; headers: Record<string, string> };
  retrievedAt: string;
  httpStatus: number;
  responseHeaders: Record<string, string>;
  rawResponseBody: string;
  rawResponseSha256: string;
  normalizerVersion: string;
  normalizerSourceHash: string;
  normalizedArtifactHash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redactValue(value: string): string {
  if (!value) return value;
  return CREDENTIAL_VALUE.test(value) ? "[REDACTED]" : value;
}

/** Redact sensitive header names without discarding useful content headers. */
export function redactHeaders(
  headers: HeaderInput | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) return output;
  new Headers(headers).forEach((value, key) => {
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(value);
  });
  return output;
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactJson(item),
    ]),
  );
}

/** Preserve raw JSON where possible while guaranteeing credential-free evidence. */
export function redactProviderBody(body: string): string {
  try {
    return JSON.stringify(redactJson(JSON.parse(body)), null, 2);
  } catch {
    return CREDENTIAL_VALUE.test(body) ? "[REDACTED_NON_JSON_BODY]" : body;
  }
}

/** Build a hash-linked raw/normalized evidence record for one external response. */
export function createRawProviderEvidence(input: {
  method?: string;
  url: string;
  requestHeaders?: HeaderInput;
  retrievedAt: string;
  httpStatus: number;
  responseHeaders?: HeaderInput;
  rawResponseBody: string;
  normalizedArtifact: unknown;
  normalizerVersion?: string;
  normalizerSourceHash: string;
}): RawProviderEvidence {
  const rawResponseBody = redactProviderBody(input.rawResponseBody);
  return {
    schemaVersion: 1,
    kind: "raw_provider_evidence",
    request: {
      method: input.method ?? "GET",
      url: input.url,
      headers: redactHeaders(input.requestHeaders),
    },
    retrievedAt: input.retrievedAt,
    httpStatus: input.httpStatus,
    responseHeaders: redactHeaders(input.responseHeaders),
    rawResponseBody,
    rawResponseSha256: sha256(rawResponseBody),
    normalizerVersion: input.normalizerVersion ?? OPENROUTER_NORMALIZER_VERSION,
    normalizerSourceHash: input.normalizerSourceHash,
    normalizedArtifactHash: hashCanonical(input.normalizedArtifact),
  };
}

/** Persist raw and normalized artifacts under separate reviewable evidence lanes. */
export async function persistProviderEvidence(input: {
  directory: string;
  artifactId: string;
  raw: RawProviderEvidence;
  normalizedArtifact: unknown;
}): Promise<{ rawPath: string; normalizedPath: string }> {
  const rawDir = join(input.directory, "raw");
  const normalizedDir = join(input.directory, "normalized");
  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });
  const rawPath = join(rawDir, `${input.artifactId}.json`);
  const normalizedPath = join(normalizedDir, `${input.artifactId}.json`);
  await writeFile(rawPath, `${JSON.stringify(input.raw, null, 2)}\n`, "utf8");
  await writeFile(
    normalizedPath,
    `${JSON.stringify(input.normalizedArtifact, null, 2)}\n`,
    "utf8",
  );
  return { rawPath, normalizedPath };
}

/** Fetch, normalize, and persist an OpenRouter model response as one reproducible chain. */
export async function fetchAndPersistOpenRouterModelEvidence(input: {
  requestedModel: string;
  directory: string;
  fetchImpl?: typeof fetch;
  observedAt?: string;
  normalizerSourceHash: string;
}): Promise<{
  selection: ReturnType<typeof selectOpenRouterModelEntry>;
  normalized: ReturnType<typeof normalizeOpenRouterModelMetadata>;
  evidence: RawProviderEvidence;
  paths: { rawPath: string; normalizedPath: string };
}> {
  const retrievedAt = input.observedAt ?? new Date().toISOString();
  const response = await (input.fetchImpl ?? fetch)(OPENROUTER_MODELS_URL);
  const body = await response.text();
  let payload: { data?: OpenRouterModelEntry[] };
  try {
    payload = JSON.parse(body) as { data?: OpenRouterModelEntry[] };
  } catch {
    throw new Error(
      `OpenRouter metadata response was not valid JSON (HTTP ${response.status}).`,
    );
  }
  const selection = selectOpenRouterModelEntry(
    payload.data ?? [],
    input.requestedModel,
  );
  if (!response.ok || !selection) {
    throw new Error(
      `OpenRouter metadata did not resolve ${input.requestedModel} (HTTP ${response.status}).`,
    );
  }
  const normalized = normalizeOpenRouterModelMetadata({
    requestedModel: input.requestedModel,
    entry: selection.entry,
    observedAt: retrievedAt,
  });
  const artifact = {
    ...normalized,
    selection: {
      aliasUsed: selection.aliasUsed,
      aliasId: selection.aliasId,
      aliasTarget: selection.aliasTarget,
    },
  };
  const evidence = createRawProviderEvidence({
    url: OPENROUTER_MODELS_URL,
    retrievedAt,
    httpStatus: response.status,
    responseHeaders: response.headers,
    rawResponseBody: body,
    normalizedArtifact: artifact,
    normalizerSourceHash: input.normalizerSourceHash,
  });
  const paths = await persistProviderEvidence({
    directory: input.directory,
    artifactId: `${input.requestedModel.replace(/[^a-z0-9]+/gi, "-")}-models`,
    raw: evidence,
    normalizedArtifact: artifact,
  });
  return { selection, normalized, evidence, paths };
}
