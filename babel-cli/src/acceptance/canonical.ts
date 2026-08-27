import { createHash } from "node:crypto";

/** Canonical JSON keeps object key ordering stable while preserving array order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Recursively sort JSON object keys without mutating the caller's value. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON cannot encode non-finite numbers");
    return value;
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    value === undefined
  ) {
    throw new Error("Canonical JSON cannot encode unsupported values");
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  throw new Error("Canonical JSON encountered an unsupported value");
}

/** Return a full SHA-256 digest for a JSON-compatible value. */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function omitKeys<T extends Record<string, unknown>>(
  value: T,
  keys: readonly string[],
): Record<string, unknown> {
  const excluded = new Set(keys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !excluded.has(key)),
  );
}
