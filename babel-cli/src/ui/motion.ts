/**
 * Centralized motion primitives for the Babel TUI.
 *
 * Ported from codex `motion.rs`. Provides a single abstraction layer for all
 * time-varying animations. Components request shimmer, spinner, or activity
 * indicators through this module rather than calling animation helpers directly.
 *
 * Why centralize:
 *   - Single point of control for reduced-motion preference
 *   - Consistent animation timing across all TUI components
 *   - Easy to audit — no direct shimmer/spinner calls scattered in rendering code
 *   - Respects BABEL_REDUCED_MOTION env var and terminal capabilities
 *
 * Usage:
 *   import { MotionMode, shimmerText, activityIndicator } from './motion.js';
 *
 *   const mode = MotionMode.fromEnv();
 *   const text = shimmerText('Loading...', mode);
 *   const indicator = activityIndicator(startTime, mode, ReducedMotionIndicator.StaticBullet);
 *
 * @module motion
 */

import { shimmerText as rawShimmerText } from './shimmer.js';

// ── Motion mode ─────────────────────────────────────────────────────────────

/** Controls whether animations are rendered or replaced with static fallbacks. */
export enum MotionMode {
  Animated = 'animated',
  Reduced = 'reduced',
}

export namespace MotionMode {
  /**
   * Resolve the motion mode from environment and terminal capabilities.
   *
   * Checks (in order):
   *   1. BABEL_REDUCED_MOTION=1 → Reduced
   *   2. NO_COLOR set → Reduced (animations don't read well without color)
   *   3. Not a TTY → Reduced (non-interactive contexts)
   *   4. Default → Animated
   */
  export function fromEnv(): MotionMode {
    if (process.env['BABEL_REDUCED_MOTION'] === '1') return MotionMode.Reduced;
    if (process.env['NO_COLOR']) return MotionMode.Reduced;
    if (!process.stdout.isTTY) return MotionMode.Reduced;
    return MotionMode.Animated;
  }

  /** Create from an explicit boolean. */
  export function fromAnimationsEnabled(enabled: boolean): MotionMode {
    return enabled ? MotionMode.Animated : MotionMode.Reduced;
  }
}

// ── Reduced motion indicator ────────────────────────────────────────────────

/** Controls what to show in place of an animated activity indicator. */
export enum ReducedMotionIndicator {
  /** Show nothing — indicator is hidden entirely. */
  Hidden = 'hidden',
  /** Show a static bullet (•) instead of the animated indicator. */
  StaticBullet = 'staticBullet',
}

// ── Activity indicator ──────────────────────────────────────────────────────

/**
 * Return an animated or static activity indicator based on motion mode.
 *
 * In Animated mode, returns a shimmering bullet (•) that pulses.
 * In Reduced mode, returns the specified static fallback.
 *
 * @param startTime - Optional start time for animation phase (ms timestamp)
 * @param mode - Current motion mode
 * @param indicator - Fallback style for reduced motion
 * @returns ANSI-styled indicator string, or null if Hidden
 */
export function activityIndicator(
  startTime: number | null,
  mode: MotionMode,
  indicator: ReducedMotionIndicator,
): string | null {
  switch (mode) {
    case MotionMode.Animated:
      return animatedActivityIndicator(startTime);
    case MotionMode.Reduced:
      switch (indicator) {
        case ReducedMotionIndicator.Hidden:
          return null;
        case ReducedMotionIndicator.StaticBullet:
          return '\x1b[2m•\x1b[22m'; // dimmed bullet
      }
  }
}

function animatedActivityIndicator(startTime: number | null): string {
  const elapsed = startTime !== null ? Date.now() - startTime : 0;
  // Simple blink on 600ms period for non-truecolor terminals
  return rawShimmerText('•', 0.6);
}

// ── Shimmer text (motion-aware) ─────────────────────────────────────────────

/**
 * Apply shimmer animation to text, respecting the motion mode.
 *
 * In Animated mode: applies time-synchronized shimmer sweep.
 * In Reduced mode: returns plain text unchanged.
 *
 * @param text - The text to optionally shimmer
 * @param mode - Current motion mode
 * @returns Shimmered text or plain text
 */
export function shimmerText(text: string, mode: MotionMode): string {
  switch (mode) {
    case MotionMode.Animated:
      return rawShimmerText(text);
    case MotionMode.Reduced:
      return text;
  }
}

// ── Spinner frames (motion-aware) ───────────────────────────────────────────

const SPINNER_FRAMES: ReadonlyArray<string> = ['◐', '◓', '◑', '◒'];

/** Static bullet for reduced motion spinner fallback. */
const STATIC_BULLET = '•';

/**
 * Return a spinner frame or static fallback based on motion mode.
 *
 * @param frameIndex - Monotonically increasing frame counter
 * @param mode - Current motion mode
 * @returns Spinner character string
 */
export function spinnerFrame(frameIndex: number, mode: MotionMode): string {
  switch (mode) {
    case MotionMode.Animated:
      return SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]!;
    case MotionMode.Reduced:
      return STATIC_BULLET;
  }
}

// ── Module-level motion mode ────────────────────────────────────────────────

let _globalMotionMode: MotionMode | null = null;

/** Get the global motion mode (cached after first call). */
export function getMotionMode(): MotionMode {
  if (_globalMotionMode === null) {
    _globalMotionMode = MotionMode.fromEnv();
  }
  return _globalMotionMode;
}

/** Override the global motion mode (for testing). */
export function setMotionMode(mode: MotionMode): void {
  _globalMotionMode = mode;
}

/** Reset the cached motion mode (for testing). */
export function resetMotionMode(): void {
  _globalMotionMode = null;
}
