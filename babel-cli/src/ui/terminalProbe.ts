/**
 * Terminal capability probe matrix for Babel's TUI.
 *
 * Queries the terminal for supported features and builds a capability
 * matrix used by renderers to adapt output. Detection is cached after
 * the first probe.
 *
 * Capabilities detected:
 *   - True color (24-bit) support
 *   - DEC 2026 Synchronized Update
 *   - DECSTBM scroll regions (hardware scroll region partitioning)
 *   - Kitty keyboard protocol
 *   - Sixel graphics
 *   - OSC 52 clipboard
 *   - SGR mouse protocol
 *   - Cursor shape control (DECSCUSR)
 *   - Unicode wide-char / emoji support
 *   - Terminal identity (TERM_PROGRAM, TERM)
 *
 * Usage:
 *   import { probeTerminalCapabilities, getCapability } from './terminalProbe.js';
 *   const caps = probeTerminalCapabilities();
 *   if (caps.sixel) { ... }
 *   // or
 *   if (getCapability('trueColor')) { ... }
 *
 * @module terminalProbe
 */

import supportsGraphics from 'supports-terminal-graphics';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TerminalCapabilities {
  /** Terminal supports 24-bit (true color) ANSI sequences */
  trueColor: boolean;
  /** Terminal supports DEC 2026 Synchronized Update */
  syncUpdate: boolean;
  /** Terminal supports DECSTBM scroll regions (hardware scroll partitioning).
   *  Used by TwoRegionStreaming for stable-scrollback + mutable-tail layout. */
  scrollRegions: boolean;
  /** Terminal supports kitty keyboard protocol (disambiguated key events) */
  kittyKbd: boolean;
  /** Terminal supports sixel bitmap graphics */
  sixel: boolean;
  /** Terminal supports OSC 52 clipboard access */
  clipboard: boolean;
  /** Terminal supports SGR mouse tracking (pixel-precise mouse events) */
  sgrMouse: boolean;
  /** Terminal supports cursor shape changes via DECSCUSR */
  cursorShape: boolean;
  /** Terminal supports emoji / wide characters (Unicode 9+) */
  emoji: boolean;
  /** DEC 2026 Synchronized Update after platform-specific overrides.
   *  Derived from syncUpdate with Windows Terminal/tmux constraints applied. */
  dec2026Sync: boolean;
  /** Kitty graphics protocol (high-quality inline images) */
  kittyGraphics: boolean;
  /** iTerm2 inline image protocol */
  iterm2Graphics: boolean;
  /** Any image protocol is available */
  anyGraphics: boolean;
  /** Terminal emulator name (TERM_PROGRAM or "unknown") */
  terminalProgram: string;
  /** TERM value (e.g. "xterm-256color") */
  term: string;
  /** Whether this is a Windows Terminal / ConPTY host */
  isWindowsTerminal: boolean;
  /** Whether this is running inside tmux */
  isTmux: boolean;
  /** Whether this is a VS Code integrated terminal */
  isVSCode: boolean;
  /** Whether this is running over SSH */
  isSsh: boolean;
  /** Detected tmux version string (e.g. "3.3a") or null if not in tmux */
  tmuxVersion: string | null;
  /** Whether DEC 2026 passthrough is enabled in tmux (requires tmux 3.3+) */
  tmuxPassthrough: boolean;
  /** Whether mouse reporting is enabled in tmux */
  tmuxMouse: boolean;
  /** Whether OSC 52 clipboard passthrough is enabled in tmux */
  tmuxClipboard: boolean;
}

// ─── Known terminal capabilities ────────────────────────────────────────────

/** Terminals known to support specific features. */
const KNOWN_CAPABILITIES: Record<string, Partial<TerminalCapabilities>> = {
  wezterm: {
    trueColor: true,
    syncUpdate: true,
    scrollRegions: true,
    kittyKbd: true,
    sixel: true,
    clipboard: true,
    sgrMouse: true,
    cursorShape: true,
    emoji: true,
  },
  kitty: {
    trueColor: true,
    syncUpdate: true,
    scrollRegions: true,
    kittyKbd: true,
    sixel: true,
    clipboard: true,
    sgrMouse: true,
    cursorShape: true,
    emoji: true,
  },
  ghostty: {
    trueColor: true,
    syncUpdate: true,
    scrollRegions: true,
    kittyKbd: true,
    sixel: false,
    clipboard: true,
    sgrMouse: true,
    cursorShape: true,
    emoji: true,
  },
  iterm2: {
    trueColor: true,
    syncUpdate: true,
    scrollRegions: true,
    kittyKbd: false,
    sixel: true,
    clipboard: true,
    sgrMouse: true,
    cursorShape: true,
    emoji: true,
  },
  winterm: {
    trueColor: true,
    syncUpdate: true,
    scrollRegions: true,
    kittyKbd: false,
    sixel: false,
    clipboard: true,
    sgrMouse: true,
    cursorShape: true,
    emoji: true,
  },
  vscode: {
    trueColor: true,
    syncUpdate: true,
    scrollRegions: true,
    kittyKbd: false,
    sixel: false,
    clipboard: true,
    sgrMouse: true,
    cursorShape: false,
    emoji: true,
  },
  apple: {
    trueColor: false,
    syncUpdate: false,
    scrollRegions: false,
    kittyKbd: false,
    sixel: false,
    clipboard: false,
    sgrMouse: false,
    cursorShape: false,
    emoji: true,
  },
  '': {
    trueColor: false,
    syncUpdate: false,
    scrollRegions: false,
    kittyKbd: false,
    sixel: false,
    clipboard: false,
    sgrMouse: false,
    cursorShape: false,
    emoji: false,
  },
};

// ─── Shared terminal identity helpers ────────────────────────────────────────

/**
 * Detect the canonical terminal identity from TERM_PROGRAM.
 * Returns a key from KNOWN_CAPABILITIES, or 'unknown' if no match found.
 *
 * This is the single source of truth for terminal name detection.
 * Both probeTerminalCapabilities() and theme.ts's supportsTrueColor() use it
 * instead of duplicating inline termProgram.includes() checks.
 */
export function detectTerminalIdentity(): string {
  const termProgram = (process.env['TERM_PROGRAM'] ?? '').toLowerCase();
  for (const key of Object.keys(KNOWN_CAPABILITIES)) {
    if (key && termProgram.includes(key)) return key;
  }
  return 'unknown';
}

/**
 * Check whether the detected terminal supports true color based on its
 * identity alone (no TTY gating, no FORCE_COLOR handling).
 *
 * Returns true for terminals in KNOWN_CAPABILITIES with trueColor: true,
 * false otherwise (including unknown terminals). Callers should layer
 * FORCE_COLOR, NO_COLOR, and TTY gating on top as needed.
 */
export function getIdentityTrueColor(): boolean {
  const identity = detectTerminalIdentity();
  return KNOWN_CAPABILITIES[identity]?.trueColor ?? false;
}

/**
 * Detect whether the terminal is a modern Windows terminal (Windows Terminal,
 * VS Code integrated terminal on Windows, ConEmu, or any xterm-compatible
 * terminal on Windows).
 *
 * Moved from theme.ts to centralize terminal identity detection.
 */
export function isWindowsTerminal(): boolean {
  return (
    process.platform === 'win32' &&
    Boolean(
      process.env['WT_SESSION'] ||
      process.env['ConEmuANSI'] === 'ON' ||
      process.env['ANSICON'] !== undefined ||
      (process.env['TERM_PROGRAM'] ?? '').toLowerCase().includes('vscode') ||
      (process.env['TERM'] ?? '').toLowerCase().includes('xterm'),
    )
  );
}

/**
 * Returns true when running on a legacy Windows console (cmd.exe)
 * that lacks modern ANSI support.
 *
 * Moved from theme.ts alongside isWindowsTerminal().
 */
export function isLegacyWindowsConsole(): boolean {
  return process.platform === 'win32' && !isWindowsTerminal();
}

// ─── Detection ──────────────────────────────────────────────────────────────

let cachedCapabilities: TerminalCapabilities | null = null;

/** Parse an env override string to a boolean or undefined. */
function envOverride(key: string): boolean | undefined {
  const val = process.env[key];
  if (val === '1' || val === 'true' || val === 'on') return true;
  if (val === '0' || val === 'false' || val === 'off') return false;
  return undefined;
}

/**
 * Detect the tmux version. Checks BABEL_TMUX_VERSION env override first,
 * then attempts to parse `tmux -V` output. Only runs when TMUX is set.
 * Result is cached via the enclosing probeTerminalCapabilities() cache.
 */
function detectTmuxVersion(): string | null {
  const testOverride = process.env['BABEL_TMUX_VERSION'];
  if (testOverride !== undefined) return testOverride || null;

  if (!process.env['TMUX']) return null;

  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const result = execSync('tmux -V', { encoding: 'utf8', timeout: 2000 }) as string;
    const match = result.match(/tmux\s+([\d.]+[a-z]?)/i);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Parse a tmux version string into numeric components.
 * Returns null for unparseable strings.
 */
function parseTmuxVersion(
  versionStr: string,
): { major: number; minor: number; patch: number } | null {
  const match = versionStr.match(/^(\d+)\.(\d+)([a-z]?)$/);
  if (!match) return null;
  const suffix = match[3] ?? '';
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: suffix ? suffix.charCodeAt(0) - 96 : 0, // 'a' = 1, 'b' = 2, etc.
  };
}

/**
 * Probe the terminal for supported capabilities and return a capability
 * matrix. Results are cached after the first call.
 *
 * Detection strategy:
 *   1. Identify the terminal program from env vars (TERM_PROGRAM, TERM)
 *   2. Look up known capabilities for that terminal
 *   3. Fill in gaps with env-var based heuristics
 *   4. Apply tmux overrides when running inside tmux
 *   5. Return the merged capability matrix
 */
export function probeTerminalCapabilities(): TerminalCapabilities {
  if (cachedCapabilities) return cachedCapabilities;

  const termProgram = (process.env['TERM_PROGRAM'] ?? '').toLowerCase();
  const term = (process.env['TERM'] ?? '').toLowerCase();
  const colorterm = (process.env['COLORTERM'] ?? '').toLowerCase();

  // Identify terminal
  const isWinTerm = isWindowsTerminal();
  const isTmux = term.startsWith('tmux') || !!process.env['TMUX'];
  const isVSCode = termProgram.includes('vscode');
  const isSsh = !!(
    process.env['SSH_CLIENT'] ||
    process.env['SSH_TTY'] ||
    process.env['SSH_CONNECTION']
  );

  // Look up known capabilities
  const identity = detectTerminalIdentity();
  const known: Partial<TerminalCapabilities> = KNOWN_CAPABILITIES[identity] ?? {};

  // True color: check COLORTERM or known terminal
  const trueColor =
    known.trueColor !== undefined
      ? known.trueColor
      : colorterm.includes('truecolor') ||
        colorterm.includes('24bit') ||
        term.includes('xterm-direct');

  // Sync update: check known or TERM (may be overridden by tmux below)
  let syncUpdate =
    known.syncUpdate !== undefined
      ? known.syncUpdate
      : ['wezterm', 'kitty', 'ghostty', 'iterm2', 'winterm'].some((t) => termProgram.includes(t)) ||
        isVSCode;

  // Scroll regions (DECSTBM): supported by all modern terminals except
  // Apple Terminal.app and ancient terminals like vt100/linux console.
  // Also disabled in tmux < 3.3 where passthrough isn't available.
  const scrollRegions =
    known.scrollRegions !== undefined
      ? known.scrollRegions
      : !termProgram.includes('apple') &&
        !term.includes('vt100') &&
        !term.includes('vt220') &&
        !term.includes('linux');

  // Kitty keyboard: only kitty and WezTerm support this queryable protocol
  const kittyKbd =
    known.kittyKbd !== undefined
      ? known.kittyKbd
      : termProgram.includes('kitty') || termProgram.includes('wezterm');

  // Sixel: queryable via DA1, but for now check known terminals
  const sixel =
    known.sixel !== undefined
      ? known.sixel
      : termProgram.includes('wezterm') ||
        termProgram.includes('kitty') ||
        termProgram.includes('iterm');

  // Clipboard: most modern terminals support OSC 52
  const clipboard =
    known.clipboard !== undefined
      ? known.clipboard
      : process.env['SSH_CLIENT'] === undefined && !termProgram.includes('apple');

  // SGR mouse: most modern terminals support it
  const sgrMouse =
    known.sgrMouse !== undefined
      ? known.sgrMouse
      : !term.includes('vt100') && !term.includes('vt220');

  // Cursor shape: DECSCUSR is widely supported
  const cursorShape =
    known.cursorShape !== undefined
      ? known.cursorShape
      : !termProgram.includes('apple') && !term.includes('linux');

  // Emoji: check for Unicode 9+ support
  const emoji =
    known.emoji !== undefined
      ? known.emoji
      : (process.env['LANG']?.includes('UTF-8') ?? false) && !term.includes('linux');

  // ── Tmux overrides ─────────────────────────────────────────────────────

  let tmuxVersion: string | null = null;
  let tmuxPassthrough = false;
  let tmuxMouse = false;
  let tmuxClipboard = false;

  if (isTmux) {
    tmuxVersion = detectTmuxVersion();
    const parsed = tmuxVersion ? parseTmuxVersion(tmuxVersion) : null;
    const versionAtLeast33 =
      parsed !== null && (parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 3));

    // DEC 2026 sync update requires allow-passthrough (tmux 3.3+)
    const passthroughOverride = envOverride('BABEL_TMUX_PASSTHROUGH');
    tmuxPassthrough = passthroughOverride !== undefined ? passthroughOverride : versionAtLeast33;

    if (!tmuxPassthrough) {
      syncUpdate = false; // Override whatever was detected — no passthrough, no sync
    }

    tmuxMouse = envOverride('BABEL_TMUX_MOUSE') ?? false;
    tmuxClipboard = envOverride('BABEL_TMUX_CLIPBOARD') ?? false;
  }

  // ── Graphics detection ──────────────────────────────────────────────────

  const kittyGraphics = process.env['KITTY_WINDOW_ID'] !== undefined;
  const iterm2Graphics =
    process.env['ITERM_SESSION_ID'] !== undefined ||
    (process.env['TERM_PROGRAM'] ?? '') === 'iTerm.app';
  let sixelGraphics = sixel; // reuse known-cap answer first
  try {
    if (!sixelGraphics) {
      sixelGraphics = supportsGraphics.stdout.sixel === true;
    }
  } catch {
    // Detection failed — keep known-cap answer
  }
  const anyGraphics = kittyGraphics || sixelGraphics || iterm2Graphics;

  // ── DEC 2026 final gating ───────────────────────────────────────────────
  //
  // Windows Terminal has supported DEC 2026 Synchronized Update since
  // ~v1.22 (late 2024), but the feature interacts with ConPTY buffering.
  // Default to false on Windows Terminal unless the user explicitly
  // opts in with BABEL_WINTERM_SYNC=1.
  // Users on WezTerm, Kitty, Ghostty, iTerm2, and VS Code get dec2026Sync
  // per the known-capability table + tmux passthrough gating above.
  let dec2026Sync = syncUpdate;
  if (isWinTerm) {
    const wintermOverride = envOverride('BABEL_WINTERM_SYNC');
    dec2026Sync = wintermOverride ?? false;
  }

  // Also disable scroll regions when tmux passthrough is unavailable
  // (tmux intercepts DECSTBM and may not pass it through correctly)
  let effectiveScrollRegions = scrollRegions;
  if (isTmux && !tmuxPassthrough) {
    effectiveScrollRegions = false;
  }
  // Allow explicit override for testing / force-disable
  const scrollOverride = envOverride('BABEL_SCROLL_REGIONS');
  if (scrollOverride !== undefined) {
    effectiveScrollRegions = scrollOverride;
  }

  cachedCapabilities = {
    trueColor,
    syncUpdate,
    scrollRegions: effectiveScrollRegions,
    kittyKbd,
    sixel,
    clipboard,
    sgrMouse,
    cursorShape,
    emoji,
    dec2026Sync,
    kittyGraphics,
    iterm2Graphics,
    anyGraphics,
    terminalProgram: termProgram || 'unknown',
    term: term || 'unknown',
    isWindowsTerminal: isWinTerm,
    isTmux,
    isVSCode,
    isSsh,
    tmuxVersion,
    tmuxPassthrough,
    tmuxMouse,
    tmuxClipboard,
  };

  return cachedCapabilities;
}

/**
 * Get a single capability value. Probe is run if not yet cached.
 */
export function getCapability<K extends keyof TerminalCapabilities>(
  key: K,
): TerminalCapabilities[K] {
  return probeTerminalCapabilities()[key];
}

/**
 * Reset the cached capability matrix (useful for testing or after
 * terminal changes).
 */
export function resetTerminalProbe(): void {
  cachedCapabilities = null;
}

/**
 * Backward-compatible accessor for callers migrating from
 * terminalCapabilities.ts. Returns the full TerminalCapabilities object.
 * Use probeTerminalCapabilities() directly in new code.
 */
export function terminalCapsCompat(): TerminalCapabilities {
  return probeTerminalCapabilities();
}

/**
 * Return a human-readable summary of terminal capabilities.
 * Useful for debugging, bug reports, and the `/doctor` command.
 */
export function formatCapabilityReport(): string {
  const caps = probeTerminalCapabilities();
  const lines: string[] = [
    `Terminal: ${caps.terminalProgram} (TERM=${caps.term})`,
    `  True color:       ${caps.trueColor ? '✓ yes' : '✗ no'}`,
    `  Sync update:      ${caps.syncUpdate ? '✓ yes' : '✗ no'}`,
    `  DEC 2026 gated:   ${caps.dec2026Sync ? '✓ yes' : '✗ no'}${caps.isWindowsTerminal && !caps.dec2026Sync ? ' (Windows Terminal — set BABEL_WINTERM_SYNC=1 to enable)' : ''}`,
    `  Scroll regions:   ${caps.scrollRegions ? '✓ yes' : '✗ no'}`,
    `  Kitty keyboard:   ${caps.kittyKbd ? '✓ yes' : '✗ no'}`,
    `  Sixel graphics:   ${caps.sixel ? '✓ yes' : '✗ no'}`,
    `  OSC 52 clipboard: ${caps.clipboard ? '✓ yes' : '✗ no'}`,
    `  SGR mouse:        ${caps.sgrMouse ? '✓ yes' : '✗ no'}`,
    `  Cursor shape:     ${caps.cursorShape ? '✓ yes' : '✗ no'}`,
    `  Emoji support:    ${caps.emoji ? '✓ yes' : '✗ no'}`,
    `  Environment:      ${caps.isWindowsTerminal ? 'Windows Terminal' : caps.isTmux ? 'tmux' : caps.isVSCode ? 'VS Code' : caps.isSsh ? 'SSH' : 'standalone'}`,
  ];

  if (caps.isTmux) {
    lines.push(`  Tmux version:     ${caps.tmuxVersion ?? '(detected)'}`);
    lines.push(
      `  Tmux passthrough: ${caps.tmuxPassthrough ? '✓ enabled' : '✗ disabled (needed for DEC 2026)'}`,
    );
    lines.push(
      `  Tmux mouse:       ${caps.tmuxMouse ? '✓ on' : '✗ off (set "mouse on" in tmux.conf)'}`,
    );
    lines.push(
      `  Tmux clipboard:   ${caps.tmuxClipboard ? '✓ on' : '✗ off (set "set-clipboard on" in tmux.conf)'}`,
    );
  }

  if (caps.isSsh) {
    lines.push('  Connection:       SSH (remote)');
  }

  return lines.join('\n');
}

// ─── Terminal-specific scrollback/reflow caps ───────────────────────────────

/**
 * Per-terminal scrollback row limits for resize reflow.
 *
 * These caps are deliberately conservative: rebuilding more rows than the
 * terminal retains wastes work and makes resize feel worse without giving
 * the user more usable history.
 *
 * Values sourced from codex `resize_reflow_cap.rs`.
 */
const TERMINAL_REFLOW_CAPS: Record<string, number> = {
  vscode: 1000,
  winterm: 9001, // Windows Terminal
  wezterm: 3500,
};

/** Fallback for unknown terminals. */
const DEFAULT_REFLOW_CAP = 5000;

/**
 * Alacritty's documented scrollback default — used when Alacritty is detected.
 * We don't auto-detect Alacritty currently but expose this for future use.
 */
export const ALACRITTY_REFLOW_CAP = 10000;

/**
 * Get the recommended maximum scrollback lines for the current terminal.
 *
 * Uses the terminal identification from the capability probe to look up
 * a conservative row cap. Returns null if the caller should use its own
 * default (no cap enforced).
 */
export function getReflowCap(): number {
  const caps = probeTerminalCapabilities();
  const prog = caps.terminalProgram;

  // Check for VS Code first (may report as other terminals)
  if (caps.isVSCode) return TERMINAL_REFLOW_CAPS['vscode']!;

  // Check known terminal programs
  for (const [key, cap] of Object.entries(TERMINAL_REFLOW_CAPS)) {
    if (prog.includes(key)) return cap;
  }

  return DEFAULT_REFLOW_CAP;
}

/**
 * Calculate the effective scrollback capacity for this terminal.
 *
 * Combines the caller's desired capacity with the terminal-specific cap
 * to produce a safe limit.
 *
 * @param desiredCapacity - The caller's preferred capacity (e.g. 10000)
 * @returns The effective capacity clamped to terminal-safe bounds
 */
export function effectiveScrollbackCapacity(desiredCapacity: number): number {
  const cap = getReflowCap();
  return Math.min(desiredCapacity, cap);
}
