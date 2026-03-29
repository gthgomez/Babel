/**
 * truncate.ts — Log truncation utility
 *
 * Truncates long text strings to prevent context-window bloat when embedding
 * tool stdout/stderr in the Stage 4 execution-history string. Long shell
 * output (e.g. full file contents, npm install logs) can otherwise exhaust
 * the prompt budget before the executor has finished the plan.
 *
 * Strategy: keep the first half and last half of the allowed budget, separated
 * by a clear "[N chars truncated]" marker so both the beginning (command
 * summary) and the end (final result / error message) are always preserved.
 */

const DEFAULT_MAX_LENGTH = 1_000;

/**
 * Truncates `text` to at most `maxLength` characters.
 *
 * If no truncation is needed the original string is returned unchanged.
 * If truncation is applied the first `maxLength/2` and last `maxLength/2`
 * characters are kept, with a compact `[N chars truncated]` marker in the
 * middle so the executor knows output was elided.
 *
 * @param text       The text to truncate (stdout or stderr from a tool call).
 * @param maxLength  Maximum output length in characters. Default: 1000.
 */
export function truncateLogs(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;

  const half    = Math.floor(maxLength / 2);
  const elided  = text.length - maxLength;

  return (
    text.slice(0, half) +
    `\n... [${elided} chars truncated] ...\n` +
    text.slice(-half)
  );
}
