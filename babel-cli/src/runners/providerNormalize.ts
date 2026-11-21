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

export class ConflictingStreamFinishError extends Error {
  constructor() {
    super('Protocol error: conflicting provider stream finish reasons');
  }
}

/** Accept repeated equivalent finish reasons while rejecting contradictory terminal evidence. */
export function accumulateStreamFinish(previous: string | null, reported: string): string | null {
  const raw = reported.trim().toLowerCase();
  if (!raw) return previous;
  const canonical = normalizeFinishReason(raw);
  const next = canonical === 'unknown' ? raw : canonical;
  if (previous && previous !== next) throw new ConflictingStreamFinishError();
  return next;
}

export type StreamFinishDisposition =
  | {
      status: 'complete';
      finishReason: 'stop' | 'tool_calls';
      /** The accumulated tool payload is explicit and validated; emit it. */
      executeTools: boolean;
    }
  | {
      status: 'failed';
      finishReason: 'length' | 'content_filter' | 'recitation' | 'unknown' | 'missing' | 'error';
      message: string;
      /**
       * How attribution should classify this failure. Provider policy/filter
       * and budget exhaustion are not adapter protocol errors.
       */
      errorKind: 'protocol' | 'provider' | 'none';
    };

/**
 * One terminal disposition for a stream that reached its transport end.
 *
 * A missing or unrecognized finish reason is a protocol failure, not an
 * implicit stop: guessing "stop" can turn partial text into a completed answer
 * and partial tool input into an executable call. The caller keeps any
 * accumulated output as diagnostic material, never as actionable work.
 */
export function classifyStreamFinish(input: {
  reported: string | null | undefined;
  sawDone: boolean;
  hasToolCalls: boolean;
}): StreamFinishDisposition {
  if (!input.sawDone) {
    return {
      status: 'failed',
      finishReason: 'missing',
      message: 'stream closed before terminal marker',
      errorKind: 'protocol',
    };
  }
  const raw = (input.reported ?? '').trim();
  if (!raw) {
    return {
      status: 'failed',
      finishReason: 'missing',
      message: 'stream ended without a finish reason',
      errorKind: 'protocol',
    };
  }
  const lower = raw.toLowerCase();
  if (lower === 'error') {
    return {
      status: 'failed',
      finishReason: 'error',
      message: 'Provider error during generation (finish_reason: error)',
      errorKind: 'provider',
    };
  }
  const reason = normalizeFinishReason(raw);
  switch (reason) {
    case 'stop':
      return {
        status: 'complete',
        finishReason: input.hasToolCalls ? 'tool_calls' : 'stop',
        executeTools: input.hasToolCalls,
      };
    case 'tool_calls':
      if (!input.hasToolCalls) {
        return {
          status: 'failed',
          finishReason: 'unknown',
          message: 'finish_reason tool_calls without an accumulated tool call',
          errorKind: 'protocol',
        };
      }
      return { status: 'complete', finishReason: 'tool_calls', executeTools: true };
    case 'length':
      return {
        status: 'failed',
        finishReason: 'length',
        message: 'Provider output budget exhausted (finish_reason: length)',
        errorKind: 'none',
      };
    case 'content_filter':
      return {
        status: 'failed',
        finishReason: 'content_filter',
        message: 'Provider filtered the response (finish_reason: content_filter)',
        errorKind: 'none',
      };
    case 'recitation':
      return {
        status: 'failed',
        finishReason: 'recitation',
        message: 'Provider blocked the response (finish_reason: recitation)',
        errorKind: 'none',
      };
    case 'unknown':
      return {
        status: 'failed',
        finishReason: 'unknown',
        message: `Provider returned an unrecognized finish reason: ${raw.slice(0, 40)}`,
        errorKind: 'protocol',
      };
  }
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
