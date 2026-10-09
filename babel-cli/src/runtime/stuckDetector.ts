/**
 * Stuck-loop detector (Packet A1).
 *
 * OpenHands-style stuck detection: N (default 3) consecutive turns with an
 * identical normalized action signature *and* no observable state change
 * indicate a no-progress loop. When the detector fires, the caller must emit a
 * `run.status_changed` fact with `STUCK` and halt auto-continue.
 *
 * Pure and bounded: it holds only the last observation, counts repeats, and
 * never executes anything. Legitimate repeats that mutate state (a changing
 * `stateDigest`) never count toward stuck.
 */

/** Default consecutive no-change repeats before STUCK fires. */
export const DEFAULT_STUCK_THRESHOLD = 3;

/** Upper bound on the configurable threshold (hostile-input guard). */
export const MAX_STUCK_THRESHOLD = 100;

/** One observed turn: a normalized action signature plus a state digest. */
export interface TurnObservation {
  /**
   * Normalized action signature (e.g. tool name + canonicalized args digest).
   * Callers own normalization; the detector only compares for equality.
   */
  readonly actionSignature: string;
  /**
   * Digest of observable state after the turn. Unchanged digests mean the
   * repeat produced no state change.
   */
  readonly stateDigest: string;
}

export interface StuckDetectorOptions {
  /** Consecutive identical no-change turns required to fire. Default 3. */
  threshold?: number;
}

export interface StuckDetectionResult {
  /** True exactly once, when the repeat count reaches the threshold. */
  readonly stuck: boolean;
  /** Current consecutive identical no-change repeat count. */
  readonly repeatCount: number;
  /** The threshold in effect. */
  readonly threshold: number;
}

function normalizeThreshold(threshold: unknown): number {
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    return DEFAULT_STUCK_THRESHOLD;
  }
  const floored = Math.floor(threshold);
  if (floored < 1) return DEFAULT_STUCK_THRESHOLD;
  return Math.min(floored, MAX_STUCK_THRESHOLD);
}

function isSameTurn(a: TurnObservation, b: TurnObservation): boolean {
  return a.actionSignature === b.actionSignature && a.stateDigest === b.stateDigest;
}

/**
 * Incremental stuck detector. Feed one observation per completed turn;
 * `stuck` is true exactly on the turn where the consecutive identical
 * no-change count first reaches the threshold (and stays false afterwards
 * until the pattern breaks and re-forms).
 */
export class StuckLoopDetector {
  readonly threshold: number;
  private last: TurnObservation | null = null;
  private repeats = 0;
  private fired = false;

  constructor(options: StuckDetectorOptions = {}) {
    this.threshold = normalizeThreshold(options.threshold);
  }

  record(observation: TurnObservation): StuckDetectionResult {
    const valid =
      observation !== null &&
      typeof observation === 'object' &&
      typeof observation.actionSignature === 'string' &&
      typeof observation.stateDigest === 'string';

    if (!valid || (this.last !== null && isSameTurn(this.last, observation))) {
      if (valid && this.last !== null && isSameTurn(this.last, observation)) {
        this.repeats += 1;
        if (this.repeats >= this.threshold && !this.fired) {
          this.fired = true;
          return { stuck: true, repeatCount: this.repeats, threshold: this.threshold };
        }
      }
      return { stuck: false, repeatCount: this.repeats, threshold: this.threshold };
    }

    // Pattern broke (or first observation): reset the counter. A genuine
    // state-changing repeat never contributes to stuck.
    this.last = observation;
    this.repeats = 1;
    this.fired = false;
    return { stuck: false, repeatCount: this.repeats, threshold: this.threshold };
  }

  /** Current consecutive repeat count without recording a turn. */
  currentRepeats(): number {
    return this.repeats;
  }

  /** Drop all observed history. */
  reset(): void {
    this.last = null;
    this.repeats = 0;
    this.fired = false;
  }
}

/**
 * Pure one-shot classification of an observed turn history (most recent
 * last): true when the trailing run of identical no-change turns is at least
 * `threshold` long. Does not fire "exactly once" — use
 * {@link StuckLoopDetector} for edge-triggered detection.
 */
export function isStuckLoop(
  history: readonly TurnObservation[],
  options: StuckDetectorOptions = {},
): boolean {
  const threshold = normalizeThreshold(options.threshold);
  if (!Array.isArray(history) || history.length < threshold) return false;
  const last = history[history.length - 1];
  if (typeof last?.actionSignature !== 'string' || typeof last?.stateDigest !== 'string') {
    return false;
  }
  let run = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry && isSameTurn(entry, last)) {
      run += 1;
    } else {
      break;
    }
  }
  return run >= threshold;
}
