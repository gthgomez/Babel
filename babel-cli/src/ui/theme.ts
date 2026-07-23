import * as path from 'node:path';
import stringWidth from 'string-width';
import wrapAnsiLib from 'wrap-ansi';
import { COLOR_TOKENS, FALLBACK_FG } from './tokens.js';
import { graphemeTruncateToWidth, urlAwareWrapText } from './textUtils.js';
import {
  isWindowsTerminal,
  isLegacyWindowsConsole,
  detectTerminalIdentity,
  getIdentityTrueColor,
} from './terminalProbe.js';

// ── Color parse cache ──────────────────────────────────────────────────────
// Same hex colors are parsed repeatedly per frame (every toneToAnsi call).
// Cache hex → RGB to avoid redundant string slicing and parseInt overhead.

const rgbCache = new Map<string, { r: number; g: number; b: number }>();
const RGB_CACHE_MAX = 128;

export function parseRgb(hex: string): { r: number; g: number; b: number } {
  const cached = rgbCache.get(hex);
  if (cached) return cached;
  const normalized = hex.replace('#', '');
  const result = {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
  if (rgbCache.size >= RGB_CACHE_MAX) {
    const firstKey = rgbCache.keys().next().value;
    if (firstKey !== undefined) rgbCache.delete(firstKey);
  }
  rgbCache.set(hex, result);
  return result;
}

/** Clear the parseRgb cache (for testing / theme changes). */
export function clearRgbCache(): void {
  rgbCache.clear();
}

function wrapAnsi(text: string, open: string, close: string): string {
  if (!text) return text;
  return `${open}${text}${close}`;
}

function getForceColorLevel(): number | null {
  const raw = process.env['FORCE_COLOR'];
  if (raw === undefined) return null;
  if (raw === '' || raw === 'true') return 1;
  if (raw === 'false') return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

export function supportsColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  const forceColorLevel = getForceColorLevel();
  if (forceColorLevel === 0) return false;
  if (process.env['NO_COLOR']) return false;
  if (forceColorLevel !== null) return forceColorLevel > 0;
  // Legacy Windows cmd.exe often reports isTTY=true but has poor ANSI support.
  // Still return true since Windows 10+ has basic ANSI, just not true color.
  if (isLegacyWindowsConsole()) return Boolean(stream?.isTTY);
  return Boolean(stream?.isTTY);
}

export function supportsTrueColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  const forceColorLevel = getForceColorLevel();
  if (!supportsColor(stream)) return false;
  if (forceColorLevel !== null) return forceColorLevel >= 2;
  // Windows Terminal via ConPTY supports true color
  if (isWindowsTerminal()) return true;

  // Terminal identity check against KNOWN_CAPABILITIES takes priority over
  // env-var heuristics like COLORTERM. If the terminal is explicitly listed
  // in the table, its trueColor value is authoritative — this prevents
  // terminals with known-defective true color from being overridden by
  // COLORTERM=truecolor advertisements.
  const identity = detectTerminalIdentity();
  if (identity !== 'unknown') {
    return getIdentityTrueColor();
  }

  // Unknown terminal — use COLORTERM and TERM heuristics
  const colorterm = (process.env['COLORTERM'] ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return true;
  // TERM-based detection for terminals advertising direct color
  const term = (process.env['TERM'] ?? '').toLowerCase();
  if (term.includes('xterm-direct')) return true;
  return false;
}

const HAS_COLOR = supportsColor();
const HAS_TRUE = supportsTrueColor();

function toneToAnsi(tokenName: string, text: string): string {
  if (!HAS_COLOR) {
    return text;
  }
  const tokenHex = COLOR_TOKENS[tokenName];
  if (!tokenHex) {
    return text;
  }
  if (HAS_TRUE) {
    const rgb = parseRgb(tokenHex);
    return wrapAnsi(text, `[38;2;${rgb.r};${rgb.g};${rgb.b}m`, '[39m');
  }
  const fallback = FALLBACK_FG[tokenName] ?? 255;
  return wrapAnsi(text, `[38;5;${fallback}m`, '[39m');
}

export function bold(text: string): string {
  return HAS_COLOR ? wrapAnsi(text, '[1m', '[22m') : text;
}

export function dim(text: string): string {
  return HAS_COLOR ? wrapAnsi(text, '[2m', '[22m') : text;
}

export function colorToken(
  tokenName: string,
  text: string,
  options: { bold?: boolean; dim?: boolean } = {},
): string {
  const toned = toneToAnsi(tokenName, text);
  if (options.bold === true) {
    return bold(toned);
  }
  if (options.dim === true) {
    return dim(toned);
  }
  return toned;
}

export function primary(text: string): string {
  return colorToken('textPrimary', text);
}
export function muted(text: string): string {
  return colorToken('textMuted', text);
}
export function ghost(text: string): string {
  return colorToken('textGhost', text);
}
export function accent(text: string): string {
  return colorToken('accent', text);
}
export function accentBright(text: string): string {
  return colorToken('accent', text, { bold: true });
}
export function accentBlue(text: string): string {
  return colorToken('info', text);
}
export function sectionLabel(text: string): string {
  return colorToken('accentSecondary', text, { bold: true });
}
export function activeAccent(text: string): string {
  return colorToken('accentActive', text, { bold: true });
}
export function commandAccent(text: string): string {
  return colorToken('accentStrong', text, { bold: true });
}
export function info(text: string): string {
  return colorToken('info', text);
}
export function border(text: string): string {
  return colorToken('border', text);
}
export function success(text: string): string {
  return colorToken('success', text, { bold: true });
}
export function warning(text: string): string {
  return colorToken('warning', text, { bold: true });
}
export function error(text: string): string {
  return colorToken('error', text, { bold: true });
}

// ── Background colors ─────────────────────────────────────────────

// Apply a background color from the theme using the given token name
function bgToken(tokenName: string, text: string): string {
  if (!HAS_COLOR) return text;
  const tokenHex = COLOR_TOKENS[tokenName];
  if (!tokenHex) return text;
  if (HAS_TRUE) {
    const rgb = parseRgb(tokenHex);
    return wrapAnsi(text, `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`, '\x1b[49m');
  }
  // No reliable 256-color background fallback — use reverse video as approximation
  return wrapAnsi(text, '\x1b[7m', '\x1b[27m');
}

export function bgPrimary(text: string): string {
  return bgToken('textPrimary', text); // use text color as bg for contrast
}
export function bgPanel(text: string): string {
  return bgToken('panel', text);
}
export function bgPanelRaised(text: string): string {
  return bgToken('panelRaised', text);
}
export function bgAccent(text: string): string {
  return bgToken('accent', text);
}
export function bgError(text: string): string {
  return bgToken('error', text);
}
export function bgSuccess(text: string): string {
  return bgToken('success', text);
}
export function bgWarning(text: string): string {
  return bgToken('warning', text);
}

// Button styling for dialogs. Uses background color from theme, falls back
// to reverse video on terminals without true color support.
export function buttonFocused(text: string, danger: boolean = false): string {
  if (!HAS_COLOR) return `[ ${text} ]`;
  if (HAS_TRUE) {
    const bg = danger ? COLOR_TOKENS['error']! : COLOR_TOKENS['accent']!;
    const rgb = parseRgb(bg);
    return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m\x1b[97m ${text} \x1b[0m`;
  }
  return `\x1b[7m ${text} \x1b[27m`;
}

export function buttonNormal(text: string): string {
  if (!HAS_COLOR) return `  ${text}  `;
  return `\x1b[7m ${text} \x1b[27m`;
}

// Header bar with theme-colored background
export function headerBg(text: string): string {
  if (!HAS_COLOR) return text;
  if (HAS_TRUE) {
    const bg = COLOR_TOKENS['panel']!;
    const fg = COLOR_TOKENS['textPrimary']!;
    const bgRgb = parseRgb(bg);
    const fgRgb = parseRgb(fg);
    return `\x1b[48;2;${bgRgb.r};${bgRgb.g};${bgRgb.b}m\x1b[38;2;${fgRgb.r};${fgRgb.g};${fgRgb.b}m${text}\x1b[0m`;
  }
  return `\x1b[7m${text}\x1b[27m`;
}

// ── ANSI strip / visible-length caches ─────────────────────────────────────
// stripAnsi and visibleLength are called heavily in layout (table rendering,
// wrapping, primitives). Same styled strings are measured repeatedly.

const stripAnsiCache = new Map<string, string>();
const visibleLengthCache = new Map<string, number>();
const STRIP_CACHE_MAX = 256;

export function stripAnsi(text: string): string {
  const cached = stripAnsiCache.get(text);
  if (cached !== undefined) return cached;
  const result = text.replace(/\[[0-9;]*m/g, '');
  if (stripAnsiCache.size >= STRIP_CACHE_MAX) {
    const firstKey = stripAnsiCache.keys().next().value;
    if (firstKey !== undefined) stripAnsiCache.delete(firstKey);
  }
  stripAnsiCache.set(text, result);
  return result;
}

export function visibleLength(text: string): number {
  const cached = visibleLengthCache.get(text);
  if (cached !== undefined) return cached;
  const result = stringWidth(stripAnsi(text));
  if (visibleLengthCache.size >= STRIP_CACHE_MAX) {
    const firstKey = visibleLengthCache.keys().next().value;
    if (firstKey !== undefined) visibleLengthCache.delete(firstKey);
  }
  visibleLengthCache.set(text, result);
  return result;
}

/** Clear the stripAnsi and visibleLength caches (for testing / theme changes). */
export function clearStringCaches(): void {
  stripAnsiCache.clear();
  visibleLengthCache.clear();
}

// ── Model name humanization ──────────────────────────────────────────────────

/** Known model display names — maps internal IDs to human-readable labels. */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // Qwen family
  qwen3: 'Qwen 3',
  'qwen3-32b': 'Qwen 3 32B',
  // DeepSeek family
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4': 'DeepSeek V4',
  'deepseek-v3': 'DeepSeek V3',
  // Claude family
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'claude-fable-5': 'Claude Fable 5',
};

/**
 * Convert an internal model ID into a human-readable display name.
 * Falls back to title-casing the ID for unknown models.
 */
export function humanizeModelId(modelId: string): string {
  // Exact match
  if (MODEL_DISPLAY_NAMES[modelId]) return MODEL_DISPLAY_NAMES[modelId]!;
  // Fallback: convert kebab-case to Title Case
  return modelId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getTerminalWidth(
  fallback: number = 88,
  stream: NodeJS.WriteStream = process.stdout,
): number {
  const width = stream?.columns;
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
    return width;
  }
  return fallback;
}

/**
 * Return the terminal width clamped to a safe range.
 * Prevents layout breakage at extreme widths.
 */
export function getEffectiveTerminalWidth(
  min: number = 50,
  max: number = 200,
  stream: NodeJS.WriteStream = process.stdout,
): number {
  const raw = getTerminalWidth(88, stream);
  return Math.max(min, Math.min(max, raw));
}

/**
 * Returns true when the terminal is narrower than the given threshold.
 */
export function isNarrowTerminal(threshold: number = 60): boolean {
  return getTerminalWidth() < threshold;
}

export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const plain = stripAnsi(text);
  if (stringWidth(plain) <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  const truncated = [...plain].slice(0, Math.max(0, maxWidth - 1)).join('') + '…';
  // Re-apply leading ANSI open sequences so color isn't lost after truncation.
  const openSeq = text.match(/^(\[[0-9;]*m)+/)?.[0];
  return openSeq ? `${openSeq}${truncated}[39m` : truncated;
}

export function wrapText(text: string, maxWidth: number): string[] {
  return wrapAnsiLib(String(text ?? ''), maxWidth, { hard: true }).split('\n');
}

/**
 * Wrap text with URL-aware heuristics.
 *
 * When the text contains URL-like tokens, this preserves them intact
 * instead of breaking at `/`, `-`, etc. Pure prose wraps identically
 * to the standard `wrapText`. Use this for LLM output, tool results,
 * and any text that may contain clickable URLs.
 */
export function urlAwareWrap(text: string, maxWidth: number): string[] {
  return urlAwareWrapText(text, maxWidth);
}

export function formatOverflow(
  text: string,
  maxWidth: number,
  mode: string = 'truncate',
): string[] {
  const normalizedMode = String(mode ?? 'truncate').toLowerCase();
  if (normalizedMode === 'full') {
    // Preserve original styling — do not strip ANSI.
    return [String(text ?? '')];
  }
  if (normalizedMode === 'wrap') {
    return wrapText(text, maxWidth);
  }
  return [truncate(String(text ?? ''), maxWidth)];
}

export function padRight(text: string, width: number): string {
  const deficit = Math.max(0, width - visibleLength(text));
  return `${text}${' '.repeat(deficit)}`;
}

export function indentBlock(text: string, prefix: string = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function renderRule(width: number = 18, char: string = '─'): string {
  return muted(char.repeat(Math.max(0, width)));
}

// ── ThemeProvider ────────────────────────────────────────────────────────

/**
 * Centralized theme token resolver.
 *
 * Components call `ThemeProvider.getInstance().resolve('primary')` instead of
 * hardcoding color functions. This enables runtime theme switching — all
 * components update when the active theme changes.
 *
 * Pattern ported from claude-code `src/components/design-system/ThemeProvider`.
 */
export class ThemeProvider {
  private static instance: ThemeProvider | null = null;

  /** Get the singleton ThemeProvider. */
  static getInstance(): ThemeProvider {
    if (!ThemeProvider.instance) {
      ThemeProvider.instance = new ThemeProvider();
    }
    return ThemeProvider.instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    ThemeProvider.instance = null;
  }

  /**
   * Resolve a semantic token name to an ANSI-styled string.
   *
   * Token names match the COLOR_TOKENS keys: 'textPrimary', 'textMuted',
   * 'textGhost', 'accent', 'accentSecondary', 'accentActive', 'accentStrong',
   * 'info', 'success', 'warning', 'error', 'border'.
   *
   * @param token - Semantic color token name
   * @param text - Text to style
   * @param opts - Optional bold/dim modifiers
   * @returns ANSI-styled text
   */
  resolve(token: string, text: string, opts?: { bold?: boolean; dim?: boolean }): string {
    return colorToken(token, text, opts);
  }

  /**
   * Resolve a token for foreground text color.
   */
  fg(token: string, text: string): string {
    return this.resolve(token, text);
  }

  /**
   * Resolve a token for background color.
   */
  bg(token: string, text: string): string {
    return bgToken(token, text);
  }

  /** Return the accent color for the active theme. */
  getAccent(): string {
    return accent(''); // Just returns an empty string; use resolve() instead
  }
}

/**
 * Wrap a file path as an OSC 8 clickable hyperlink.
 * Only emits the OSC 8 sequence when stdout is a TTY and color is supported.
 *
 * @param filePath  Absolute or relative file path to link to
 * @param display   Optional display text (defaults to filePath)
 * @returns ANSI-escaped string with OSC 8 hyperlink, or plain text
 */
export function hyperlinkFile(filePath: string, display?: string): string {
  if (!HAS_COLOR) return display ?? filePath;
  if (!filePath) return display ?? '';
  const absolutePath = path.resolve(filePath);
  const link = absolutePath.replace(/\\/g, '/');
  const label = display ?? filePath;
  return `\x1b]8;;file://${link}\x1b\\${label}\x1b]8;;\x1b\\`;
}
