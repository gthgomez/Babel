/**
 * Detect operator/runtime abort so we never paint Ctrl+C as AGENT_FAILURE.
 * Idle/request timeouts remapped by the runner are not operator aborts.
 */
export function isOperatorAbortError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === 'object' && 'name' in err) {
    const name = String((err as { name?: unknown }).name);
    if (name === 'AbortError' || name === 'CanceledError') return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/request timeout/i.test(msg)) return false;
  if (/provider (?:startup|stream) idle/i.test(msg)) return false;
  return (
    /operation was aborted/i.test(msg) ||
    /^aborterror\b/i.test(msg) ||
    /request cancelled/i.test(msg)
  );
}
