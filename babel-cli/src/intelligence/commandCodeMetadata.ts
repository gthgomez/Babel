/**
 * Command Code Provider API public model catalog reader.
 *
 * Reads the public catalog at https://api.commandcode.ai/provider/v1/models.
 * Catalog entries carry no credential material and cannot influence which
 * credential a transport uses. `created` values are identical across models in
 * observed snapshots and must never be used to rank release order.
 */
import { createHash } from "node:crypto";

export const COMMANDCODE_MODELS_URL =
  "https://api.commandcode.ai/provider/v1/models" as const;
export const COMMANDCODE_API_BASE =
  "https://api.commandcode.ai/provider/v1" as const;
export const COMMANDCODE_NORMALIZER_VERSION = "commandcode-models-v1";

/** Minimal normalized entry from the Command Code catalog. */
export interface CommandCodeModelEntry {
  id: string;
  name: string | null;
  contextLength: number | null;
  supportedEndpoints: readonly string[];
  /** Observed identical across models; informational only, never release order. */
  createdAt: number | null;
}

export interface CommandCodeCatalogSnapshot {
  provider: "commandcode";
  url: string;
  fetchedAt: string;
  sha256: string;
  entries: CommandCodeModelEntry[];
}

interface RawCommandCodeEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  supported_endpoints?: unknown;
  created?: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function endpointsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

/** Parse and normalize the Command Code catalog body; invalid shapes fail explicitly. */
export function parseCommandCodeCatalog(
  body: string,
  options: { url?: string; fetchedAt?: string } = {},
): CommandCodeCatalogSnapshot {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Command Code catalog response was not valid JSON.");
  }
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Command Code catalog is missing its `data` array.");
  }
  const entries: CommandCodeModelEntry[] = [];
  for (const raw of data as RawCommandCodeEntry[]) {
    const id = stringOrNull(raw?.id);
    if (!id) continue;
    entries.push({
      id,
      name: stringOrNull(raw?.name),
      contextLength: numberOrNull(raw?.context_length),
      supportedEndpoints: endpointsOf(raw?.supported_endpoints),
      createdAt: numberOrNull(raw?.created),
    });
  }
  return {
    provider: "commandcode",
    url: options.url ?? COMMANDCODE_MODELS_URL,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    sha256: sha256(body),
    entries,
  };
}

/** Fetch the Command Code public catalog with a bounded timeout. */
export async function fetchCommandCodeCatalog(input: {
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  now?: (() => Date) | undefined;
}): Promise<CommandCodeCatalogSnapshot> {
  const fetchedAt = (input.now ?? (() => new Date()))().toISOString();
  const timeout = AbortSignal.timeout(input.timeoutMs ?? 15_000);
  const response = await (input.fetchImpl ?? fetch)(COMMANDCODE_MODELS_URL, {
    signal: timeout,
    headers: { accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Command Code catalog request failed (HTTP ${response.status}).`,
    );
  }
  const snapshot = parseCommandCodeCatalog(body, {
    url: COMMANDCODE_MODELS_URL,
    fetchedAt,
  });
  if (snapshot.entries.length === 0) {
    throw new Error("Command Code catalog contained no parseable model entries.");
  }
  return snapshot;
}
