/**
 * research/rateBudget.ts — Adaptive provider request budget
 *
 * Tracks requests, search-request count, remaining primary quota, reset
 * time, bytes downloaded, and errors/retries for one research mission.
 * On exhaustion the budget enters an explicit non-success state
 * (PAUSED with reason) that callers persist — never a busy-loop and
 * never a silent credential switch. Rate-limit decisions read the
 * provider's response headers (x-ratelimit-*), not the rate-limit endpoint.
 */

import { BUDGET_PRESET_VALUES, type RepositoryResearchProvider } from './contracts.js';
export type RateBudgetState = 'OK' | 'BACKOFF' | 'EXHAUSTED';

export interface RateLimitHeaders {
  'x-ratelimit-limit'?: string | null;
  'x-ratelimit-remaining'?: string | null;
  'x-ratelimit-reset'?: string | null;
  'x-ratelimit-resource'?: string | null;
  'retry-after'?: string | null;
}

export interface RateBudgetSnapshot {
  state: RateBudgetState;
  requestsIssued: number;
  searchRequests: number;
  remainingPrimary: number | null;
  primaryLimit: number | null;
  resetAt: string | null;
  bytesDownloaded: number;
  errors: number;
  retries: number;
  backoffUntil: string | null;
  lastReason: string | null;
}

const DEFAULT_MAX_SEARCH_REQUESTS = 30;
const DEFAULT_MAX_TOTAL_REQUESTS = 2000;

export class RateBudget {
  private requestsIssued = 0;
  private searchRequests = 0;
  private remainingPrimary: number | null = null;
  private primaryLimit: number | null = null;
  private resetAt: Date | null = null;
  private bytesDownloaded = 0;
  private errors = 0;
  private retries = 0;
  private backoffUntil: Date | null = null;
  private lastReason: string | null = null;

  constructor(
    private readonly maxTotalRequests = DEFAULT_MAX_TOTAL_REQUESTS,
    private readonly maxSearchRequests = DEFAULT_MAX_SEARCH_REQUESTS,
    private maxRemoteBytes = BUDGET_PRESET_VALUES.normal.max_remote_bytes,
  ) {}

  /** Throws RateBudgetExhaustedError when the next request must not be issued. */
  beforeRequest(kind: 'search' | 'core', now: Date = new Date()): void {
    if (this.bytesDownloaded >= this.maxRemoteBytes) {
      this.lastReason = `remote byte budget exhausted (${this.maxRemoteBytes})`;
      throw new RateBudgetExhaustedError(this.lastReason);
    }
    if (this.backoffUntil && now < this.backoffUntil) {
      throw new RateBudgetPausedError(
        `backoff until ${this.backoffUntil.toISOString()}: ${this.lastReason ?? 'rate limited'}`,
        this.backoffUntil,
      );
    }
    if (this.requestsIssued >= this.maxTotalRequests) {
      throw new RateBudgetExhaustedError(`total request budget exhausted (${this.maxTotalRequests})`);
    }
    if (kind === 'search' && this.searchRequests >= this.maxSearchRequests) {
      throw new RateBudgetExhaustedError(`search request budget exhausted (${this.maxSearchRequests})`);
    }
    if (this.remainingPrimary !== null && this.remainingPrimary <= 0 && this.resetAt && now < this.resetAt) {
      throw new RateBudgetPausedError(
        `primary quota exhausted, resets at ${this.resetAt.toISOString()}`,
        this.resetAt,
      );
    }
    this.requestsIssued += 1;
    if (kind === 'search') this.searchRequests += 1;
  }

  recordHeaders(headers: RateLimitHeaders, bytes: number): void {
    this.recordBytes(bytes);
    const remaining = headers['x-ratelimit-remaining'];
    if (remaining !== undefined && remaining !== null && remaining !== '') {
      const value = Number.parseInt(remaining, 10);
      if (Number.isFinite(value)) this.remainingPrimary = value;
    }
    const limit = headers['x-ratelimit-limit'];
    if (limit !== undefined && limit !== null && limit !== '') {
      const value = Number.parseInt(limit, 10);
      if (Number.isFinite(value)) this.primaryLimit = value;
    }
    // GitHub primary reset is epoch seconds; Retry-After is plain seconds.
    const reset = headers['x-ratelimit-reset'];
    if (reset) {
      const epoch = Number.parseInt(reset, 10);
      if (Number.isFinite(epoch) && epoch > 1e9) this.resetAt = new Date(epoch * 1000);
    }
    const retryAfter = headers['retry-after'];
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds) && seconds >= 0) {
        this.backoffUntil = new Date(Date.now() + seconds * 1000);
        this.lastReason = `retry-after ${seconds}s`;
      }
    }
  }

  /** Account actual received response chunks, including an overflow chunk. */
  recordBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid response byte count');
    this.bytesDownloaded += bytes;
    if (this.bytesDownloaded > this.maxRemoteBytes) {
      this.lastReason = `remote byte budget exhausted (${this.maxRemoteBytes})`;
      throw new RateBudgetExhaustedError(this.lastReason);
    }
  }

  get remainingBytes(): number {
    return Math.max(0, this.maxRemoteBytes - this.bytesDownloaded);
  }

  /** Bind a mission's ceiling without replenishing previously consumed bytes. */
  limitRemoteBytes(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid mission byte limit');
    this.maxRemoteBytes = Math.min(this.maxRemoteBytes, limit);
  }

  recordError(): void {
    this.errors += 1;
  }

  recordRetry(): void {
    this.retries += 1;
  }

  get bytes(): number {
    return this.bytesDownloaded;
  }

  snapshot(now: Date = new Date()): RateBudgetSnapshot {
    const state: RateBudgetState =
      this.bytesDownloaded >= this.maxRemoteBytes
        ? 'EXHAUSTED'
        : this.backoffUntil && now < this.backoffUntil
        ? 'BACKOFF'
        : this.requestsIssued >= this.maxTotalRequests ||
            (this.remainingPrimary !== null &&
              this.remainingPrimary <= 0 &&
              (!this.resetAt || now < this.resetAt))
          ? 'EXHAUSTED'
          : 'OK';
    return {
      state,
      requestsIssued: this.requestsIssued,
      searchRequests: this.searchRequests,
      remainingPrimary: this.remainingPrimary,
      primaryLimit: this.primaryLimit,
      resetAt: this.resetAt?.toISOString() ?? null,
      bytesDownloaded: this.bytesDownloaded,
      errors: this.errors,
      retries: this.retries,
      backoffUntil: this.backoffUntil?.toISOString() ?? null,
      lastReason: this.lastReason,
    };
  }
}

/** Share the real provider's request-byte owner across mission entry points. */
export function bindMissionByteBudget(provider: RepositoryResearchProvider, limit: number): RateBudget | null {
  const budget = (provider as RepositoryResearchProvider & { budget?: RateBudget }).budget;
  if (!budget || typeof budget.limitRemoteBytes !== 'function') return null;
  budget.limitRemoteBytes(limit);
  return budget;
}

export class RateBudgetExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateBudgetExhaustedError';
  }
}

export class RateBudgetPausedError extends Error {
  constructor(
    message: string,
    public readonly resumeAt: Date,
  ) {
    super(message);
    this.name = 'RateBudgetPausedError';
  }
}
