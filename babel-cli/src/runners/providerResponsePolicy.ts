import { parseRetryAfterHeader } from './providerNormalize.js';


const _rawRequestTimeoutMs = Number(process.env['BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS'] ?? '120000');

const REQUEST_TIMEOUT_MS =
  Number.isFinite(_rawRequestTimeoutMs) && _rawRequestTimeoutMs > 0 ? _rawRequestTimeoutMs : 120000;

const _rawRequestMaxRetries = Number(process.env['BABEL_DEEPINFRA_REQUEST_MAX_RETRIES'] ?? '4');


export const REQUEST_MAX_RETRIES =
  Number.isFinite(_rawRequestMaxRetries) && _rawRequestMaxRetries > 0
    ? Math.min(Math.floor(_rawRequestMaxRetries), 10)
    : 4;

const RETRY_BASE_DELAY_MS = 200;


export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'));
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Request cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}


export function readPositiveIntEnv(name: string, fallback: number, max?: number): number {
  const parsed = Number(process.env[name] ?? '');
  const value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return max ? Math.min(value, max) : value;
}


export function getRequestTimeoutMs(): number {
  return readPositiveIntEnv('BABEL_DEEPINFRA_REQUEST_TIMEOUT_MS', REQUEST_TIMEOUT_MS);
}


export function getRequestMaxRetries(): number {
  return readPositiveIntEnv('BABEL_DEEPINFRA_REQUEST_MAX_RETRIES', REQUEST_MAX_RETRIES, 10);
}

/** Node's fetch redirect values, kept local because this project omits DOM lib types. */
export type FetchRedirectPolicy = 'follow' | 'error' | 'manual';


export function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = parseRetryAfterHeader(response?.headers.get('retry-after'));
  if (retryAfter !== null) {
    return Math.min(retryAfter * 1000, 30_000);
  }
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(attempt - 1, 0);
  const jitter = Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
  return Math.min(exponential + jitter, 5_000);
}


export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}


export function isCallerCancelError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!isAbortError(error)) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return /request cancelled/i.test(msg) && !/request timeout/i.test(msg);
}
