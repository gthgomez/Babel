/**
 * Clipboard — Native platform clipboard integration.
 *
 * Provides clipboard read/write via child_process commands as a fallback
 * when OSC 52 is unavailable.
 *
 * Platform support:
 * - Windows: PowerShell Set-Clipboard / Get-Clipboard
 * - macOS: pbcopy / pbpaste
 * - Linux: xclip (X11) → xsel (X11) → wl-copy/wl-paste (Wayland)
 *
 * Usage:
 *   import { copyToClipboardNative, isNativeClipboardSupported }
 *     from './clipboard-native.js';
 *
 *   if (isNativeClipboardSupported()) {
 *     await copyToClipboardNative('Hello, world!');
 *   }
 *
 * @module clipboard-native
 */

import { execSync as nodeExecSync, type ExecSyncOptions } from 'node:child_process';

// ── Dependency injection (testability) ─────────────────────────────────────────

/** @internal The execSync implementation used by this module. Override for tests. */
export let _execSync: typeof nodeExecSync = nodeExecSync;

/** @internal Override execSync for testing. Call with original to restore. */
export function _setExecSync(fn: typeof nodeExecSync): void {
  _execSync = fn;
}

/** @internal Platform override for testing. */
export let _platform: NodeJS.Platform = process.platform;

/** @internal Override platform for testing. */
export function _setPlatform(p: NodeJS.Platform): void {
  _platform = p;
}

/** @internal Environment override for testing. */
export let _env: Record<string, string | undefined> = process.env;

/** @internal Override environment for testing. */
export function _setEnv(e: Record<string, string | undefined>): void {
  _env = e;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Check whether a command exists on the system PATH.
 */
function commandExists(command: string): boolean {
  try {
    const opts: ExecSyncOptions = { stdio: 'ignore', timeout: 1000 };
    if (_platform === 'win32') {
      _execSync(`where ${command}`, opts);
    } else {
      _execSync(`command -v ${command}`, opts);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Check whether native clipboard operations are supported on this platform.
 *
 * Tool requirements by platform:
 * - Windows: PowerShell (always available on modern Windows)
 * - macOS: pbcopy / pbpaste (always available)
 * - Linux: xclip, xsel, or wl-copy (check preferred tool per display server)
 *
 * @returns true if a native clipboard tool is available
 */
export function isNativeClipboardSupported(): boolean {
  if (_platform === 'win32') {
    return commandExists('powershell');
  }
  if (_platform === 'darwin') {
    return commandExists('pbcopy');
  }
  if (_platform === 'linux') {
    if (_env['WAYLAND_DISPLAY']) {
      return commandExists('wl-copy');
    }
    return commandExists('xclip') || commandExists('xsel');
  }
  return false;
}

/**
 * Synchronous native clipboard copy — internal implementation.
 * Used by both the async public API and the clipboard.ts fallback.
 *
 * @internal
 */
function _copyToClipboardNativeSync(text: string): boolean {
  if (!text) return false;

  try {
    switch (_platform) {
      case 'win32': {
        // Base64-encode to avoid PowerShell quoting and encoding issues
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        _execSync(
          `powershell -NoProfile -Command "[System.Text.Encoding]::UTF8.GetString(` +
            `[System.Convert]::FromBase64String('${b64}')) | Set-Clipboard"`,
          { timeout: 5000, stdio: 'pipe' },
        );
        return true;
      }
      case 'darwin': {
        _execSync('pbcopy', {
          input: text,
          timeout: 5000,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        return true;
      }
      case 'linux': {
        if (_env['WAYLAND_DISPLAY'] && commandExists('wl-copy')) {
          _execSync('wl-copy', {
            input: text,
            timeout: 5000,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } else if (commandExists('xclip')) {
          _execSync('xclip -selection clipboard', {
            input: text,
            timeout: 5000,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } else if (commandExists('xsel')) {
          _execSync('xsel --clipboard --input', {
            input: text,
            timeout: 5000,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } else {
          return false;
        }
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Copy text to the system clipboard via native platform commands.
 *
 * Platform-specific tools:
 * - Windows: `powershell Set-Clipboard` (base64-encoded to avoid quoting issues)
 * - macOS: `pbcopy` (stdin pipe)
 * - Linux: `wl-copy` (Wayland), `xclip -selection clipboard`, or `xsel --clipboard --input`
 *
 * @param text  The text to copy to the clipboard
 * @returns A promise resolving to true if the copy succeeded, false otherwise
 */
export async function copyToClipboardNative(text: string): Promise<boolean> {
  return _copyToClipboardNativeSync(text);
}

/**
 * Synchronous variant of copyToClipboardNative for use in synchronous code
 * paths (e.g., the clipboard.ts OSC 52 fallback).
 *
 * @param text  The text to copy to the clipboard
 * @returns true if the copy succeeded, false otherwise
 */
export function copyToClipboardNativeSync(text: string): boolean {
  return _copyToClipboardNativeSync(text);
}

/**
 * Read text from the system clipboard via native platform commands.
 *
 * Platform-specific tools:
 * - Windows: `powershell Get-Clipboard`
 * - macOS: `pbpaste`
 * - Linux: `wl-paste` (Wayland), `xclip -selection clipboard -o`, or `xsel --clipboard --output`
 *
 * @returns A promise resolving to clipboard text, or null if reading failed
 */
export function readFromClipboardNative(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      let result: Buffer;

      switch (_platform) {
        case 'win32': {
          result = _execSync('powershell -NoProfile -Command "Get-Clipboard"', {
            timeout: 5000,
            stdio: 'pipe',
          });
          break;
        }
        case 'darwin': {
          result = _execSync('pbpaste', { timeout: 5000, stdio: 'pipe' });
          break;
        }
        case 'linux': {
          if (_env['WAYLAND_DISPLAY'] && commandExists('wl-copy')) {
            result = _execSync('wl-paste', { timeout: 5000, stdio: 'pipe' });
          } else if (commandExists('xclip')) {
            result = _execSync('xclip -selection clipboard -o', {
              timeout: 5000,
              stdio: 'pipe',
            });
          } else if (commandExists('xsel')) {
            result = _execSync('xsel --clipboard --output', {
              timeout: 5000,
              stdio: 'pipe',
            });
          } else {
            resolve(null);
            return;
          }
          break;
        }
        default:
          resolve(null);
          return;
      }

      const text = result.toString('utf8').trim();
      resolve(text || null);
    } catch {
      resolve(null);
    }
  });
}
