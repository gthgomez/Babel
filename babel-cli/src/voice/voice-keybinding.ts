/**
 * VoiceKeybinding — Registers the voice dictation hotkey within Babel's
 * existing keybinding system and PromptInput.
 *
 * Default hotkey: Ctrl+Shift+V (not used by PromptInput or any existing
 * Babel keybinding). Configurable via BABEL_VOICE_HOTKEY env var.
 *
 * Architecture: Push-to-Talk (PTT) model.
 * The hotkey acts as a hold-to-record trigger — press-and-hold to capture
 * audio, release to stop and begin refinement. VAD-based auto-start/stop
 * is a Phase 2 enhancement.
 *
 * @module voice/voice-keybinding
 */

import type { VoiceStreamManager } from './voice-stream-manager.js';
import type { PromptInput } from '../ui/promptInput.js';
import type { KeyEvent } from '../ui/keyInput.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface VoiceHotkeyConfig {
  /** Key name (normalised, lowercase). */
  name: string;
  /** Ctrl modifier required. */
  ctrl?: boolean;
  /** Shift modifier required. */
  shift?: boolean;
  /** Alt/Meta modifier required. */
  meta?: boolean;
}

export const DEFAULT_VOICE_HOTKEY: VoiceHotkeyConfig = {
  name: 'v',
  ctrl: true,
  shift: true,
  meta: false,
};

// ── Hotkey parser ───────────────────────────────────────────────────────────

/**
 * Parse a hotkey string into a VoiceHotkeyConfig.
 *
 * Supported formats:
 *   "Ctrl+Shift+V"  → { name: 'v', ctrl: true, shift: true }
 *   "Alt+V"          → { name: 'v', meta: true }
 *   "Ctrl+Shift+Alt+V" → all modifiers
 *
 * The key name is always lowercased.
 */
export function parseHotkeyString(hotkey: string): VoiceHotkeyConfig {
  const parts = hotkey.toLowerCase().split('+');
  const config: VoiceHotkeyConfig = { name: '' };

  for (const part of parts) {
    const trimmed = part.trim();
    switch (trimmed) {
      case 'ctrl':
      case 'control':
        config.ctrl = true;
        break;
      case 'shift':
        config.shift = true;
        break;
      case 'alt':
      case 'meta':
      case 'option':
        config.meta = true;
        break;
      default:
        config.name = trimmed;
    }
  }

  return config;
}

/**
 * Check whether a KeyEvent matches a VoiceHotkeyConfig.
 */
export function matchesHotkey(event: KeyEvent, config: VoiceHotkeyConfig): boolean {
  if (event.name !== config.name) return false;
  if ((config.ctrl ?? false) !== event.ctrl) return false;
  if ((config.shift ?? false) !== event.shift) return false;
  if ((config.meta ?? false) !== event.meta) return false;
  return true;
}

// ── VoiceKeybindingManager ──────────────────────────────────────────────────

/**
 * Manages the voice dictation hotkey lifecycle.
 *
 * Uses a press-and-hold pattern:
 *   keydown  → startCapture()
 *   keyup    → stopCapture()
 *
 * Key-repeat suppression: the terminal sends repeated keydown events while
 * a key is held. We track the held state to only call startCapture() once.
 */
export class VoiceKeybindingManager {
  private voiceManager: VoiceStreamManager;
  private promptInput: PromptInput | null = null;
  private hotkey: VoiceHotkeyConfig;
  private isHeld = false;
  private unregisterKeyHandler: (() => void) | null = null;
  private unregisterSubmit: (() => void) | null = null;

  constructor(
    voiceManager: VoiceStreamManager,
    hotkey?: Partial<VoiceHotkeyConfig>,
  ) {
    this.voiceManager = voiceManager;
    this.hotkey = { ...DEFAULT_VOICE_HOTKEY, ...hotkey };
  }

  /**
   * Register the voice hotkey with a PromptInput instance.
   * Called when the REPL starts and PromptInput is created.
   */
  register(promptInput: PromptInput): void {
    this.promptInput = promptInput;

    // Hook into PromptInput's submit listener for user activity detection
    this.unregisterSubmit = promptInput.onSubmit(() => {
      this.voiceManager.notifyUserActivity();
    });
  }

  /**
   * Handle a key event — called by PromptInput's key handler.
   * Returns true if the event was consumed (was the voice hotkey).
   */
  handleKeyEvent(event: KeyEvent): boolean {
    if (!matchesHotkey(event, this.hotkey)) return false;

    if (!this.isHeld) {
      // Key pressed — start capture
      this.isHeld = true;
      if (this.promptInput) {
        this.voiceManager.startCapture(this.promptInput).catch((err) => {
          console.error('[VoiceKeybinding] Failed to start capture:', err);
        });
      }
    }
    // Suppress the key from reaching the text buffer
    return true;
  }

  /**
   * Handle hotkey release — called when the key is no longer held.
   * Terminal key-up detection is unreliable; we use a short debounce.
   */
  handleRelease(): void {
    if (this.isHeld) {
      this.isHeld = false;
      this.voiceManager.stopCapture().catch((err) => {
        console.error('[VoiceKeybinding] Failed to stop capture:', err);
      });
    }
  }

  /**
   * Unregister all hooks. Called on app exit.
   */
  unregister(): void {
    if (this.unregisterKeyHandler) {
      this.unregisterKeyHandler();
      this.unregisterKeyHandler = null;
    }
    if (this.unregisterSubmit) {
      this.unregisterSubmit();
      this.unregisterSubmit = null;
    }
    this.promptInput = null;
    this.isHeld = false;
  }

  /** Get the current hotkey config. */
  getHotkey(): VoiceHotkeyConfig {
    return { ...this.hotkey };
  }
}

// ── Convenience function ────────────────────────────────────────────────────

/**
 * Create a VoiceKeybindingManager from an env-var hotkey string.
 *
 * Reads BABEL_VOICE_HOTKEY from process.env.
 * Falls back to Ctrl+Shift+V if not set.
 */
export function createVoiceKeybinding(
  voiceManager: VoiceStreamManager,
): VoiceKeybindingManager {
  const envHotkey = process.env['BABEL_VOICE_HOTKEY'];
  const hotkey = envHotkey
    ? parseHotkeyString(envHotkey)
    : DEFAULT_VOICE_HOTKEY;

  return new VoiceKeybindingManager(voiceManager, hotkey);
}
