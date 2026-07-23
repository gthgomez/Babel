/**
 * Clipboard — SSH/tmux-aware OSC 52 clipboard integration with native platform fallback.
 *
 * Provides clipboard operations via OSC 52 escape sequences (most modern
 * terminals) with automatic fallback to platform-native commands (PowerShell
 * on Windows, pbcopy/pbpaste on macOS, xclip/xsel/wl-copy on Linux).
 *
 * The module is SSH/tmux/Zellij-aware, selecting the correct clipboard strategy
 * for the current session environment. The priority chain is:
 *
 *   SSH + tmux:     tmux load-buffer -w-  → OSC 52 passthrough → OSC 52 direct
 *   SSH only:       OSC 52 direct
 *   Local tmux:     tmux load-buffer -w-  → OSC 52 passthrough → native → OSC 52 direct
 *   Zellij:         OSC 52 direct → native
 *   Local (no mux): native → OSC 52 direct
 *
 * OSC 52 is supported by: iTerm2, kitty, WezTerm, Ghostty, Windows Terminal,
 * Alacritty, foot, and most modern terminals. tmux requires the `set-clipboard`
 * option and passthrough wrapping via `\x1bPtmux;\x1b...\x1b\\`.
 *
 * When OSC 52 is unavailable (non-TTY, CI, SSH without passthrough), the
 * module falls back to native clipboard commands.
 *
 * Usage:
 *   import { copyToClipboard, isClipboardSupported } from './clipboard.js';
 *
 *   if (isClipboardSupported()) {
 *     copyToClipboard('Hello, world!');
 *   }
 *
 * Security note: OSC 52 writes are rate-limited per-terminal-spec (usually
 * one write per user interaction). This module does NOT enforce rate limits —
 * callers should gate writes on explicit user copy actions.
 *
 * @module clipboard
 */

import { supportsColor } from './theme.js';
import { execSync as nodeExecSync, type ExecSyncOptions } from 'node:child_process';
import {
  isNativeClipboardSupported,
  copyToClipboardNativeSync,
  readFromClipboardNative,
} from './clipboard-native.js';

// ── Dependency injection (testability) ─────────────────────────────────

/** @internal The execSync implementation used for tmux commands. Override for tests. */
export let _execTmux: typeof nodeExecSync = nodeExecSync;

/** @internal Override execSync for tmux commands. Call with original to restore. */
export function _setExecSync(fn: typeof nodeExecSync): void {
  _execTmux = fn;
}

/** @internal Environment override for testing. */
export let _env: Record<string, string | undefined> = process.env;

/** @internal Override environment for testing. */
export function _setEnv(e: Record<string, string | undefined>): void {
  _env = e;
}

/** @internal Override stdout for testing. */
export let _stdout: typeof process.stdout = process.stdout;

/** @internal Override stdout for testing. */
export function _setStdout(s: typeof process.stdout): void {
  _stdout = s;
}

/** @internal Override stdin for testing. */
export let _stdin: typeof process.stdin = process.stdin;

/** @internal Override stdin for testing. */
export function _setStdin(s: typeof process.stdin): void {
  _stdin = s;
}

// ── Detection ───────────────────────────────────────────────────────────────────

/**
 * Check whether clipboard operations are supported — either via OSC 52 or a
 * native platform clipboard tool.
 *
 * Returns true if:
 * - The terminal supports OSC 52 (TTY, not CI, not NO_COLOR, color capable), OR
 * - A native clipboard tool (PowerShell, pbcopy, xclip, etc.) is available
 */
export function isClipboardSupported(): boolean {
  return _osc52Supported() || isNativeClipboardSupported();
}

/**
 * Check whether OSC 52 escape sequences are likely supported by the terminal.
 * Returns false for non-TTY output, CI environments, or when NO_COLOR is set
 * (since clipboard writes use the same channel as color).
 */
function _osc52Supported(): boolean {
  if (!_stdout.isTTY) return false;
  if (_env['CI']) return false;
  if (_env['NO_COLOR']) return false;
  return supportsColor(_stdout as any);
}

/**
 * Detect whether we're running inside an SSH session.
 *
 * Checks SSH_TTY, SSH_CLIENT, and SSH_CONNECTION environment variables set
 * by the SSH daemon.
 */
export function isSsh(): boolean {
  return !!(_env['SSH_TTY'] || _env['SSH_CLIENT'] || _env['SSH_CONNECTION']);
}

/**
 * Detect whether we're running inside Zellij.
 *
 * Zellij sets the `ZELLIJ` environment variable to a socket path.
 */
export function isZellij(): boolean {
  return (_env['ZELLIJ'] ?? '').length > 0;
}

/**
 * Detect whether we're running inside tmux.
 * tmux requires passthrough wrapping for OSC 52 to work.
 */
export function isTmux(): boolean {
  return (
    (_env['TMUX'] ?? '').length > 0 ||
    (_env['TERM'] ?? '').startsWith('tmux') ||
    (_env['TERM_PROGRAM'] ?? '') === 'tmux'
  );
}

/**
 * Detect whether we're running inside GNU Screen.
 * Screen also requires special handling.
 */
export function isScreen(): boolean {
  return (_env['STY'] ?? '').length > 0 || (_env['TERM'] ?? '').startsWith('screen');
}

/**
 * Alias for isScreen() — detect GNU Screen.
 *
 * Provided for naming consistency with isTmux(), isZellij(), etc.
 * GNU Screen sets the `STY` environment variable to the session name
 * and uses the `screen` terminal type.
 */
export function isGnuScreen(): boolean {
  return isScreen();
}

/**
 * Detect whether we're running inside a detached GNU Screen session.
 *
 * GNU Screen sets the `STY` environment variable when running inside a
 * screen session. When Screen is *detached* (session backgrounded), the
 * process has no controlling terminal, so stdout is not a TTY.
 *
 * In detached mode, Screen **does not forward OSC 52 sequences** to the
 * terminal emulator's clipboard, making clipboard writes silently fail.
 * Callers should detect this and either queue the write for when Screen
 * is reattached, or use a fallback mechanism.
 *
 * @returns true if we're inside Screen and stdout is not a TTY
 */
export function isScreenDetached(): boolean {
  if (!isScreen()) return false;
  // Screen in detached mode: STY is set but there's no controlling terminal
  return !_stdout.isTTY;
}

// ── Strategy implementations ─────────────────────────────────────────────────────

/**
 * Try to copy via tmux's native `load-buffer -w -` command.
 *
 * This is the most reliable path inside tmux because it writes directly to
 * tmux's paste buffer and lets tmux handle forwarding to the terminal
 * clipboard (when `set-clipboard` is enabled).
 *
 * Times out at 3000ms and silently returns false on any failure.
 */
function _tryTmuxBuffer(text: string): boolean {
  try {
    _execTmux('tmux load-buffer -w -', {
      input: text,
      timeout: 3000,
      stdio: ['pipe', 'ignore', 'pipe'],
    } satisfies ExecSyncOptions);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the raw OSC 52 escape sequence for the given text, clipped by
 * clipboard selection ('c' = system, 'p' = primary).
 */
function _buildOsc52(text: string, clipboard: 'c' | 'p'): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;${clipboard};${encoded}\x1b\\`;
}

/**
 * Try to copy via OSC 52 with tmux/screen DCS passthrough wrapping.
 *
 * Only succeeds if we are inside a tmux or screen session AND the terminal
 * supports OSC 52. When not in a passthrough-worthy session this returns
 * false, allowing the caller to fall through to another strategy.
 */
function _tryOsc52Passthrough(text: string, clipboard: 'c' | 'p'): boolean {
  if (!_osc52Supported()) return false;
  const osc52 = _buildOsc52(text, clipboard);

  if (isTmux()) {
    _stdout.write(`\x1bPtmux;\x1b${osc52}\x1b\\`);
    return true;
  }
  if (isScreen()) {
    _stdout.write(`\x1bP${osc52}\x1b\\`);
    return true;
  }
  return false;
}

/**
 * Universal OSC 52 copy — the catch-all fallback.
 *
 * Writes the OSC 52 sequence with appropriate wrapping:
 * - In tmux: wraps in DCS tmux passthrough
 * - In screen: wraps in DCS screen passthrough
 * - Otherwise: raw OSC 52 sequence
 *
 * Returns false only when OSC 52 is unavailable (non-TTY, CI, etc.).
 */
function _tryOsc52Direct(text: string, clipboard: 'c' | 'p'): boolean {
  if (!_osc52Supported()) return false;
  const osc52 = _buildOsc52(text, clipboard);

  if (isTmux()) {
    _stdout.write(`\x1bPtmux;\x1b${osc52}\x1b\\`);
  } else if (isScreen()) {
    _stdout.write(`\x1bP${osc52}\x1b\\`);
  } else {
    _stdout.write(osc52);
  }
  return true;
}

// ── Extended strategies ──────────────────────────────────────────────────────────

/**
 * Attempt to push the clipboard to the tmux host using `refresh-client -w`.
 *
 * Some tmux versions (3.4+, and some older builds with specific configurations)
 * require an explicit `refresh-client -w` command after the clipboard buffer
 * has been set, in order to actually forward it to the terminal emulator's
 * system clipboard.
 *
 * This function should be called AFTER the buffer has been loaded (e.g., via
 * `load-buffer -w`). Calling it standalone without a clipboard buffer set
 * is a no-op.
 *
 * @returns true if the refresh command was sent successfully
 */
export function tmuxRefreshClient(): boolean {
  if (!isTmux()) return false;
  try {
    _execTmux('tmux refresh-client -w', {
      timeout: 3000,
      stdio: ['ignore', 'ignore', 'pipe'],
    } satisfies ExecSyncOptions);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text to clipboard using a combined tmux `load-buffer` + `refresh-client`
 * approach.
 *
 * This is more thorough than `_tryTmuxBuffer()` alone — it first loads the
 * text into the tmux paste buffer with the `-w` flag (which attempts clipboard
 * forwarding), then explicitly sends `refresh-client -w` to force tmux to
 * push the buffer to the terminal emulator's system clipboard.
 *
 * Some tmux versions/hosts ignore the `-w` flag on `load-buffer` alone and
 * need the explicit `refresh-client -w` command to complete the handshake.
 *
 * @param text  The text to copy
 * @returns true if both the buffer load AND the refresh succeeded
 */
export function writeClipboardWithTmuxRefresh(text: string): boolean {
  if (!isTmux() || !text) return false;
  try {
    // Step 1: Load the text into tmux's paste buffer
    _execTmux('tmux load-buffer -w -', {
      input: text,
      timeout: 3000,
      stdio: ['pipe', 'ignore', 'pipe'],
    } satisfies ExecSyncOptions);

    // Step 2: Explicitly tell tmux to push the buffer to the host clipboard
    _execTmux('tmux refresh-client -w', {
      timeout: 3000,
      stdio: ['ignore', 'ignore', 'pipe'],
    } satisfies ExecSyncOptions);

    return true;
  } catch {
    return false;
  }
}

/**
 * Write text to the clipboard using Zellij's native `write-clipboard` action.
 *
 * Zellij provides a plugin-based clipboard mechanism via the `zellij` CLI:
 *   zellij action write-clipboard < <text>
 *
 * This is the most reliable path inside Zellij because it writes directly
 * to Zellij's internal clipboard without relying on OSC 52 passthrough.
 *
 * @param text  The text to copy
 * @returns true if the write succeeded
 */
export function zellijWriteClipboard(text: string): boolean {
  if (!isZellij() || !text) return false;
  try {
    _execTmux('zellij action write-clipboard', {
      input: text,
      timeout: 5000,
      stdio: ['pipe', 'ignore', 'pipe'],
    } satisfies ExecSyncOptions);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read text from the clipboard using Zellij's native clipboard.
 *
 * Note: Zellij does **not** currently expose a `read-clipboard` action
 * via the `zellij` CLI. The primary clipboard read path in Zellij is
 * through OSC 52 read requests (which most terminals block) or the
 * Zellij plugin API (which is not available from a shell command).
 *
 * This function always returns `null` today, but is provided as a
 * placeholder so callers can use a uniform API and will benefit once
 * Zellij adds read support.
 *
 * @returns Always null (read not supported via Zellij CLI)
 */
export function zellijReadClipboard(): string | null {
  // Zellij does not expose a read-clipboard action via its CLI.
  // Reading would require the Zellij plugin IPC socket.
  return null;
}

/**
 * Enhanced clipboard write with an extended priority chain.
 *
 * This is a **supplemental** entry point that does NOT replace the normal
 * `copyToClipboard()` — it adds additional strategies that are useful in
 * edge cases where the standard chain may fail:
 *
 * Priority:
 * 1. **Zellij native** — `zellij action write-clipboard` (when inside Zellij)
 * 2. **tmux refresh-client** — `load-buffer -w` + `refresh-client -w` (when inside tmux)
 * 3. **tmux load-buffer** — `tmux load-buffer -w -` (basic tmux buffer write)
 * 4. **OSC 52 DCS** — OSC 52 with tmux/Screen DCS passthrough wrapping
 * 5. **OSC 52 direct** — Raw OSC 52 sequence to the terminal
 * 6. **Native** — Platform-native command (PowerShell, pbcopy, xclip, etc.)
 *
 * Unlike `copyToClipboard()`, this function always tries ALL applicable
 * strategies in priority order, rather than selecting a subset based on
 * the session environment. This makes it slower but more thorough.
 *
 * @param text  The text to copy
 * @returns true if ANY strategy succeeded
 */
export function writeClipboardEnhanced(text: string): boolean {
  if (!text) return false;

  // 1. Zellij native
  if (isZellij() && zellijWriteClipboard(text)) return true;

  // 2. tmux refresh-client (load-buffer + refresh)
  if (isTmux() && writeClipboardWithTmuxRefresh(text)) return true;

  // 3. tmux load-buffer (basic)
  if (isTmux() && _tryTmuxBuffer(text)) return true;

  // 4. OSC 52 DCS passthrough
  if (_tryOsc52Passthrough(text, 'c')) return true;

  // 5. OSC 52 direct
  if (_tryOsc52Direct(text, 'c')) return true;

  // 6. Native
  if (copyToClipboardNativeSync(text)) return true;

  return false;
}

// ── Strategy injection (for testing) ─────────────────────────────────────────────

/**
 * Shape of the injectable strategy functions used by the priority chain.
 */
export interface CopyStrategies {
  tmuxBuffer: (text: string) => boolean;
  osc52Passthrough: (text: string, clipboard: 'c' | 'p') => boolean;
  osc52Direct: (text: string, clipboard: 'c' | 'p') => boolean;
  native: (text: string) => boolean;
}

/**
 * Internal copy entry point with injected strategy implementations.
 *
 * This is the core priority-chain logic, factored out so that unit tests
 * can inject mock strategy functions and verify the fallthrough order
 * without touching real clipboard APIs, terminal I/O, or child processes.
 *
 * The chain selection depends on the session environment (detected via
 * `isSsh()`, `isZellij()`, `isTmux()` from the injected `_env`).
 *
 * @internal
 */
export function _copyToClipboardWith(
  text: string,
  clipboard: 'c' | 'p',
  strategies: CopyStrategies,
): boolean {
  if (!text) return false;

  // ── SSH + tmux ──────────────────────────────────────────────────────────
  if (isSsh() && isTmux()) {
    // Over SSH the native clipboard belongs to the remote machine, so we
    // only use terminal-mediated strategies.
    return (
      strategies.tmuxBuffer(text) ||
      strategies.osc52Passthrough(text, clipboard) ||
      strategies.osc52Direct(text, clipboard)
    );
  }

  // ── SSH only (no tmux) ──────────────────────────────────────────────────
  if (isSsh()) {
    // OSC 52 direct is the only viable path — native clipboard would write
    // to the remote machine's clipboard, not the local terminal emulator's.
    return strategies.osc52Direct(text, clipboard);
  }

  // ── Local tmux ──────────────────────────────────────────────────────────
  if (isTmux()) {
    return (
      strategies.tmuxBuffer(text) ||
      strategies.osc52Passthrough(text, clipboard) ||
      strategies.native(text) ||
      strategies.osc52Direct(text, clipboard)
    );
  }

  // ── Zellij ──────────────────────────────────────────────────────────────
  if (isZellij()) {
    // Zellij supports OSC 52 natively without passthrough wrapping.
    return (
      strategies.osc52Direct(text, clipboard) || strategies.native(text)
    );
  }

  // ── Local (no multiplexer) ──────────────────────────────────────────────
  return strategies.native(text) || strategies.osc52Direct(text, clipboard);
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Returns a human-readable name for the active copy strategy that
 * `copyToClipboard()` will try first based on the current session
 * environment.
 *
 * Useful for diagnostic display (e.g., `/doctor` command) and debugging.
 *
 * Return values:
 *   'tmux-buffer'   — tmux `load-buffer -w -` (in tmux, local or SSH)
 *   'osc52'         — OSC 52 direct (SSH only, no tmux)
 *   'osc52-direct'  — OSC 52 direct (Zellij)
 *   'native'        — Platform-native clipboard command
 *   'none'          — No strategy available
 */
export function getClipboardStrategy(): string {
  if (isSsh() && isTmux()) return 'tmux-buffer';
  if (isSsh()) return 'osc52';
  if (isTmux()) return 'tmux-buffer';
  if (isZellij()) return 'osc52-direct';
  if (isNativeClipboardSupported()) return 'native';
  if (_osc52Supported()) return 'osc52';
  return 'none';
}

/**
 * Copy text to the system clipboard.
 *
 * Selects the best strategy for the current session environment:
 *
 * | Environment    | 1st              | 2nd                | 3rd          | 4th     |
 * |----------------|------------------|--------------------|--------------|---------|
 * | SSH + tmux     | tmux load-buffer | OSC 52 passthrough | OSC 52 direct | —       |
 * | SSH only       | OSC 52 direct    | —                  | —            | —       |
 * | Local tmux     | tmux load-buffer | OSC 52 passthrough | native       | OSC 52  |
 * | Zellij         | OSC 52 direct    | native             | —            | —       |
 * | Local (no mux) | native           | OSC 52 direct      | —            | —       |
 *
 * Failures silently fall through to the next strategy. Clipboard failures
 * never throw.
 *
 * @param text  The text to copy to clipboard
 * @param clipboard  Clipboard selection: 'c' (system/default) or 'p' (primary)
 * @returns true if any strategy succeeded
 */
export function copyToClipboard(text: string, clipboard: 'c' | 'p' = 'c'): boolean {
  return _copyToClipboardWith(text, clipboard, {
    tmuxBuffer: _tryTmuxBuffer,
    osc52Passthrough: _tryOsc52Passthrough,
    osc52Direct: _tryOsc52Direct,
    native: copyToClipboardNativeSync,
  });
}

/**
 * Copy text to clipboard and return a confirmation message suitable for
 * inline display in the TUI.
 *
 * @returns A brief success/failure message (no trailing newline)
 */
export function copyToClipboardWithFeedback(text: string): string {
  if (!text) return 'Nothing to copy';
  if (!isClipboardSupported()) return 'Clipboard not available (no TTY or native tool)';

  const success = copyToClipboard(text);
  if (!success) return 'Failed to write to clipboard';

  const byteLen = Buffer.byteLength(text, 'utf8');
  const preview =
    text.length > 40 ? text.slice(0, 40).replace(/\n/g, '↵') + '…' : text.replace(/\n/g, '↵');
  return `Copied to clipboard (${_formatBytes(byteLen)}): "${preview}"`;
}

/**
 * Read from the system clipboard.
 *
 * Strategy:
 * 1. Try OSC 52 read request (terminal-native, but most terminals block reads)
 * 2. If OSC 52 fails and we're local, fall back to native platform commands.
 *    Over SSH, skip native fallback (would read the remote clipboard).
 *
 * @param clipboard  Clipboard selection: 'c' (system) or 'p' (primary)
 * @returns A promise that resolves with clipboard text, or null if unsupported
 */
export function readFromClipboard(clipboard: 'c' | 'p' = 'c'): Promise<string | null> {
  // Try OSC 52 first
  if (_osc52Supported()) {
    return new Promise<string | null>((resolve) => {
      const request = `\x1b]52;${clipboard};?\x1b\\`;
      const wrapped = isTmux()
        ? `\x1bPtmux;\x1b${request}\x1b\\`
        : isScreen()
          ? `\x1bP${request}\x1b\\`
          : request;

      // OSC 52 reads return on stdin. Most terminals block this, so we
      // timeout after 500ms.
      const timeout = setTimeout(() => {
        cleanup();
        if (isTmux()) {
          const tmuxVal = readFromTmuxBuffer();
          if (tmuxVal !== null) {
            resolve(tmuxVal);
            return;
          }
        }
        if (isSsh()) {
          // Over SSH, native clipboard reads from the remote machine
          // which is not useful — return null.
          resolve(null);
        } else {
          _fallbackRead(resolve);
        }
      }, 500);

      const onData = (data: Buffer) => {
        const str = data.toString('utf8');
        // Parse OSC 52 response: \x1b]52;c;<base64>\x1b\\
        const match = str.match(/\x1b\]52;[cp];([A-Za-z0-9+/=]*)\x1b\\/);
        if (match && match[1]) {
          clearTimeout(timeout);
          cleanup();
          try {
            resolve(Buffer.from(match[1], 'base64').toString('utf8'));
          } catch {
            resolve(null);
          }
        }
      };

      const cleanup = () => {
        _stdin.off('data', onData);
      };

      _stdin.on('data', onData);
      _stdout.write(wrapped);
    });
  }

  // OSC 52 not supported
  if (isTmux()) {
    const tmuxVal = readFromTmuxBuffer();
    if (tmuxVal !== null) {
      return Promise.resolve(tmuxVal);
    }
  }

  if (isSsh()) {
    // Over SSH — skip native clipboard fallback
    return Promise.resolve(null);
  }

  // Go straight to native fallback
  return readFromClipboardNative();
}

/**
 * Fallback read: try native clipboard, resolve with result.
 */
async function _fallbackRead(resolve: (value: string | null) => void): Promise<void> {
  const result = await readFromClipboardNative();
  resolve(result);
}

/**
 * Read the current tmux paste buffer using tmux save-buffer -.
 * Returns the decoded string if successful, or null on error.
 */
export function readFromTmuxBuffer(): string | null {
  try {
    const res = _execTmux('tmux save-buffer -', { stdio: ['ignore', 'pipe', 'ignore'] });
    return res.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Detect the current terminal environment and assess clipboard support.
 *
 * Examines environment variables and terminal state to determine which
 * terminal multiplexer (if any) is active, whether clipboard operations
 * are supported, and what limitations exist.
 *
 * @returns An object describing the terminal environment
 */
export function detectClipboardEnvironment(): {
  terminal: 'tmux' | 'zellij' | 'screen' | 'native' | 'unknown';
  clipboardSupported: boolean;
  limitations: string[];
} {
  const limitations: string[] = [];

  if (isTmux()) {
    limitations.push(
      'OSC 52 requires tmux `set-clipboard` option to be enabled',
    );
    limitations.push(
      'tmux may refuse to forward clipboard to terminal without `refresh-client -w`',
    );
    return {
      terminal: 'tmux',
      clipboardSupported: isClipboardSupported(),
      limitations,
    };
  }

  if (isZellij()) {
    return {
      terminal: 'zellij',
      clipboardSupported: isClipboardSupported(),
      limitations: [],
    };
  }

  if (isScreen()) {
    if (isScreenDetached()) {
      limitations.push(
        'Screen is detached — OSC 52 sequences are not forwarded to the terminal',
      );
      limitations.push(
        'Native clipboard commands are not available (no controlling terminal)',
      );
    } else {
      limitations.push(
        'Screen clipboard forwarding requires `set-clipboard` option',
      );
      limitations.push(
        'Screen may strip OSC 52 sequences in older versions',
      );
    }
    return {
      terminal: 'screen',
      clipboardSupported: isClipboardSupported() && !isScreenDetached(),
      limitations,
    };
  }

  if (isNativeClipboardSupported()) {
    return {
      terminal: 'native',
      clipboardSupported: true,
      limitations: [],
    };
  }

  limitations.push('No TTY detected (non-interactive session)');
  limitations.push('No native clipboard tool available');
  return {
    terminal: 'unknown',
    clipboardSupported: false,
    limitations,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function _formatBytes(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
