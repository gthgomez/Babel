import type { RetryPolicy, Retryability } from "./types.js";

export interface RetryFailureObservation {
  retryability: Retryability;
  /** Normalized failure class, when available, keeps policy switches distinct. */
  failureClass?: string;
}

/** Conservative default: retries transport/service pressure, never account/configuration failures. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  retryOn: Object.freeze({
    rateLimit: true,
    serverError: true,
    timeout: true,
    transport: true,
    streamIdle: true,
    affordability: false,
    auth: false,
    invalidParameters: false,
  }),
  backoff: Object.freeze({
    strategy: "provider_hint",
    baseMs: 200,
    maxMs: 5_000,
  }),
  modelSubstitutionAllowed: false,
  providerSubstitutionAllowed: false,
});

/** Map a normalized failure to the structured retry decision used by a campaign. */
export function shouldRetryFailure(
  policy: RetryPolicy,
  failure: Retryability | RetryFailureObservation,
): boolean {
  if (typeof failure !== "string") {
    switch (failure.failureClass) {
      case "RATE_LIMITED":
        return policy.retryOn.rateLimit;
      case "SERVER_ERROR":
        return policy.retryOn.serverError;
      case "TIMEOUT":
        return policy.retryOn.timeout;
      case "TRANSPORT_FAILURE":
        return policy.retryOn.transport;
      case "STREAM_IDLE":
        return policy.retryOn.streamIdle;
      default:
        return false;
    }
  }
  switch (failure) {
    case "retryable_same_request":
      return policy.retryOn.transport;
    case "retryable_after_delay":
      return (
        policy.retryOn.rateLimit ||
        policy.retryOn.serverError ||
        policy.retryOn.timeout ||
        policy.retryOn.transport
      );
    case "retryable_after_configuration_change":
    case "retryable_after_account_change":
    case "not_retryable":
      return false;
  }
}

/** Distinguish Babel attempts from gateway/upstream attempts in a receipt. */
export interface AttemptProvenance {
  babelAttempt: number;
  openrouterRouterAttempt?: number;
  upstreamAttempt?: number;
}

export function buildAttemptProvenance(
  input: AttemptProvenance,
): AttemptProvenance {
  return { ...input };
}
