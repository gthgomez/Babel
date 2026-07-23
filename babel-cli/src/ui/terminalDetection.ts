/**
 * Terminal background color detection via OSC 11 query.
 *
 * Queries the terminal for its current background color, parses the response,
 * and determines whether the terminal has a light or dark background. This
 * enables auto-selection of the appropriate theme (babel-dusk for dark,
 * babel-dawn for light).
 *
 * Supported terminals: iTerm2, WezTerm, Ghostty, kitty, Windows Terminal,
 * VS Code integrated terminal, and any xterm-compatible terminal that
 * supports OSC 11 queries.
 *
 * Usage:
 *   import { detectTerminalBackground, terminalBackgroundMode } from './terminalDetection.js';
 *   const mode = await detectTerminalBackground();
 *   if (mode === 'light') setActiveTheme('babel-dawn');
 *
 * @module terminalDetection
 */

import { env } from 'node:process';

// ─── Types ──────────────────────────────────────────────────────────────────

export type BackgroundMode = 'light' | 'dark' | 'unknown';

// ─── OSC 11 query ──────────────────────────────────────────────────────────

/** Send an OSC 11 query and return the raw response string, or null on timeout. */
function queryTerminalBackground(timeoutMs: number = 500): Promise<string | null> {
  return new Promise((resolve) => {
    // Only query if stdout is a TTY
    if (!process.stdout.isTTY) {
      resolve(null);
      return;
    }

    const stdin = process.stdin;
    if (!stdin.isTTY) {
      resolve(null);
      return;
    }

    const wasRaw = stdin.isRaw;

    const chunks: Buffer[] = [];
    let settled = false;

    const onData = (data: Buffer): void => {
      chunks.push(data);
      // OSC 11 responses end with BEL (\x07) or ST (\x1b\\)
      const str = Buffer.concat(chunks).toString('utf8');
      if (str.includes('\x07') || str.includes('\x1b\\')) {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(str);
        }
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        // If we got partial data, use it; otherwise null
        const str = Buffer.concat(chunks).toString('utf8');
        resolve(str.length > 0 ? str : null);
      }
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      stdin.off('data', onData);
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(wasRaw);
        } catch {
          // ignore
        }
      }
    };

    // Set raw mode temporarily and send query
    try {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.on('data', onData);
      // Raw stdout write: this is a terminal query (OSC 11) that requires an
      // immediate response from the terminal. Routing through OutputBuffer
      // could delay the query (if a frame is active) or interfere with the
      // synchronous read-response cycle below. OutputBuffer's a11y stripping
      // is intentionally bypassed here — the query sequence and its response
      // are terminal protocol, not user-facing output.
      process.stdout.write('\x1b]11;?\x07');
    } catch {
      cleanup();
      resolve(null);
    }
  });
}

// ─── Response parsing ──────────────────────────────────────────────────────

/**
 * Parse an OSC 11 response into RGB components.
 *
 * Common formats:
 *   \x1b]11;rgb:RRRR/GGGG/BBBB\x07     (16-bit per channel, XTerm)
 *   \x1b]11;rgb:RRRR/GGGG/BBBB\x1b\\   (16-bit, ST terminator)
 *   \x1b]11;rgb:RR/GG/BB\x07           (8-bit per channel)
 *   \x1b]11;#RRGGBB\x07                (hex format, some terminals)
 */
function parseOsc11Response(raw: string): { r: number; g: number; b: number } | null {
  // Strip leading OSC prefix
  let payload = raw;
  const oscPrefix = '\x1b]11;';
  const idx = payload.indexOf(oscPrefix);
  if (idx >= 0) {
    payload = payload.slice(idx + oscPrefix.length);
  }

  // Strip trailing terminator (BEL or ST)
  payload = payload.replace(/[\x07\x1b].*$/, '').trim();

  if (!payload) return null;

  // Hex format: #RRGGBB
  const hexMatch = payload.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (hexMatch) {
    return {
      r: Number.parseInt(hexMatch[1]!, 16),
      g: Number.parseInt(hexMatch[2]!, 16),
      b: Number.parseInt(hexMatch[3]!, 16),
    };
  }

  // rgb: format: rgb:RRRR/GGGG/BBBB or rgb:RR/GG/BB
  const rgbMatch = payload.match(
    /^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/,
  );
  if (rgbMatch) {
    const rStr = rgbMatch[1]!;
    const gStr = rgbMatch[2]!;
    const bStr = rgbMatch[3]!;
    // Normalize to 8-bit: if 4 hex digits, take top 2
    const to8 = (hex: string): number =>
      hex.length === 4 ? Number.parseInt(hex.slice(0, 2), 16) : Number.parseInt(hex, 16);
    return { r: to8(rStr), g: to8(gStr), b: to8(bStr) };
  }

  return null;
}

// ─── Luminance calculation ─────────────────────────────────────────────────

/**
 * Calculate relative luminance from sRGB components (0-255).
 * Uses the WCAG 2.0 formula.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Determine if a color is "light" or "dark" based on perceived brightness.
 * Uses a threshold of 0.5 relative luminance (WCAG definition: <0.5 = dark).
 */
function classifyLuminance(r: number, g: number, b: number): BackgroundMode {
  const lum = relativeLuminance(r, g, b);
  // > 0.5 → light background (use light theme)
  // < 0.18 → definitively dark background
  // 0.18–0.5 → ambiguous, lean dark (most common for terminals)
  if (lum > 0.5) return 'light';
  return 'dark';
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Cached result from the most recent detection. */
let cachedMode: BackgroundMode | null = null;

/**
 * Detect the terminal background color and return the inferred mode.
 *
 * Sends an OSC 11 query to the terminal, parses the response, and determines
 * whether the background is light or dark. Results are cached after the first
 * successful detection.
 *
 * Respects `BABEL_THEME_MODE` env var override: if set to 'light' or 'dark',
 * detection is skipped entirely.
 *
 * @param timeoutMs  How long to wait for a response (default 500ms).
 * @returns 'light', 'dark', or 'unknown' if detection failed.
 */
export async function detectTerminalBackground(timeoutMs: number = 500): Promise<BackgroundMode> {
  // Env override takes precedence
  const envMode = env['BABEL_THEME_MODE'];
  if (envMode === 'light' || envMode === 'dark') {
    cachedMode = envMode;
    return envMode;
  }

  // Return cached result if available
  if (cachedMode !== null) return cachedMode;

  const raw = await queryTerminalBackground(timeoutMs);
  if (!raw) {
    cachedMode = 'unknown';
    return 'unknown';
  }

  const rgb = parseOsc11Response(raw);
  if (!rgb) {
    cachedMode = 'unknown';
    return 'unknown';
  }

  const mode = classifyLuminance(rgb.r, rgb.g, rgb.b);
  cachedMode = mode;
  return mode;
}

/**
 * Return the cached terminal background mode without re-querying.
 * Returns null if detection has not been run yet.
 */
export function terminalBackgroundMode(): BackgroundMode | null {
  return cachedMode;
}

/**
 * Reset the cached detection result (useful for testing or theme changes).
 */
export function resetTerminalDetection(): void {
  cachedMode = null;
}
