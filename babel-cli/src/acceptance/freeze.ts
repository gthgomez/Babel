/** Runtime immutability helpers for all frozen acceptance artifacts. */
export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child);
  return value;
}

/** Freeze a value after its caller has validated its content hash. */
export function freezeArtifact<T>(value: T): T {
  return deepFreeze(value);
}
