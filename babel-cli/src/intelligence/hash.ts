import { createHash } from "node:crypto";

/** Return a recursively key-sorted JSON-safe value for stable identity hashing. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/** Hash JSON after canonicalization. Secrets must never be passed to this API. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "undefined")
    .digest("hex");
}

/** Deep-freeze an envelope/profile so downstream adapters cannot mutate policy. */
export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child);
  return value;
}
