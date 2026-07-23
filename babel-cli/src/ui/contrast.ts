/**
 * WCAG 2.2 contrast ratio computation for theme verification.
 *
 * Pure math — no UI dependencies. Computes relative luminance and contrast
 * ratios per the WCAG 2.2 specification, with check functions for AA/AAA
 * thresholds. Also provides bulk theme checking against all relevant
 * foreground-on-background color pairs.
 */

import type { ThemeDefinition } from './tokens.js';
import { parseRgb } from './theme.js';

// ── sRGB gamma correction ─────────────────────────────────────────────────

/**
 * Convert an sRGB channel value (0–255) to the linearized component
 * used in relative luminance calculation (WCAG 2.2 § 1.4.3).
 */
function srgbToLinear(channel8bit: number): number {
  const c = channel8bit / 255;
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

// ── Luminance & contrast ──────────────────────────────────────────────────

/**
 * Relative luminance of a hex color per WCAG 2.2 definition.
 * L = 0.2126 * R + 0.7152 * G + 0.0722 * B (using linearized sRGB).
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * WCAG 2.2 contrast ratio between two hex colors.
 * (L1 + 0.05) / (L2 + 0.05) where L1 is the lighter luminance.
 * Order of arguments does not matter.
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Threshold checks ──────────────────────────────────────────────────────

/** WCAG AA minimum for normal text (≥ 4.5:1). */
export function isWcagAa(ratio: number): boolean {
  return ratio >= 4.5;
}

/** WCAG AA minimum for large text (≥ 3:1). */
export function isWcagAaLarge(ratio: number): boolean {
  return ratio >= 3.0;
}

/** WCAG AAA minimum for normal text (≥ 7:1). */
export function isWcagAaa(ratio: number): boolean {
  return ratio >= 7.0;
}

// ── Pair checking ─────────────────────────────────────────────────────────

/** A single foreground-on-background contrast check result. */
export interface ThemeContrastPair {
  /** Human-readable name (e.g. "textPrimary on background"). */
  name: string;
  /** Token key for the foreground color. */
  fgToken: string;
  /** Token key for the background color. */
  bgToken: string;
  /** Foreground hex value. */
  fgHex: string;
  /** Background hex value. */
  bgHex: string;
  /** Computed contrast ratio. */
  ratio: number;
  /** Whether this pair meets WCAG AA (≥ 4.5:1). */
  passesAa: boolean;
  /** Whether this pair meets WCAG AA Large (≥ 3:1). */
  passesAaLarge: boolean;
  /** Whether this pair meets WCAG AAA (≥ 7:1). */
  passesAaa: boolean;
}

/**
 * Foreground tokens that should be checked for contrast against
 * background surfaces.
 */
const FG_TOKENS = [
  'textPrimary',
  'textMuted',
  'textGhost',
  'accent',
  'accentSecondary',
  'accentActive',
  'accentStrong',
  'info',
  'success',
  'warning',
  'error',
  'border',
] as const;

/**
 * Background surface tokens to check foregrounds against.
 */
const BG_TOKENS = ['background', 'panel'] as const;

/**
 * Check all relevant foreground-on-background pairs for a single theme.
 * Returns one result per (fgToken, bgToken) combination.
 */
export function checkThemeContrast(theme: ThemeDefinition): ThemeContrastPair[] {
  const results: ThemeContrastPair[] = [];

  for (const fgKey of FG_TOKENS) {
    const fgHex = theme.trueColor[fgKey];
    if (!fgHex) continue;

    for (const bgKey of BG_TOKENS) {
      const bgHex = theme.trueColor[bgKey];
      if (!bgHex) continue;

      const ratio = contrastRatio(fgHex, bgHex);

      results.push({
        name: `${fgKey} on ${bgKey}`,
        fgToken: fgKey,
        bgToken: bgKey,
        fgHex,
        bgHex,
        ratio: Math.round(ratio * 100) / 100,
        passesAa: isWcagAa(ratio),
        passesAaLarge: isWcagAaLarge(ratio),
        passesAaa: isWcagAaa(ratio),
      });
    }
  }

  return results;
}

/**
 * Format a theme contrast report as a human-readable string.
 * Useful for CI output and manual review.
 */
export function formatContrastReport(theme: ThemeDefinition): string {
  const pairs = checkThemeContrast(theme);
  const failures = pairs.filter((p) => !p.passesAa);
  const lines: string[] = [
    `Theme: ${theme.name} (${theme.mode})`,
    `  Pairs checked: ${pairs.length}`,
    `  AA passes:     ${pairs.length - failures.length}/${pairs.length}`,
    `  AA failures:   ${failures.length}`,
  ];

  if (failures.length > 0) {
    lines.push('  Failures:');
    for (const f of failures) {
      lines.push(
        `    ${f.name}: ${f.ratio.toFixed(2)}:1 (needs ≥ 4.5:1) [fg=${f.fgHex} bg=${f.bgHex}]`,
      );
    }
  }

  return lines.join('\n');
}
