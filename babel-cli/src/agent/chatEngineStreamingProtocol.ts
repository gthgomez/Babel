/** Ensure provider tool-call IDs are non-empty and unique within a turn. */
export function canonicalizeToolCallId(
  event: { id?: string },
  turn: number,
  actionIndex: number,
  seen: Set<string>,
): string {
  const candidates = [
    event.id && event.id.length > 0 ? event.id : undefined,
    `tool_call_${turn}_${actionIndex}`,
    `tool_call_${turn}_${actionIndex}_${seen.size}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }
  let suffix = seen.size;
  while (seen.has(`tool_call_${turn}_${actionIndex}_${suffix}`)) suffix += 1;
  const fallback = `tool_call_${turn}_${actionIndex}_${suffix}`;
  seen.add(fallback);
  return fallback;
}

/** Emit only the answer suffix not already visible from streamed deltas. */
export function reconcileStreamedAnswer(
  streamed: string | null,
  final: string,
): string | null {
  if (!final) return null;
  if (streamed === null || streamed === "") return final;
  if (final === streamed) return null;
  if (final.startsWith(streamed)) return final.slice(streamed.length);
  return final;
}
