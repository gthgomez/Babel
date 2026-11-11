/** Accept SSE `data:` lines with or without a space after the colon. */
export function ssePayloadFromTrimmedLine(trimmed: string): string | null {
  const normalized = trimmed.replace(/\r$/, '').trim();
  if (!normalized.startsWith('data:')) return null;
  return normalized.slice(5).trimStart();
}
