/**
 * Thin presentation adapter for tool-trail outcomes.
 *
 * Domain/observation facts stay upstream. This module only converts
 * already-known signals into presentation class so waterfall and
 * toolPresentation cannot independently rediscover blocked vs failed.
 */

export type ToolPresentationOutcome = 'success' | 'failure' | 'unknown';
export type ToolPresentationAvailability = 'available' | 'blocked' | 'unavailable';
export type ToolPresentationTone = 'success' | 'warning' | 'error' | 'muted';
export type ToolPresentationStatus = 'success' | 'failure' | 'unknown' | 'blocked';

/** Signals already present on a tool-complete callback or summary. */
export interface ToolPresentationSignal {
  detail?: string | undefined;
  error?: string | undefined;
  exitCode?: number | undefined;
  status?: ToolPresentationStatus | undefined;
  lifecycle?: string | undefined;
}

/** Derived presentation class. Identity is never encoded here. */
export interface ToolPresentationClass {
  outcome: ToolPresentationOutcome;
  availability: ToolPresentationAvailability;
  tone: ToolPresentationTone;
  status: ToolPresentationStatus;
  isBlocked: boolean;
  isFailure: boolean;
  isSuccess: boolean;
}

const BLOCKED_DETAILS = new Set([
  'blocked',
  'hard-plan-mode',
  'plan-gate',
  'phase-gate',
  'reconciliation-required',
]);

const UNAVAILABLE_DETAILS = new Set(['platform_unusable']);

const FAILURE_DETAILS = new Set(['error', 'failed', 'degraded_suppressed']);

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isBlockedSignal(signal: ToolPresentationSignal): boolean {
  if (signal.lifecycle === 'blocked' || signal.status === 'blocked') return true;
  const detail = normalize(signal.detail);
  if (BLOCKED_DETAILS.has(detail)) return true;
  const err = normalize(signal.error);
  return err === 'blocked' || BLOCKED_DETAILS.has(err);
}

function isUnavailableSignal(signal: ToolPresentationSignal): boolean {
  if (signal.lifecycle === 'unavailable') return true;
  return UNAVAILABLE_DETAILS.has(normalize(signal.detail)) || UNAVAILABLE_DETAILS.has(normalize(signal.error));
}

function isFailureDetail(detail: string): boolean {
  if (FAILURE_DETAILS.has(detail)) return true;
  return detail.startsWith('exit ') && !detail.startsWith('exit 0');
}

/**
 * Classify a tool-complete signal into blocked / failed / success / unknown.
 *
 * Blocked availability wins over a fabricated nonzero exit or error string.
 * A command that never executed is not an execution failure.
 */
export function classifyToolPresentation(signal: ToolPresentationSignal): ToolPresentationClass {
  if (isBlockedSignal(signal)) {
    return {
      outcome: 'unknown',
      availability: 'blocked',
      tone: 'warning',
      status: 'blocked',
      isBlocked: true,
      isFailure: false,
      isSuccess: false,
    };
  }

  if (isUnavailableSignal(signal)) {
    return {
      outcome: 'unknown',
      availability: 'unavailable',
      tone: 'warning',
      status: 'unknown',
      isBlocked: false,
      isFailure: false,
      isSuccess: false,
    };
  }

  const detail = normalize(signal.detail);
  const hasNonzeroExit = signal.exitCode !== undefined && signal.exitCode !== 0;
  const hasErrorText = Boolean(signal.error && signal.error.length > 0);
  const failed =
    signal.status === 'failure' ||
    signal.lifecycle === 'failed' ||
    hasNonzeroExit ||
    hasErrorText ||
    isFailureDetail(detail);

  if (failed) {
    return {
      outcome: 'failure',
      availability: 'available',
      tone: 'error',
      status: 'failure',
      isBlocked: false,
      isFailure: true,
      isSuccess: false,
    };
  }

  const succeeded =
    signal.status === 'success' ||
    signal.lifecycle === 'completed' ||
    (signal.exitCode === 0 && !hasErrorText);

  if (succeeded) {
    return {
      outcome: 'success',
      availability: 'available',
      tone: 'success',
      status: 'success',
      isBlocked: false,
      isFailure: false,
      isSuccess: true,
    };
  }

  return {
    outcome: 'unknown',
    availability: 'available',
    tone: 'muted',
    status: 'unknown',
    isBlocked: false,
    isFailure: false,
    isSuccess: false,
  };
}

/**
 * True when `detail` names an actual execution failure.
 * Policy blocks are not failures.
 */
export function isKnownFailureDetail(detail: string | undefined): boolean {
  return classifyToolPresentation({ detail }).isFailure;
}

/**
 * True when `detail` names a blocked / policy-denied operation.
 */
export function isBlockedDetail(detail: string | undefined): boolean {
  return classifyToolPresentation({ detail }).isBlocked;
}
