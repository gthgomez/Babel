/**
 * Shimmer animation — time-synchronized highlight sweep for live-streaming text.
 *
 * Ported from codex `shimmer.rs`. Produces a moving highlight band that sweeps
 * across text every ~2 seconds, giving visual feedback that content is actively
 * streaming. Degrades gracefully on terminals without true color support.
 *
 * Architecture:
 *   - Time-synchronized to a process-start clock so all shimmer regions move in
 *     unison regardless of when they were rendered.
 *   - Cosine interpolation for smooth highlight blending (physical accuracy is
 *     traded for fast computation — this runs per-frame on streaming content).
 *   - Graceful degradation: true-color terminals get RGB-blended highlights;
 *     256-color terminals get bold/dim modulation; 16-color terminals get bold
 *     only.
 *
 * Usage:
 *   import { shimmerText } from './shimmer.js';
 *   const highlighted = shimmerText('Streaming output…');
 *
 * Integration:
 *   Use from markdownAccumulator or assistantChunkStream to apply shimmer to the
 *   last N lines of streaming output.
 *
 * @module shimmer
 */

import { COLOR_TOKENS, FALLBACK_FG } from './tokens.js';
import { parseRgb, supportsTrueColor } from './theme.js';

// ── Time source ─────────────────────────────────────────────────────────────

let processStart = Date.now();

/** Reset the process start time (for testing). */
export function resetShimmerClock(): void {
  processStart = Date.now();
}

function elapsedSinceStart(): number {
  return (Date.now() - processStart) / 1000; // seconds
}

// ── Cached true-color detection ──────────────────────────────────────────────

let _shimmerTrueColor: boolean | null = null;

/** Reset the cached true-color result (for testing). */
export function resetShimmerTrueColorCache(): void {
  _shimmerTrueColor = null;
}

/**
 * Check whether the terminal supports true color, with caching.
 *
 * Delegates entirely to `supportsTrueColor()` from theme.ts, which now
 * includes all the TERM_PROGRAM/TERM checks that were previously duplicated
 * here.
 */
function shimmerTrueColor(): boolean {
  if (_shimmerTrueColor !== null) return _shimmerTrueColor;
  _shimmerTrueColor = supportsTrueColor();
  return _shimmerTrueColor;
}

// ── Color utilities ─────────────────────────────────────────────────────────

/** Blend two RGB colors by factor t (0 = base, 1 = highlight). */
function blend(
  base: { r: number; g: number; b: number },
  highlight: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  return {
    r: Math.round(base.r + (highlight.r - base.r) * t),
    g: Math.round(base.g + (highlight.g - base.g) * t),
    b: Math.round(base.b + (highlight.b - base.b) * t),
  };
}

/** Get the default foreground color from the theme. */
function defaultFg(): { r: number; g: number; b: number } {
  const hex = COLOR_TOKENS['textPrimary'];
  if (hex) return parseRgb(hex);
  return { r: 242, g: 239, b: 255 }; // fallback: babel-dusk textPrimary
}

/** Get the default background color from the theme. */
function defaultBg(): { r: number; g: number; b: number } {
  const hex = COLOR_TOKENS['background'];
  if (hex) return parseRgb(hex);
  return { r: 11, g: 10, b: 22 }; // fallback: babel-dusk background
}

// ── Shimmer rendering ───────────────────────────────────────────────────────

/**
 * Apply shimmer animation to each character in `text`.
 *
 * Returns an array of styled character strings with inline ANSI codes.
 * The shimmer band position is determined by elapsed time since process start,
 * so multiple calls within the same frame produce synchronized output.
 *
 * @param text - The text to shimmer
 * @param sweepPeriodSec - How long a full sweep takes (default 2.0s)
 * @returns Array of ANSI-styled strings, one per grapheme cluster
 */
export function shimmerChars(text: string, sweepPeriodSec: number = 2.0): string[] {
  if (!text) return [];

  const chars = [...text]; // grapheme-aware: spread decomposes emoji correctly
  const len = chars.length;
  const padding = 10;
  const period = len + padding * 2;

  // Time-based sweep position
  const elapsed = elapsedSinceStart();
  const pos = ((elapsed % sweepPeriodSec) / sweepPeriodSec) * period;

  const useTrueColor = shimmerTrueColor();
  const baseColor = defaultFg();
  const highlightColor = defaultBg();
  const bandHalfWidth = 5.0;

  const result: string[] = [];

  for (let i = 0; i < len; i++) {
    const iPos = i + padding;
    const dist = Math.abs(iPos - pos);

    const t =
      dist <= bandHalfWidth ? 0.5 * (1.0 + Math.cos(Math.PI * (dist / bandHalfWidth))) : 0.0;

    // Base text stays at normal intensity. Only the moving band is
    // brightened. Previously out-of-band chars were forced dim (`\x1b[2m`),
    // which made most of every shimmered string look permanently faded
    // when the result was committed to scrollback (answer streaming).
    let styled: string;
    if (useTrueColor && t > 0.01) {
      const highlight = Math.min(1.0, t);
      const blended = blend(highlightColor, baseColor, highlight * 0.9);
      styled = `\x1b[1m\x1b[38;2;${blended.r};${blended.g};${blended.b}m${chars[i]}\x1b[0m`;
    } else if (t >= 0.35) {
      styled = `\x1b[1m${chars[i]}\x1b[0m`;
    } else {
      styled = chars[i]!; // normal — never dim the base
    }
    result.push(styled);
  }

  return result;
}

/**
 * Apply shimmer to an entire text string, returning a single ANSI-styled string.
 *
 * This is the primary entry point for shimmer. Use it to wrap streaming text
 * with a highlight sweep animation.
 *
 * @param text - The text to shimmer
 * @param sweepPeriodSec - How long a full sweep takes (default 2.0s)
 * @returns ANSI-styled string with shimmer effect
 */
export function shimmerText(text: string, sweepPeriodSec: number = 2.0): string {
  return shimmerChars(text, sweepPeriodSec).join('');
}

// ── Reduced motion fallback ─────────────────────────────────────────────────

/**
 * Apply shimmer only if motion is enabled, otherwise return plain text.
 *
 * Respects the BABEL_REDUCED_MOTION environment variable.
 *
 * @param text - The text to optionally shimmer
 * @returns Shimmered text or plain text
 */
export function shimmerIfEnabled(text: string): string {
  if (process.env['BABEL_REDUCED_MOTION'] === '1') return text;
  return shimmerText(text);
}
