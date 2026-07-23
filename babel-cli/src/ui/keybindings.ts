/**
 * Configurable keybinding system for Babel's TUI.
 *
 * Loads keybinding overrides from `~/.babel_keybindings.json` and maps
 * parsed KeyEvents to named actions. Falls back to built-in defaults
 * when no user config is present.
 *
 * Key format in JSON:
 *   "Ctrl+C", "Escape", "Enter", "Up", "Down", "a", "Shift+A",
 *   "Alt+x", "F1".."F12", "PageUp", "PageDown", "Home", "End",
 *   "Backspace", "Tab", "Space", "Insert", "Delete"
 *
 * Config structure:
 *   {
 *     "pager": {
 *       "quit": ["q", "Escape", "Ctrl+C"],
 *       "scroll_up": ["Up", "k"],
 *       ...
 *     },
 *     "dialog": {
 *       "confirm": ["Enter", "y"],
 *       "reject": ["Escape", "n"],
 *       ...
 *     },
 *     "global": {
 *       "suspend": ["Ctrl+Z"]
 *     }
 *   }
 *
 * @module keybindings
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { KeyEvent } from './keyInput.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Recognized action names across all UI contexts. */
export type BindingAction = string;

/** Map of action name → array of key descriptor strings. */
export type BindingMap = Record<string, string[]>;

/** Top-level keybinding config shape. */
export interface KeybindingConfig {
  global?: BindingMap;
  pager?: BindingMap;
  dialog?: BindingMap;
  palette?: BindingMap;
  prompt?: BindingMap;
  chat?: BindingMap;
  governed?: BindingMap;
  thinking?: BindingMap;
  streaming?: BindingMap;
  search?: BindingMap;
  [context: string]: BindingMap | undefined;
}

// ─── Default bindings ───────────────────────────────────────────────────────

export const DEFAULT_BINDINGS: Required<
  Pick<
    KeybindingConfig,
    | 'pager'
    | 'dialog'
    | 'palette'
    | 'prompt'
    | 'global'
    | 'chat'
    | 'governed'
    | 'thinking'
    | 'streaming'
    | 'search'
    | 'pane'
  >
> = {
  global: {
    suspend: ['Ctrl+Z'],
  },
  // ── Chat mode (ConversationalRenderer) ──────────────────────────────────
  chat: {
    cancel: ['Escape'],
    pause_toggle: ['p'],
    thought_toggle: ['t'],
    cancel_double: ['Ctrl+C'], // double-tap to exit; single = cancel
    scroll_to_bottom: ['End'],
    scroll_up: ['PageUp'],
    scroll_down: ['PageDown'],
  },
  // ── Governed pipeline (WaterfallRenderer) ───────────────────────────────
  governed: {
    cancel: ['Escape'],
    pause_toggle: ['p'],
    thought_toggle: ['t'],
    dismiss_error: ['Enter'],
    cancel_double: ['Ctrl+C'],
    scroll_to_bottom: ['End'],
    scroll_up: ['PageUp'],
    scroll_down: ['PageDown'],
  },
  // ── Thinking phase (before first answer chunk) ──────────────────────────
  thinking: {
    cancel: ['Escape'],
    cancel_double: ['Ctrl+C'],
  },
  // ── Streaming phase (answer chunks arriving) ─────────────────────────────
  streaming: {
    cancel: ['Escape'],
    pause_toggle: ['p'],
    thought_toggle: ['t'],
    cancel_double: ['Ctrl+C'],
    scroll_to_bottom: ['End'],
    scroll_up: ['PageUp'],
    scroll_down: ['PageDown'],
  },
  // ── Search mode (within pager) ──────────────────────────────────────────
  search: {
    confirm: ['Enter'],
    cancel: ['Escape', 'Ctrl+C'],
    delete_left: ['Backspace'],
  },
  // ── Existing contexts ───────────────────────────────────────────────────
  pager: {
    quit: ['q', 'Escape', 'Ctrl+C'],
    scroll_up: ['Up', 'k'],
    scroll_down: ['Down', 'j'],
    page_up: ['PageUp', 'Ctrl+U'],
    page_down: ['PageDown', 'Ctrl+D'],
    top: ['Home', 'g'],
    bottom: ['End', 'G', 'Shift+G'],
    search: ['/'],
    search_next: ['n'],
    search_prev: ['N', 'Shift+N'],
  },
  dialog: {
    confirm: ['Enter', 'y'],
    reject: ['Escape', 'n'],
    focus_next: ['Tab', 'Right'],
    focus_prev: ['Left', 'Shift+Tab'],
    select_up: ['Up'],
    select_down: ['Down'],
    toggle: ['Space'],
    delete_left: ['Backspace'],
    clear_input: ['Ctrl+U'],
  },
  palette: {
    confirm: ['Enter'],
    reject: ['Escape', 'Ctrl+C'],
    select_up: ['Up'],
    select_down: ['Down'],
    delete_left: ['Backspace'],
    clear_input: ['Ctrl+U'],
  },
  // ── Pane management ──────────────────────────────────────────
  pane: {
    prefix: ['Ctrl+P'],
    close_pane: ['Ctrl+W'],
    focus_next: ['Tab'],
    focus_prev: ['Shift+Tab'],
    split_vertical: ['Ctrl+P', 'v'],
    split_horizontal: ['Ctrl+P', 's'],
    resize_decrease: ['Ctrl+P', '['],
    resize_increase: ['Ctrl+P', ']'],
    resize_left: ['Ctrl+P', 'Left'],
    resize_right: ['Ctrl+P', 'Right'],
    resize_up: ['Ctrl+P', 'Up'],
    resize_down: ['Ctrl+P', 'Down'],
  },
  prompt: {
    submit: ['Enter'],
    cancel: ['Escape', 'Ctrl+C'],
    history_prev: ['Up'],
    history_next: ['Down'],
    delete_left: ['Backspace'],
    delete_word: ['Ctrl+W'],
    clear_line: ['Ctrl+U'],
    move_left: ['Ctrl+B', 'Left'],
    move_right: ['Ctrl+F', 'Right'],
    home: ['Ctrl+A', 'Home'],
    end: ['Ctrl+E', 'End'],
    cut_line: ['Ctrl+K'],
    paste: ['Ctrl+Y'],
    open_external_editor: ['Ctrl+G'],
  },
};

// ─── Key serializer ─────────────────────────────────────────────────────────

/**
 * Convert a KeyEvent to its canonical string descriptor.
 * Inverse of the config parser — used for display and debugging.
 */
export function serializeKeyEvent(event: KeyEvent): string {
  const parts: string[] = [];
  if (event.ctrl) parts.push('Ctrl');
  if (event.meta) parts.push('Alt');
  if (event.shift) parts.push('Shift');

  // Normalize name for display
  const displayName =
    event.name.length === 1
      ? event.shift
        ? event.name.toUpperCase()
        : event.name
      : event.name.charAt(0).toUpperCase() + event.name.slice(1);

  parts.push(displayName);
  return parts.join('+');
}

/**
 * Parse a key descriptor string (e.g. "Ctrl+Shift+A") into a matcher
 * that can be tested against a KeyEvent.
 */
function parseKeyDescriptor(descriptor: string): (event: KeyEvent) => boolean {
  const normalized = descriptor.trim();
  const parts = normalized.split('+').map((p) => p.trim().toLowerCase());

  const wantsCtrl = parts.includes('ctrl');
  const wantsAlt = parts.includes('alt');
  const wantsShift = parts.includes('shift');

  // The last part is the key name (after stripping modifiers)
  const keyName = parts.filter((p) => !['ctrl', 'alt', 'shift'].includes(p)).join('+');

  // Build canonical lookup: map "escape" → "escape", "up" → "up", "a" → "a"
  const canonical = keyName.toLowerCase();

  // Special aliases
  const aliases: Record<string, string> = {
    esc: 'escape',
    return: 'enter',
    pgup: 'pageup',
    pgdn: 'pagedown',
    del: 'delete',
    ins: 'insert',
    bs: 'backspace',
    ' ': 'space',
    spacebar: 'space',
  };

  const resolved = aliases[canonical] ?? canonical;

  return (event: KeyEvent): boolean => {
    if (event.name !== resolved) return false;
    if (wantsCtrl !== event.ctrl) return false;
    if (wantsAlt !== event.meta) return false;
    // Shift: only check for letter/symbol keys; for named keys (F1, Enter, etc.) ignore
    if (resolved.length === 1) {
      // For single-char keys, shift determines case
      const wantsUpper = wantsShift;
      const isUpper = event.shift;
      if (wantsUpper !== isUpper) return false;
    }
    return true;
  };
}

// ─── KeybindingManager ──────────────────────────────────────────────────────

export class KeybindingManager {
  private static instance: KeybindingManager | null = null;

  private config: KeybindingConfig;
  private matchers: Map<string, Array<{ action: string; match: (e: KeyEvent) => boolean }>> =
    new Map();

  static getInstance(): KeybindingManager {
    if (!KeybindingManager.instance) {
      KeybindingManager.instance = new KeybindingManager();
    }
    return KeybindingManager.instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    KeybindingManager.instance = null;
  }

  private constructor() {
    this.config = this.loadConfig();
    this.buildMatchers();
  }

  /** Reload config from disk and rebuild matchers. */
  reload(): void {
    this.config = this.loadConfig();
    this.buildMatchers();
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  /**
   * Match a key event against the bindings for a given context.
   * Returns the action name, or null if no binding matched.
   */
  match(context: string, event: KeyEvent): string | null {
    // Check context-specific bindings first (highest priority)
    const ctxMatchers = this.matchers.get(context);
    if (ctxMatchers) {
      for (const { action, match } of ctxMatchers) {
        if (match(event)) return action;
      }
    }

    // Check global bindings last (lowest priority)
    const globalMatchers = this.matchers.get('global');
    if (globalMatchers) {
      for (const { action, match } of globalMatchers) {
        if (match(event)) return action;
      }
    }

    return null;
  }

  /**
   * Match a key event against a stack of active contexts.
   *
   * Contexts are checked in array order (first = highest priority).
   * Global bindings are always checked last (lowest priority).
   * Returns the first matching action, or null if nothing matched.
   *
   * @param contexts - Array of context names in priority order (index 0 = highest)
   * @param event - The parsed key event to match
   * @returns Action name or null
   *
   * Example:
   *   // During streaming with a dialog open:
   *   matchStack(['dialog', 'streaming', 'chat'], event)
   *   // 'dialog' is checked first, then 'streaming', then 'chat', then 'global'
   */
  matchStack(contexts: string[], event: KeyEvent): string | null {
    // Check each context in priority order
    for (const context of contexts) {
      const ctxMatchers = this.matchers.get(context);
      if (!ctxMatchers) continue;
      for (const { action, match } of ctxMatchers) {
        if (match(event)) return action;
      }
    }

    // Global bindings are always lowest priority
    const globalMatchers = this.matchers.get('global');
    if (globalMatchers) {
      for (const { action, match } of globalMatchers) {
        if (match(event)) return action;
      }
    }

    return null;
  }

  /**
   * Get the list of key descriptors for a given action in a context.
   * Useful for displaying help text ("q quit", "↑ scroll", etc.).
   */
  getBindings(context: string, action: string): string[] {
    const ctx = this.config[context];
    if (ctx && ctx[action]) return ctx[action]!;
    // Fall back to defaults
    const defaults = DEFAULT_BINDINGS as Record<string, BindingMap>;
    return defaults[context]?.[action] ?? [];
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private loadConfig(): KeybindingConfig {
    try {
      const path = join(homedir(), '.babel_keybindings.json');
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as KeybindingConfig;
    } catch {
      return {}; // No user config — use defaults
    }
  }

  private buildMatchers(): void {
    this.matchers.clear();

    // Merge user config over defaults (user bindings REPLACE, not merge, per action)
    const merged: Record<string, BindingMap> = {};

    for (const [context, defaults] of Object.entries(DEFAULT_BINDINGS)) {
      const userOverrides = this.config[context] ?? {};
      merged[context] = { ...defaults, ...userOverrides };
    }

    // Also include user-only contexts not in defaults
    for (const context of Object.keys(this.config)) {
      if (!merged[context]) {
        merged[context] = this.config[context]!;
      }
    }

    for (const [context, bindings] of Object.entries(merged)) {
      const ctxMatchers: Array<{ action: string; match: (e: KeyEvent) => boolean }> = [];
      for (const [action, descriptors] of Object.entries(bindings)) {
        for (const desc of descriptors) {
          try {
            const matchFn = parseKeyDescriptor(desc);
            ctxMatchers.push({ action, match: matchFn });
          } catch {
            // Silently skip malformed descriptors
          }
        }
      }
      this.matchers.set(context, ctxMatchers);
    }
  }
}
