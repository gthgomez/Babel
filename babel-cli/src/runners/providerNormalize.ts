export type CanonicalFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'recitation' | 'unknown';

export function normalizeFinishReason(raw: string | null | undefined): CanonicalFinishReason {
  if (!raw) return 'unknown';
  const lower = raw.toLowerCase();
  if (lower === 'stop' || lower === 'end_turn') return 'stop';
  if (lower === 'tool_calls' || lower === 'function_call') return 'tool_calls';
  if (lower === 'length' || lower === 'max_tokens') return 'length';
  if (lower === 'content_filter') return 'content_filter';
  if (lower === 'recitation') return 'recitation';
  return 'unknown';
}

export type RetryClassification = 'transient' | 'rate_limit' | 'auth_fatal' | 'quota_fatal' | 'invalid_request' | 'context_overflow';

export function classifyProviderError(err: unknown, status?: number): RetryClassification {
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth_fatal';
    if (status === 429) {
      if (err instanceof Error && /quota|insufficient/i.test(err.message)) {
        return 'quota_fatal';
      }
      return 'rate_limit';
    }
    if (status === 400 || status === 422) {
      if (err instanceof Error && /context|token limit|length/i.test(err.message)) {
        return 'context_overflow';
      }
      return 'invalid_request';
    }
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('auth') || msg.includes('unauthorized') || msg.includes('invalid api key')) return 'auth_fatal';
    if (msg.includes('quota') || msg.includes('insufficient limit')) return 'quota_fatal';
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) return 'rate_limit';
    if (msg.includes('context') && (msg.includes('length') || msg.includes('overflow'))) return 'context_overflow';
    if (msg.includes('invalid') || msg.includes('bad request')) return 'invalid_request';
    if (msg.includes('network') || msg.includes('timeout') || msg.includes('econnrefused')) return 'transient';
  }

  return 'transient';
}

export function parseRetryAfterHeader(header: string | null | undefined): number | null {
  if (!header) return null;
  const num = Number(header);
  if (!Number.isNaN(num) && num >= 0) {
    return num;
  }
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    const diff = Math.max(0, date.getTime() - Date.now());
    return Math.ceil(diff / 1000);
  }
  return null;
}

export function isRetryableStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}
