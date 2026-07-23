/**
 * PromptInput — multi-line text input widget for Babel's TUI.
 *
 * Replaces Node.js `readline` with a custom text input that supports:
 *   - Visible cursor and text buffer
 *   - Multi-line editing with word wrap
 *   - History navigation (up/down arrows)
 *   - Text navigation (Ctrl+A/E, Ctrl+Left/Right, Home/End, word jumps)
 *   - Paste handling (via bracketed paste from keyInput.ts)
 *   - Tab completion (compatible with existing completer function)
 *   - Vim mode (insert/normal/visual with status indicator). Enabled via PromptInputAdapter.
 *   - G2: operator+motion+text-object chaining via vimEngine (d/c/y + counts + iw/a( /…).
 *
 * Architecture:
 *   - Uses `keyInput.installKeyHandler()` for raw-mode key events
 *   - Manages a line-based text buffer with cursor tracking
 *   - Renders directly to stdout with absolute cursor positioning
 *   - Integrates with FrameScheduler for cursor blink animation
 *   - Emits submit events with the complete text buffer
 *
 * Usage:
 *   const input = new PromptInput({
 *     prompt: '› ',
 *     history: savedHistory,
 *     completer: (line) => [completions, line],
 *     onSubmit: (text) => { ... },
 *     onCancel: () => { ... },
 *   });
 *   input.activate();
 *   // ... user types ...
 *   input.deactivate();
 *
 * @module promptInput
 */

import { dim, muted, ghost, getEffectiveTerminalWidth, visibleLength } from './theme.js';
import { InlineAutocomplete } from './inlineAutocomplete.js';
import { installKeyHandler, type KeyEvent } from './keyInput.js';
import {
  computeImeCursorPos,
  cupSequence,
  shouldParkImeCursor,
} from './imeCursor.js';
import { FrameScheduler } from './frameScheduler.js';
import { OutputBuffer } from './outputBuffer.js';
import { fuzzyScore } from '../utils/fuzzy.js';
import { searchFilesGlob, type MentionResult } from './mentionPopup.js';
import { type SearchHit } from '../services/indexer.js';
import path from 'node:path';
import { PasteBurst } from './pasteBurst.js';
import {
  TypeaheadEngine,
  type TypeaheadViewState,
  type TypeaheadAcceptResult,
  type TypeaheadContext,
  filterSlashCommands,
} from './typeaheadEngine.js';
import { ComposerHistory } from './composerHistory.js';
import { PastePlaceholderStore } from './pastePlaceholders.js';
import {
  matchesHotkey,
  parseHotkeyString,
  DEFAULT_VOICE_HOTKEY,
} from '../voice/voice-keybinding.js';
import { handleNormalModeKey as dispatchNormalModeKey } from './promptInputNormalMode.js';

// ── Escape hatch ────────────────────────────────────────────────────────────────

/**
 * When set to '0', disables OutputBuffer frame wrapping for prompt rendering.
 * Writes still flow through OutputBuffer.write() (a11y sanitization, broken-pipe
 * detection) but without DEC 2026 beginFrame/endFrame delimiters.
 *
 * Remove after one week of dogfooding (per R1.3 rollout plan).
 */
const BABEL_PROMPT_BUFFERED = process.env['BABEL_PROMPT_BUFFERED'] !== '0';

const voiceHotkey = process.env['BABEL_VOICE_HOTKEY']
  ? parseHotkeyString(process.env['BABEL_VOICE_HOTKEY'])
  : DEFAULT_VOICE_HOTKEY;

// ── Types ───────────────────────────────────────────────────────────────────────

export interface PromptInputConfig {
  /** Prompt string displayed before the first line (e.g. "› ") */
  prompt?: string;
  /** Continuation prompt for subsequent lines (e.g. "· ") */
  continuationPrompt?: string;
  /** Initial history entries (oldest first) */
  history?: string[];
  /** Maximum history size */
  historySize?: number;
  /** Tab completer — matches Node.js readline's completer signature */
  completer?: (line: string) => [string[], string];
  /** Called when the user submits (e.g., presses Enter on an empty/submit line) */
  onSubmit: (text: string) => void;
  /** Called when the user cancels input (Escape on empty buffer, Ctrl+C) */
  onCancel?: () => void;
  /** Called on Ctrl+C (before onCancel — for aborting runs vs canceling input) */
  onInterrupt?: () => void;
  /** Minimum terminal width for layout */
  minWidth?: number;
  /** Vim mode (insert/normal/visual with status indicator). Enabled via PromptInputAdapter. */
  vimMode?: boolean;
  /** Path to history file, defaults to ~/.babel_prompt_history.json */
  historyFile?: string;
  /** Called when Ctrl+P is pressed — should open the command palette */
  onCommandPalette?: () => void;
  /** Called when Ctrl+G is pressed — open buffer in $EDITOR */
  onExternalEditor?: () => void | Promise<void>;
  /** Allow submitting empty input (used for one-shot question() prompts).
   *  Default: false — the main REPL input does not submit empty lines. */
  allowEmptySubmit?: boolean;
  /** When true, Tab queues non-empty input instead of tab-completion (C2). */
  isTaskRunning?: () => boolean;
  /** Snapshot of queued follow-up messages for composer preview (C2). */
  getQueuedMessages?: () => readonly string[];
  /** Enqueue follow-up while agent is busy. Return false when queue is full. */
  onQueue?: (text: string) => boolean;
  /** Called when the voice dictation hotkey is pressed (Ctrl+Shift+V).
   *  Return true if the key was consumed (voice toggled), false to pass through. */
  onVoiceToggle?: () => boolean;
}

export interface PromptInputState {
  /** The full text content (joined lines) */
  text: string;
  /** Individual lines of text */
  lines: string[];
  /** Cursor line index (0-based) */
  cursorLine: number;
  /** Cursor column (0-based, visual position) */
  cursorCol: number;
  /** Whether input is active */
  active: boolean;
  /** Current mode */
  mode: 'insert' | 'normal' | 'visual';
  /** Whether history browsing is active */
  browsingHistory: boolean;
  /** Whether undo is available */
  canUndo: boolean;
  /** Whether redo is available */
  canRedo: boolean;
  /** Whether visual mode is active */
  isVisual: boolean;
  /** Visual selection anchor position */
  visualStart: { line: number; col: number } | null;
}

// ── Constants ───────────────────────────────────────────────────────────────────

const DEFAULT_PROMPT = '› ';
const DEFAULT_CONTINUATION = '· ';
const DEFAULT_HISTORY_SIZE = 200;
const CURSOR_BLINK_MS = 530; // Standard terminal cursor blink
const WORD_BOUNDARY_REGEX = /\b\w/;

// ── Slash commands ──────────────────────────────────────────────────────────────

const BUILTIN_SLASH_COMMANDS: Array<{ name: string; description: string; group: string }> = [
  { name: '/help', description: 'Show help', group: 'General' },
  { name: '/theme', description: 'Change color theme', group: 'UI' },
  { name: '/model', description: 'Switch AI model', group: 'Session' },
  { name: '/mode', description: 'Switch execution mode (chat/deep/plan)', group: 'Session' },
  { name: '/project', description: 'Set project context', group: 'Session' },
  { name: '/clear', description: 'Clear conversation', group: 'Session' },
  { name: '/compact', description: 'Toggle compact mode', group: 'UI' },
  { name: '/diff', description: 'Show working diff', group: 'Git' },
  { name: '/review', description: 'Code review current changes', group: 'Git' },
  { name: '/scrollback', description: 'Open scrollback pager', group: 'UI' },
  { name: '/doctor', description: 'Check environment setup', group: 'General' },
  { name: '/resume', description: 'Resume previous session', group: 'Session' },
  { name: '/workflow', description: 'Run a DAG workflow from a JSON definition', group: 'Session' },
  { name: '/init', description: 'Initialize project config', group: 'Project' },
  { name: '/status', description: 'Show session status', group: 'Session' },
  { name: '/vim', description: 'Toggle vim mode', group: 'UI' },
  { name: '/mcp', description: 'Manage MCP servers', group: 'Tools' },
  { name: '/exit', description: 'Exit Babel', group: 'Session' },
  { name: '/keymap', description: 'Rebind keyboard shortcuts', group: 'UI' },
];

// ── ANSI injection guard ───────────────────────────────────────────────────────

/**
 * Strip ANSI escape-initiator bytes (0x1b) from user-controlled text to
 * prevent terminal injection via paste, history, or autocomplete.
 *
 * The ESC byte is never part of legitimate Unicode text or emoji — removing
 * it blocks all CSI, OSC, DCS, and other escape sequences at their root.
 */
function sanitizeUserText(text: string): string {
  if (!text) return text;
  return text.replace(/\x1b/g, '');
}

// ── PromptInput ─────────────────────────────────────────────────────────────────

export class PromptInput {
  private config: {
    prompt: string;
    continuationPrompt: string;
    history: string[];
    historySize: number;
    minWidth: number;
    onSubmit: (text: string) => void;
    completer: ((line: string) => [string[], string]) | undefined;
    onCancel: (() => void) | undefined;
    onInterrupt: (() => void) | undefined;
    vimMode: boolean | undefined;
    onCommandPalette: (() => void) | undefined;
    onExternalEditor: (() => void | Promise<void>) | undefined;
    allowEmptySubmit: boolean;
    isTaskRunning: (() => boolean) | undefined;
    getQueuedMessages: (() => readonly string[]) | undefined;
    onQueue: ((text: string) => boolean) | undefined;
    onVoiceToggle: (() => boolean) | undefined;
  };
  private submitListeners: Array<(text: string) => void> = [];

  // Text buffer
  private lines: string[] = [''];
  private cursorLine = 0;
  private cursorCol = 0;

  // History (backward-compat fields; synced with composerHistory)
  private history: string[] = [];
  private historyIndex = -1; // -1 = not browsing, 0 = oldest, history.length-1 = newest
  private savedDraft: string | null = null; // Saved input when browsing history
  private browsingHistory = false;

  // State
  private active = false;
  private mode: 'insert' | 'normal' | 'visual' = 'insert';
  private killBuffer: string = '';
  private visualStart: { line: number; col: number } | null = null;
  private visualMode: 'char' | 'line' | null = null;
  private marks: Map<string, { line: number; col: number }> = new Map();
  private lastChange: { type: string; text?: string; shift?: boolean } | null = null;
  private insertEntryType: string | null = null;
  private insertSessionText: string = '';
  private vimPending: string | null = null;
  private vimOpPending: { type: string; [k: string]: unknown } = { type: 'none' };
  private imeComposing = false;
  private undoStack: Array<{ lines: string[]; cursorLine: number; cursorCol: number }> = [];
  private redoStack: Array<{ lines: string[]; cursorLine: number; cursorCol: number }> = [];
  private readonly maxUndoStack = 100;

  // Rendering
  private cleanupKeyHandler: (() => void) | null = null;
  private unregisterCursorBlink: (() => void) | null = null;
  private unregisterPasteFlush: (() => void) | null = null;
  private cursorVisible = true;
  private blinkKeepAlive: (() => void) | null = null;
  private renderScheduled = false;

  // Backward-compat popup fields (synced with TypeaheadEngine)
  private completionPopup: string[] | null = null;
  private completionSelected = 0;
  private slashSelected: number = 0;

  // Inline autocomplete (ghost text — sibling to TypeaheadEngine)
  private ac: InlineAutocomplete = new InlineAutocomplete();

  // Phase C modules
  private typeahead: TypeaheadEngine;
  private composerHistory: ComposerHistory = new ComposerHistory();
  private pasteBurst: PasteBurst = new PasteBurst();
  private pasteStore: PastePlaceholderStore = new PastePlaceholderStore();

  // Terminal
  private termWidth: number;
  private promptLen: number;
  private continuationLen: number;
  private maxInputHeight: number;
  private historyFile: string;
  private historyLoaded: boolean = false;

  constructor(config: PromptInputConfig) {
    this.config = {
      prompt: config.prompt ?? DEFAULT_PROMPT,
      continuationPrompt: config.continuationPrompt ?? DEFAULT_CONTINUATION,
      history: config.history ?? [],
      historySize: config.historySize ?? DEFAULT_HISTORY_SIZE,
      minWidth: config.minWidth ?? 40,
      onSubmit: config.onSubmit,
      completer: config.completer,
      onCancel: config.onCancel,
      onInterrupt: config.onInterrupt,
      vimMode: config.vimMode,
      onCommandPalette: config.onCommandPalette,
      onExternalEditor: config.onExternalEditor,
      allowEmptySubmit: config.allowEmptySubmit ?? false,
      isTaskRunning: config.isTaskRunning,
      getQueuedMessages: config.getQueuedMessages,
      onQueue: config.onQueue,
      onVoiceToggle: config.onVoiceToggle,
    };

    this.typeahead = new TypeaheadEngine({
      slashCommands: BUILTIN_SLASH_COMMANDS,
    });

    // Seed history into composerHistory and backward-compat field
    const initialHistory = [...this.config.history].slice(-this.config.historySize);
    this.composerHistory.setPersistentEntries(initialHistory);
    this.history = [...initialHistory];
    // Seed inline autocomplete history from initial history entries
    for (const entry of this.history) {
      this.ac.addHistoryEntry(entry);
    }
    this.termWidth = getEffectiveTerminalWidth(this.config.minWidth, 200);
    this.promptLen = visibleLength(this.config.prompt);
    this.continuationLen = visibleLength(this.config.continuationPrompt);
    this.maxInputHeight = Math.max(3, Math.floor((process.stdout.rows || 24) * 0.4)); // Max 40% of screen

    this.historyFile =
      config.historyFile ??
      path.join(
        process.env.HOME || process.env.USERPROFILE || '/tmp',
        '.babel_prompt_history.json',
      );
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Activate the input — takes over stdin and renders the prompt. */
  activate(): void {
    if (this.active) return;
    this.active = true;

    // Clear any stale completion popup
    this.completionPopup = null;
    this.typeahead?.clearCompleterPopup();

    // Paste burst flush tick
    const scheduler = FrameScheduler.getInstance();
    this.unregisterPasteFlush = scheduler.scheduleComponent(
      'paste-flush',
      () => {
        const now = Date.now();
        const flushResult = this.pasteBurst.flushIfDue(now);
        if (flushResult.type === 'paste') {
          this.handlePasteText(flushResult.text);
          this.render();
        } else if (flushResult.type === 'typed') {
          // The held single char can now be inserted
          this.snapshot();
          const line = this.lines[this.cursorLine] ?? '';
          this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + flushResult.char + line.slice(this.cursorCol);
          this.cursorCol++;
          this.refreshAutocomplete();
          this.checkMentionTrigger();
          this.render();
        }
      },
      {
        intervalMs: 5,
        priority: 25,
        label: 'paste-flush',
      },
    );
    scheduler.setComponentPermanentDirty('paste-flush', true);

    // Start cursor blink via FrameScheduler (per-component scheduling)
    this.blinkKeepAlive = scheduler.keepAlive();
    this.unregisterCursorBlink = scheduler.scheduleComponent(
      'cursor-blink',
      () => {
        this.cursorVisible = !this.cursorVisible;
        this.renderCursor();
      },
      {
        intervalMs: CURSOR_BLINK_MS,
        priority: 20,
        label: 'cursor-blink',
      },
    );
    scheduler.setComponentPermanentDirty('cursor-blink', true);

    // Install key handler
    this.cleanupKeyHandler = installKeyHandler(process.stdin, (event) => {
      // G6 — track IME composition so we can park the hardware cursor at the caret
      this.imeComposing = event.isComposing === true;
      this.handleKey(event);
    });

    this.render();
  }

  /** Deactivate the input — restores stdin and cleans up rendering. */
  deactivate(): void {
    if (!this.active) return;
    this.active = false;

    // Stop paste flush tick
    if (this.unregisterPasteFlush) {
      FrameScheduler.getInstance().setComponentPermanentDirty('paste-flush', false);
      this.unregisterPasteFlush();
      this.unregisterPasteFlush = null;
    }

    // Stop cursor blink
    if (this.unregisterCursorBlink) {
      FrameScheduler.getInstance().setComponentPermanentDirty('cursor-blink', false);
      this.unregisterCursorBlink();
      this.unregisterCursorBlink = null;
    }
    if (this.blinkKeepAlive) {
      this.blinkKeepAlive();
      this.blinkKeepAlive = null;
    }

    // Remove key handler (restores raw mode)
    if (this.cleanupKeyHandler) {
      this.cleanupKeyHandler();
      this.cleanupKeyHandler = null;
    }

    // Show cursor and move to next line
    OutputBuffer.getInstance().write('\x1b[?25h');
    OutputBuffer.getInstance().write('\n');
  }

  /** Get current input state. */
  getState(): PromptInputState {
    return {
      text: this.lines.join('\n'),
      lines: [...this.lines],
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
      active: this.active,
      mode: this.mode,
      browsingHistory: this.browsingHistory,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      isVisual: this.visualStart !== null,
      visualStart: this.visualStart ? { ...this.visualStart } : null,
    };
  }

  /** Set the text buffer (e.g., for restoring a draft). */
  setText(text: string): void {
    this.lines = text.split('\n');
    if (this.lines.length === 0) this.lines = [''];
    this.cursorLine = this.lines.length - 1;
    this.cursorCol = this.lines[this.cursorLine]?.length ?? 0;
    this.typeahead.dismiss();
    this.refreshAutocomplete();
    if (this.active) this.render();
  }

  /**
   * Public wrapper around the private insertText() — inserts text at the
   * current cursor position and re-renders. Used by internal PromptInput
   * operations (autocomplete, paste, yank). Voice dictation uses setText()
   * for buffer-level replacement; this method is available for cursor-aware
   * streaming insertion in future voice pipeline enhancements.
   */
  insertTextAtCursor(text: string): void {
    this.insertText(text);
    if (this.active) this.render();
  }

  /** Add a line to history (call after successful submit). */
  addHistory(entry: string): void {
    if (!entry.trim()) return;
    const trimmed = entry.trim();
    // MRU dedup on the backward-compat array
    const idx = this.history.lastIndexOf(trimmed);
    if (idx >= 0) this.history.splice(idx, 1);
    this.history.push(trimmed);
    // Trim to max size
    while (this.history.length > this.config.historySize) {
      this.history.shift();
    }
    // Record in composerHistory for navigation
    this.composerHistory.recordSessionSubmission(trimmed);
    // Feed the inline autocomplete so suggestions stay current
    this.ac.addHistoryEntry(trimmed);
  }

  /** Get current history (for persistence). */
  getHistory(): string[] {
    return [...this.history];
  }

  /** Load history from disk. Call after initializing. */
  async loadHistory(): Promise<void> {
    if (this.historyLoaded) return;
    try {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(this.historyFile, 'utf-8');
      const entries: string[] = JSON.parse(data);
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (typeof entry === 'string' && entry.trim()) {
            this.addHistory(entry);
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
    this.historyLoaded = true;
  }

  /** Save history to disk (keeps last 500 entries). */
  async saveHistory(): Promise<void> {
    try {
      const { writeFile } = await import('node:fs/promises');
      const entries = this.getHistory().slice(-500);
      await writeFile(this.historyFile, JSON.stringify(entries, null, 2), 'utf-8');
    } catch {
      // Silently fail — don't break the TUI for history persistence issues
    }
  }

  /** Enable or disable vim mode dynamically. */
  setVimMode(enabled: boolean): void {
    this.config.vimMode = enabled;
    if (!enabled && (this.mode === 'normal' || this.mode === 'visual')) {
      this.mode = 'insert';
      this.visualStart = null;
      this.visualMode = null;
      if (this.active) this.render();
    }
  }

  /**
   * Register a submit listener. Called when the user submits text.
   * Multiple listeners are supported (fired in registration order).
   * Returns a function to unregister.
   */
  onSubmit(listener: (text: string) => void): () => void {
    this.submitListeners.push(listener);
    return () => {
      const idx = this.submitListeners.indexOf(listener);
      if (idx >= 0) this.submitListeners.splice(idx, 1);
    };
  }

  // ── Key Handling ────────────────────────────────────────────────────────────

  private getTypeaheadContext(): TypeaheadContext {
    return {
      lines: this.lines,
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
      active: this.active,
    };
  }

  private handleKey(event: KeyEvent): void {
    if (!this.active) return;

    // Voice dictation hotkey (configurable via BABEL_VOICE_HOTKEY env var)
    if (matchesHotkey(event, voiceHotkey)) {
      const consumed = this.config.onVoiceToggle?.() ?? false;
      if (consumed) return;
    }

    // Ctrl+C
    if (event.name === 'c' && event.ctrl) {
      if (this.lines.length === 1 && this.lines[0] === '') {
        this.deactivate();
        this.config.onCancel?.();
      } else if (this.config.onInterrupt) {
        this.config.onInterrupt();
      } else {
        this.clear();
        this.render();
      }
      return;
    }

    // Ctrl+P → command palette (must not insert "p")
    if (event.name === 'p' && event.ctrl) {
      this.config.onCommandPalette?.();
      return;
    }

    // Ctrl+G → external editor ($EDITOR)
    if (event.name === 'g' && event.ctrl) {
      void this.config.onExternalEditor?.();
      return;
    }

    // ── Typeahead popup handling (C3) ─────────────────────────────────────
    this.typeahead.sync(this.getTypeaheadContext());

    if (this.typeahead.hasPopup()) {
      // Escape dismisses any popup
      if (event.name === 'escape') {
        this.typeahead.dismiss();
        this.syncBackwardCompatPopupFields();
        this.render();
        return;
      }

      // Tab accepts any popup (if mention has results, or slash/completer)
      if (event.name === 'tab') {
        if (this.typeahead.isMentionActive() && !this.typeahead.mentionHasResults()) {
          // Don't accept mention without results — let it fall through
        } else {
          const result = this.typeahead.accept();
          if (result) {
            this.applyTypeaheadResult(result);
            this.syncBackwardCompatPopupFields();
            this.render();
            return;
          }
        }
      }

      // Enter accepts mention or completer (not slash)
      if (event.name === 'enter' && this.typeahead.getMode() !== 'slash') {
        if (this.typeahead.getMode() === 'completer' ||
            (this.typeahead.isMentionActive() && this.typeahead.mentionHasResults())) {
          const result = this.typeahead.accept();
          if (result) {
            this.applyTypeaheadResult(result);
            this.syncBackwardCompatPopupFields();
            this.render();
            return;
          }
        }
      }

      // Up/Down navigate popup
      if (event.name === 'up' || event.name === 'down') {
        this.typeahead.moveSelection(event.name === 'up' ? -1 : 1);
        this.syncBackwardCompatPopupFields();
        this.render();
        return;
      }
    }

    // Escape (non-popup)
    if (event.name === 'escape') {
      if (this.mode === 'visual') {
        this.clearVisualSelection();
        this.render();
      } else if (this.mode === 'normal') {
        this.mode = 'insert';
        this.render();
      } else if (this.config.vimMode) {
        this.storeInsertChange();
        this.mode = 'normal';
        this.render();
      } else if (this.lines.length === 1 && this.lines[0] === '') {
        this.deactivate();
        this.config.onCancel?.();
      } else {
        this.clear();
        this.render();
      }
      return;
    }

    // Tab (non-popup): queue, autocomplete, tab completion
    if (event.name === 'tab') {
      if (this.shouldQueueOnTab()) {
        this.queueSubmit();
        return;
      }
      if (this.ac.hasSuggestion()) {
        const suffix = this.ac.accept();
        if (suffix) {
          this.insertText(suffix);
          this.render();
          return;
        }
      }
      this.handleTabCompletion();
      return;
    }

    // Paste event (C5)
    if (event.name === 'paste') {
      this.handlePasteText(event.sequence);
      return;
    }

    // Enter (non-popup): submit / insert newline
    if (event.name === 'enter') {
      // Paste burst Enter suppression (C1)
      const now = Date.now();
      if (this.pasteBurst.newlineShouldInsertInsteadOfSubmit(now) && !event.ctrl) {
        this.insertNewline();
        this.render();
        return;
      }

      const isLastLine = this.cursorLine === this.lines.length - 1;
      const cursorAtEnd = this.cursorCol >= (this.lines[this.cursorLine]?.length ?? 0);
      const isExplicitSubmit = event.ctrl;

      if (isLastLine && cursorAtEnd && !isExplicitSubmit) {
        this.submit();
      } else if (isExplicitSubmit && isLastLine) {
        this.submit();
      } else {
        this.insertNewline();
      }
      return;
    }

    // History navigation (C4) — Up/Down when no popup is active
    if (event.name === 'up') {
      this.ac.dismiss();
      this.historyBack();
      return;
    }
    if (event.name === 'down') {
      this.ac.dismiss();
      this.historyForward();
      return;
    }

    // Normal mode keys
    if (this.mode === 'normal') {
      this.handleNormalModeKey(event);
      return;
    }

    // Visual mode keys
    if (this.mode === 'visual') {
      this.handleVisualModeKey(event);
      return;
    }

    // ── Insert mode text navigation ────────────────────────────────────────

    // Ctrl+A → line start
    if (event.name === 'a' && event.ctrl) {
      this.cursorCol = 0;
      this.render();
      return;
    }

    // Ctrl+E → line end
    if (event.name === 'e' && event.ctrl) {
      this.cursorCol = this.lines[this.cursorLine]?.length ?? 0;
      this.render();
      return;
    }

    // Ctrl+K → kill to end of line
    if (event.name === 'k' && event.ctrl) {
      const line = this.lines[this.cursorLine] ?? '';
      this.lines[this.cursorLine] = line.slice(0, this.cursorCol);
      this.render();
      return;
    }

    // Ctrl+U → kill to start of line
    if (event.name === 'u' && event.ctrl) {
      const line = this.lines[this.cursorLine] ?? '';
      this.lines[this.cursorLine] = line.slice(this.cursorCol);
      this.cursorCol = 0;
      this.render();
      return;
    }

    // Ctrl+W → delete word backward
    if (event.name === 'w' && event.ctrl) {
      this.deleteWordBackward();
      this.render();
      return;
    }

    // Ctrl+Z → undo
    if ((event.name === 'suspend' && event.ctrl) || (event.name === 'z' && event.ctrl)) {
      this.undo();
      this.render();
      return;
    }

    // Ctrl+Y → redo
    if (event.name === 'y' && event.ctrl) {
      this.redo();
      this.render();
      return;
    }

    // Home → line start
    if (event.name === 'home') {
      this.cursorCol = 0;
      this.render();
      return;
    }

    // End → line end
    if (event.name === 'end') {
      this.cursorCol = this.lines[this.cursorLine]?.length ?? 0;
      this.render();
      return;
    }

    // Ctrl+Left → word left
    if (event.name === 'left' && event.ctrl) {
      this.moveWordLeft();
      this.render();
      return;
    }

    // Ctrl+Right → word right
    if (event.name === 'right' && event.ctrl) {
      this.moveWordRight();
      this.render();
      return;
    }

    // Left arrow
    if (event.name === 'left') {
      if (this.cursorCol > 0) {
        this.cursorCol--;
      } else if (this.cursorLine > 0) {
        this.cursorLine--;
        this.cursorCol = this.lines[this.cursorLine]?.length ?? 0;
      }
      this.ac.dismiss();
      this.render();
      return;
    }

    // Right arrow
    if (event.name === 'right') {
      const currentLineLen = this.lines[this.cursorLine]?.length ?? 0;
      if (this.cursorCol < currentLineLen) {
        this.cursorCol++;
      } else if (this.ac.hasSuggestion()) {
        const suffix = this.ac.accept();
        if (suffix) {
          this.insertText(suffix);
          this.render();
          return;
        }
      } else if (this.cursorLine < this.lines.length - 1) {
        this.cursorLine++;
        this.cursorCol = 0;
      }
      this.render();
      return;
    }

    // Backspace
    if (event.name === 'backspace') {
      this.backspace();
      if (this.insertEntryType) this.insertSessionText = this.insertSessionText.slice(0, -1);
      this.checkMentionTrigger();
      this.render();
      return;
    }

    // Delete
    if (event.name === 'delete') {
      this.deleteForward();
      this.render();
      return;
    }

    // PageUp / PageDown → jump to first/last line
    if (event.name === 'pageup') {
      this.cursorLine = 0;
      this.cursorCol = Math.min(this.cursorCol, this.lines[0]?.length ?? 0);
      this.render();
      return;
    }
    if (event.name === 'pagedown') {
      this.cursorLine = this.lines.length - 1;
      this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorLine]?.length ?? 0);
      this.render();
      return;
    }

    // ── Printable characters (with PasteBurst C1) ──────────────────────────
    if (event.sequence.length === 1 && !event.ctrl && !event.meta) {
      const char = event.sequence;
      if (char >= ' ' || char === '\t') {
        const now = Date.now();
        const decision = this.pasteBurst.onPlainCharNoHold(now);

        if (decision) {
          switch (decision.type) {
            case 'bufferAppend':
              // Char is being buffered by PasteBurst; don't insert individually
              this.pasteBurst.appendCharToBuffer(char, now);
              return;
            case 'beginBuffer': {
              // Retro-capture: undo the last N chars from current line
              if (decision.retroChars > 0) {
                const line = this.lines[this.cursorLine] ?? '';
                const lineChars = [...line];
                const charsToCapture = Math.min(decision.retroChars, lineChars.length);
                const retroStart = Math.max(0, this.cursorCol - charsToCapture);
                const grabbed = lineChars.slice(retroStart, this.cursorCol).join('');
                // Stricter pastey check: require newline (multi-line paste) or >=16 chars
                // Single spaces in normal typing should NOT trigger retro-capture.
                const looksPastey = grabbed.includes('\n') || [...grabbed].length >= 16;
                if (looksPastey) {
                  // Looks pastey — retro-capture and start buffering
                  this.lines[this.cursorLine] = lineChars.slice(0, retroStart).join('');
                  this.cursorCol = (this.lines[this.cursorLine] ?? '').length;
                  this.pasteBurst.beginWithRetroGrabbed(grabbed, now);
                  this.pasteBurst.appendCharToBuffer(char, now);
                  return;
                }
              }
              // Not pastey enough — clear burst state and continue normally
              this.pasteBurst.clearAfterExplicitPaste();
              break;
            }
          }
        }

        // Normal char insertion
        this.insertChar(char);
        if (this.insertEntryType) this.insertSessionText += char;
        this.checkMentionTrigger();
        this.render();
        return;
      }
    }

    // Alt+Backspace → delete word backward (some terminals)
    if (event.name === 'backspace' && event.meta) {
      this.deleteWordBackward();
      this.render();
      return;
    }
  }

  private handleNormalModeKey(event: KeyEvent): void {
    dispatchNormalModeKey(this as never, event);
  }

  // ── Visual Mode ──────────────────────────────────────────────────────────

  /** Handle keys while in visual mode. */
  private handleVisualModeKey(event: KeyEvent): void {
    switch (event.name) {
      case 'escape':
        this.clearVisualSelection();
        this.render();
        return;
      case 'h':
        if (this.cursorCol > 0) this.cursorCol--;
        this.render();
        return;
      case 'l':
        if (this.cursorCol < (this.lines[this.cursorLine]?.length ?? 0)) this.cursorCol++;
        this.render();
        return;
      case 'k':
        if (this.cursorLine > 0) {
          this.cursorLine--;
          this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorLine]?.length ?? 0);
        }
        this.render();
        return;
      case 'j':
        if (this.cursorLine < this.lines.length - 1) {
          this.cursorLine++;
          this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorLine]?.length ?? 0);
        }
        this.render();
        return;
      case 'w':
        this.moveWordRight();
        this.render();
        return;
      case 'b':
        this.moveWordLeft();
        this.render();
        return;
      case 'e':
        this.moveToWordEnd();
        this.render();
        return;
      case '0':
        this.cursorCol = 0;
        this.render();
        return;
      case '$':
        this.cursorCol = this.lines[this.cursorLine]?.length ?? 0;
        this.render();
        return;
      case 'd':
        this.snapshot();
        this.visualDelete();
        this.clearVisualSelection();
        this.lastChange = { type: 'dd' };
        this.render();
        return;
      case 'y':
        this.visualYank();
        this.clearVisualSelection();
        this.render();
        return;
      case 'c':
        this.snapshot();
        this.visualDelete();
        this.clearVisualSelection();
        this.mode = 'insert';
        this.insertEntryType = 'c';
        this.insertSessionText = '';
        this.render();
        return;
      case 'x':
      case 'X':
        this.snapshot();
        this.visualDelete();
        this.clearVisualSelection();
        this.lastChange = { type: 'x' };
        this.render();
        return;
    }
  }

  /** Clear visual selection state and return to normal mode. */
  private clearVisualSelection(): void {
    this.visualStart = null;
    this.visualMode = null;
    this.mode = 'normal';
  }

  /** Get normalized visual range with start <= end and exclusive endCol. */
  private getNormalizedVisualRange(): {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  } {
    if (!this.visualStart) {
      return {
        startLine: this.cursorLine,
        startCol: this.cursorCol,
        endLine: this.cursorLine,
        endCol: this.cursorCol,
      };
    }

    if (this.visualMode === 'line') {
      const startLine = Math.min(this.visualStart.line, this.cursorLine);
      const endLine = Math.max(this.visualStart.line, this.cursorLine);
      return { startLine, startCol: 0, endLine, endCol: Infinity };
    }

    // Character-wise
    const start = this.visualStart;
    const end = { line: this.cursorLine, col: this.cursorCol };

    let normStart: { line: number; col: number };
    let normEnd: { line: number; col: number };

    if (start.line < end.line || (start.line === end.line && start.col <= end.col)) {
      normStart = start;
      normEnd = end;
    } else {
      normStart = end;
      normEnd = start;
    }

    // endCol is exclusive (one past last selected char)
    const endLineLen = this.lines[normEnd.line]?.length ?? 0;
    const endCol = normEnd.col < endLineLen ? normEnd.col + 1 : endLineLen;

    return { startLine: normStart.line, startCol: normStart.col, endLine: normEnd.line, endCol };
  }

  /** Get the column range of visual selection for a given line, or null if not selected. */
  private getSelectionColRange(line: number): { start: number; end: number } | null {
    if (!this.visualStart) return null;

    const range = this.getNormalizedVisualRange();

    if (line < range.startLine || line > range.endLine) return null;

    if (this.visualMode === 'line') {
      return { start: 0, end: (this.lines[line] ?? '').length };
    }

    // Character-wise
    if (line === range.startLine && line === range.endLine) {
      return { start: range.startCol, end: range.endCol };
    }
    if (line === range.startLine) {
      return { start: range.startCol, end: (this.lines[line] ?? '').length };
    }
    if (line === range.endLine) {
      return { start: 0, end: range.endCol };
    }
    return { start: 0, end: (this.lines[line] ?? '').length };
  }

  /** Delete the visual selection into killBuffer. Caller must snapshot(). */
  private visualDelete(): void {
    if (!this.visualStart) return;

    const range = this.getNormalizedVisualRange();

    if (this.visualMode === 'line') {
      const yankedLines: string[] = [];
      for (let i = range.startLine; i <= range.endLine; i++) {
        yankedLines.push(this.lines[i] ?? '');
      }
      this.killBuffer = yankedLines.join('\n') + '\n';

      this.lines.splice(range.startLine, range.endLine - range.startLine + 1);
      if (this.lines.length === 0) this.lines = [''];
      this.cursorLine = Math.min(range.startLine, this.lines.length - 1);
      this.cursorCol = 0;
    } else {
      const line = this.lines[range.startLine] ?? '';

      if (range.startLine === range.endLine) {
        this.killBuffer = line.slice(range.startCol, range.endCol);
        this.lines[range.startLine] = line.slice(0, range.startCol) + line.slice(range.endCol);
        this.cursorLine = range.startLine;
        this.cursorCol = range.startCol;
      } else {
        const yankedParts: string[] = [];
        yankedParts.push(line.slice(range.startCol));

        for (let i = range.startLine + 1; i < range.endLine; i++) {
          yankedParts.push(this.lines[i] ?? '');
        }

        const lastLine = this.lines[range.endLine] ?? '';
        yankedParts.push(lastLine.slice(0, range.endCol));

        this.killBuffer = yankedParts.join('\n');
        this.lines[range.startLine] = line.slice(0, range.startCol) + lastLine.slice(range.endCol);

        const deleteCount = range.endLine - range.startLine;
        this.lines.splice(range.startLine + 1, deleteCount);

        this.cursorLine = range.startLine;
        this.cursorCol = range.startCol;
      }
    }
  }

  /** Yank visual selection into killBuffer (non-destructive). */
  private visualYank(): void {
    if (!this.visualStart) return;

    const range = this.getNormalizedVisualRange();

    if (this.visualMode === 'line') {
      const yankedLines: string[] = [];
      for (let i = range.startLine; i <= range.endLine; i++) {
        yankedLines.push(this.lines[i] ?? '');
      }
      this.killBuffer = yankedLines.join('\n') + '\n';
    } else {
      if (range.startLine === range.endLine) {
        this.killBuffer = (this.lines[range.startLine] ?? '').slice(range.startCol, range.endCol);
      } else {
        const parts: string[] = [];
        parts.push((this.lines[range.startLine] ?? '').slice(range.startCol));
        for (let i = range.startLine + 1; i < range.endLine; i++) {
          parts.push(this.lines[i] ?? '');
        }
        parts.push((this.lines[range.endLine] ?? '').slice(0, range.endCol));
        this.killBuffer = parts.join('\n');
      }
    }
  }

  // ── Dot Repeat ─────────────────────────────────────────────────────────

  /** Replay the last recorded change command. */
  private handleDotRepeat(): void {
    if (!this.lastChange) return;

    this.snapshot();

    const change = this.lastChange;

    switch (change.type) {
      case 'i': {
        const line = this.lines[this.cursorLine] ?? '';
        const pos = this.cursorCol;
        this.lines[this.cursorLine] = line.slice(0, pos) + (change.text ?? '') + line.slice(pos);
        this.cursorCol = pos + (change.text ?? '').length;
        break;
      }
      case 'I': {
        this.cursorCol = 0;
        const line = this.lines[this.cursorLine] ?? '';
        this.lines[this.cursorLine] = (change.text ?? '') + line;
        this.cursorCol = (change.text ?? '').length;
        break;
      }
      case 'a': {
        const line = this.lines[this.cursorLine] ?? '';
        const pos = this.cursorCol;
        this.lines[this.cursorLine] = line.slice(0, pos) + (change.text ?? '') + line.slice(pos);
        this.cursorCol = pos + (change.text ?? '').length;
        break;
      }
      case 'A': {
        const line = this.lines[this.cursorLine] ?? '';
        const endPos = line.length;
        this.lines[this.cursorLine] = line + (change.text ?? '');
        this.cursorCol = endPos + (change.text ?? '').length;
        break;
      }
      case 'o': {
        this.lines.splice(this.cursorLine + 1, 0, change.text ?? '');
        this.cursorLine++;
        this.cursorCol = (change.text ?? '').length;
        break;
      }
      case 'O': {
        this.lines.splice(this.cursorLine, 0, change.text ?? '');
        this.cursorCol = (change.text ?? '').length;
        break;
      }
      case 'C': {
        const cl = this.lines[this.cursorLine] ?? '';
        this.killBuffer = cl.slice(this.cursorCol);
        this.lines[this.cursorLine] = cl.slice(0, this.cursorCol) + (change.text ?? '');
        this.cursorCol = this.cursorCol + (change.text ?? '').length;
        break;
      }
      case 'dd': {
        this.killBuffer = this.lines[this.cursorLine] ?? '';
        if (this.lines.length > 1) {
          this.lines.splice(this.cursorLine, 1);
          if (this.cursorLine >= this.lines.length) this.cursorLine = this.lines.length - 1;
          this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorLine]?.length ?? 0);
        } else {
          this.lines[0] = '';
          this.cursorCol = 0;
        }
        break;
      }
      case 'D': {
        const dl = this.lines[this.cursorLine] ?? '';
        this.killBuffer = dl.slice(this.cursorCol);
        this.lines[this.cursorLine] = dl.slice(0, this.cursorCol);
        break;
      }
      case 'x': {
        this.killBuffer = this.lines[this.cursorLine]?.[this.cursorCol] ?? '';
        this.deleteForward();
        break;
      }
      case 'p': {
        if (this.killBuffer) {
          if (change.shift) {
            const pl = this.lines[this.cursorLine] ?? '';
            this.lines[this.cursorLine] =
              pl.slice(0, this.cursorCol) + this.killBuffer + pl.slice(this.cursorCol);
            this.cursorCol += this.killBuffer.length;
          } else {
            this.insertText(this.killBuffer);
          }
        }
        break;
      }
    }
  }

  /** Save the current insert session as the lastChange for dot-repeat. */
  private storeInsertChange(): void {
    if (this.insertEntryType && this.mode === 'insert') {
      this.lastChange = { type: this.insertEntryType, text: this.insertSessionText };
      this.insertEntryType = null;
      this.insertSessionText = '';
    }
  }

  // ── Typeahead / Paste helpers (C3, C5) ────────────────────────────────────────

  /** Sync backward-compat fields from TypeaheadEngine state. */
  private syncBackwardCompatPopupFields(): void {
    const vs = this.typeahead.getViewState();
    if (vs.mode === 'completer') {
      this.completionPopup = vs.items.map((i) => i.label);
    } else {
      this.completionPopup = null;
    }
    if (vs.mode === 'slash') {
      this.slashSelected = vs.selectedIndex;
    } else {
      this.slashSelected = 0;
    }
  }

  /** Apply a TypeaheadEngine accept result to the text buffer. */
  private applyTypeaheadResult(result: TypeaheadAcceptResult): void {
    switch (result.mode) {
      case 'slash':
      case 'mention': {
        const line = this.lines[result.line] ?? '';
        this.lines[result.line] = line.slice(0, result.startCol) + result.insertText + line.slice(result.endCol);
        this.cursorLine = result.line;
        this.cursorCol = result.startCol + result.insertText.length;
        this.typeahead.dismiss();
        this.completionPopup = null;
        this.slashSelected = 0;
        break;
      }
      case 'completer': {
        // Completer replaces the current word
        this.applyCompletionText(result.insertText);
        this.typeahead.clearCompleterPopup();
        this.completionPopup = null;
        break;
      }
    }
    this.refreshAutocomplete();
  }

  /** Handle a paste event (C5 — paste placeholder collapsing). */
  private handlePasteText(pasted: string): void {
    const bufferText = this.lines.join('\n');
    const { insertText } = this.pasteStore.integratePaste(pasted, bufferText);
    this.insertText(insertText);
    this.refreshAutocomplete();
    this.checkMentionTrigger();
    if (this.active) this.render();
  }

  // ── Text Manipulation ───────────────────────────────────────────────────────

  private snapshot(): void {
    this.undoStack.push({
      lines: this.lines.map((l) => l),
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
    });
    if (this.undoStack.length > this.maxUndoStack) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Refresh the inline autocomplete suggestion based on current cursor position. */
  private refreshAutocomplete(): void {
    this.ac.suggest(this.lines[this.cursorLine] ?? '', this.lines.join('\n'), this.cursorCol);
  }

  private insertChar(char: string): void {
    this.snapshot();
    const line = this.lines[this.cursorLine] ?? '';
    this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + char + line.slice(this.cursorCol);
    this.cursorCol++;
    this.refreshAutocomplete();
  }

  private insertText(text: string): void {
    this.snapshot();
    const lines = text.split('\n');
    if (lines.length === 1) {
      const line = this.lines[this.cursorLine] ?? '';
      this.lines[this.cursorLine] =
        line.slice(0, this.cursorCol) + lines[0] + line.slice(this.cursorCol);
      this.cursorCol += (lines[0] ?? '').length;
    } else {
      // Multi-line paste
      const currentLine = this.lines[this.cursorLine] ?? '';
      const before = currentLine.slice(0, this.cursorCol);
      const after = currentLine.slice(this.cursorCol);

      // First line: before + first pasted line
      this.lines[this.cursorLine] = before + (lines[0] ?? '');

      // Middle lines
      for (let i = 1; i < lines.length - 1; i++) {
        this.cursorLine++;
        this.lines.splice(this.cursorLine, 0, lines[i] ?? '');
      }

      // Last line: last pasted line + after
      this.cursorLine++;
      const lastPasted = lines[lines.length - 1] ?? '';
      this.lines.splice(this.cursorLine, 0, lastPasted + after);
      this.cursorCol = lastPasted.length;
    }
    this.refreshAutocomplete();
  }

  private insertNewline(): void {
    this.snapshot();
    const line = this.lines[this.cursorLine] ?? '';
    const before = line.slice(0, this.cursorCol);
    const after = line.slice(this.cursorCol);

    this.lines[this.cursorLine] = before;
    this.cursorLine++;
    this.lines.splice(this.cursorLine, 0, after);
    this.cursorCol = 0;
    this.refreshAutocomplete();
  }

  private backspace(): void {
    this.snapshot();
    if (this.cursorCol > 0) {
      const line = this.lines[this.cursorLine] ?? '';
      this.lines[this.cursorLine] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
      this.cursorCol--;
    } else if (this.cursorLine > 0) {
      // Merge with previous line
      const prevLen = this.lines[this.cursorLine - 1]?.length ?? 0;
      this.lines[this.cursorLine - 1] =
        (this.lines[this.cursorLine - 1] ?? '') + (this.lines[this.cursorLine] ?? '');
      this.lines.splice(this.cursorLine, 1);
      this.cursorLine--;
      this.cursorCol = prevLen;
    }
    this.refreshAutocomplete();
  }

  private deleteForward(): void {
    this.snapshot();
    const line = this.lines[this.cursorLine] ?? '';
    if (this.cursorCol < line.length) {
      this.lines[this.cursorLine] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
    } else if (this.cursorLine < this.lines.length - 1) {
      // Merge with next line
      this.lines[this.cursorLine] = line + (this.lines[this.cursorLine + 1] ?? '');
      this.lines.splice(this.cursorLine + 1, 1);
    }
    this.refreshAutocomplete();
  }

  private deleteWordBackward(): void {
    this.snapshot();
    const line = this.lines[this.cursorLine] ?? '';
    // Find the start of the word before cursor
    let i = this.cursorCol - 1;
    // Skip whitespace
    while (i >= 0 && line[i] === ' ') i--;
    // Skip word characters
    while (i >= 0 && line[i] !== ' ') i--;
    const start = i + 1;
    this.lines[this.cursorLine] = line.slice(0, start) + line.slice(this.cursorCol);
    this.cursorCol = start;
    this.refreshAutocomplete();
  }

  private moveWordLeft(): void {
    const line = this.lines[this.cursorLine] ?? '';
    if (this.cursorCol === 0) {
      if (this.cursorLine > 0) {
        this.cursorLine--;
        this.cursorCol = this.lines[this.cursorLine]?.length ?? 0;
      }
      return;
    }
    let i = this.cursorCol - 1;
    // Skip whitespace
    while (i > 0 && line[i] === ' ') i--;
    // Skip word characters
    while (i > 0 && line[i] !== ' ') i--;
    if (line[i] === ' ') i++;
    this.cursorCol = i;
  }

  private moveWordRight(): void {
    const line = this.lines[this.cursorLine] ?? '';
    if (this.cursorCol >= line.length) {
      if (this.cursorLine < this.lines.length - 1) {
        this.cursorLine++;
        this.cursorCol = 0;
      }
      return;
    }
    let i = this.cursorCol;
    // Skip word characters
    while (i < line.length && line[i] !== ' ') i++;
    // Skip whitespace
    while (i < line.length && line[i] === ' ') i++;
    this.cursorCol = i;
  }

  /** Move cursor to end of current/next word (vim `e`). */
  private moveToWordEnd(): void {
    const line = this.lines[this.cursorLine] ?? '';
    if (this.cursorCol >= line.length) {
      if (this.cursorLine < this.lines.length - 1) {
        this.cursorLine++;
        this.cursorCol = 0;
        this.moveToWordEnd();
      }
      return;
    }
    let i = this.cursorCol;
    // Skip whitespace
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) {
      if (this.cursorLine < this.lines.length - 1) {
        this.cursorLine++;
        this.cursorCol = 0;
        this.moveToWordEnd();
      }
      return;
    }
    // Move to end of current word
    while (i < line.length - 1 && line[i + 1] !== ' ') i++;
    this.cursorCol = i;
  }

  private clear(): void {
    this.snapshot();
    this.lines = [''];
    this.cursorLine = 0;
    this.cursorCol = 0;
    this.historyIndex = -1;
    this.savedDraft = null;
    this.browsingHistory = false;
    this.completionPopup = null;
    this.slashSelected = 0;
    this.typeahead.dismiss();
    this.composerHistory.resetNavigation();
    this.pasteStore.clear();
    this.pasteBurst.clearAfterExplicitPaste();
    this.visualStart = null;
    this.visualMode = null;
    if (this.mode === 'visual') this.mode = 'normal';
    this.insertEntryType = null;
    this.insertSessionText = '';
  }

  // ── Undo / Redo ─────────────────────────────────────────────────────────────

  private undo(): void {
    if (this.undoStack.length === 0) return;
    this.redoStack.push({
      lines: this.lines.map((l) => l),
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
    });
    const state = this.undoStack.pop()!;
    this.lines = state.lines;
    this.cursorLine = state.cursorLine;
    this.cursorCol = state.cursorCol;
    this.refreshAutocomplete();
    this.render();
  }

  private redo(): void {
    if (this.redoStack.length === 0) return;
    this.undoStack.push({
      lines: this.lines.map((l) => l),
      cursorLine: this.cursorLine,
      cursorCol: this.cursorCol,
    });
    const state = this.redoStack.pop()!;
    this.lines = state.lines;
    this.cursorLine = state.cursorLine;
    this.cursorCol = state.cursorCol;
    this.refreshAutocomplete();
    this.render();
  }

  // ── History (C4) ────────────────────────────────────────────────────────────

  private historyBack(): void {
    this.ac.dismiss();
    if (this.composerHistory.totalEntries() === 0) return;

    if (!this.browsingHistory) {
      this.savedDraft = this.lines.join('\n');
      this.browsingHistory = true;
    }

    const entry = this.composerHistory.navigateOlder();
    if (entry) {
      this.setText(entry.text);
    }
    this.render();
  }

  private historyForward(): void {
    this.ac.dismiss();
    if (!this.browsingHistory) return;

    const result = this.composerHistory.navigateNewer();
    if (result === 'past_newest') {
      this.browsingHistory = false;
      this.historyIndex = -1;
      if (this.savedDraft !== null) {
        this.setText(this.savedDraft);
        this.savedDraft = null;
      }
    } else if (result) {
      this.setText(result.text);
    }
    this.render();
  }

  // ── Tab Completion ──────────────────────────────────────────────────────────

  // ── Tab Completion (C3) ─────────────────────────────────────────────────────

  private handleTabCompletion(): void {
    if (!this.config.completer) return;

    const line = this.getCurrentFullLine();
    const [completions, completed] = this.config.completer(line);

    if (completions.length === 0) return;

    if (completions.length === 1) {
      // Single match: apply it directly
      this.applyCompletionText(completions[0] ?? '');
      this.completionPopup = null;
      this.typeahead.setCompleterPopup(null);
      this.render();
      return;
    }

    // Fuzzy score against the current word
    const currentWord = this.getCurrentWord();
    const scored = completions
      .map((c) => ({ completion: c, score: fuzzyScore(currentWord, c) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return;

    const sortedCompletions = scored.map((s) => s.completion);

    // Auto-complete if best match has score > 2x runner-up
    if (scored.length >= 2 && scored[0]!.score > scored[1]!.score * 2) {
      this.applyCompletionText(scored[0]!.completion);
      this.completionPopup = null;
      this.typeahead.setCompleterPopup(null);
    } else {
      // Show popup via TypeaheadEngine
      this.completionPopup = sortedCompletions;
      this.completionSelected = 0;
      this.typeahead.setCompleterPopup(sortedCompletions);
      // Apply the common prefix
      const commonPrefix = findCommonPrefix(sortedCompletions);
      if (commonPrefix.length > currentWord.length) {
        this.applyCompletionText(commonPrefix);
      }
    }
    this.render();
  }

  private applyCompletionText(text: string): void {
    const line = this.lines[this.cursorLine] ?? '';
    const currentWord = this.getCurrentWord();
    const wordStart = this.cursorCol - currentWord.length;
    this.lines[this.cursorLine] = line.slice(0, wordStart) + text + line.slice(this.cursorCol);
    this.cursorCol = wordStart + text.length;
    this.refreshAutocomplete();
  }

  private getCurrentWord(): string {
    const line = this.lines[this.cursorLine] ?? '';
    // Find the word boundaries around cursor
    let start = this.cursorCol;
    while (start > 0 && line[start - 1] !== ' ') start--;
    return line.slice(start, this.cursorCol);
  }

  private getCurrentFullLine(): string {
    return this.lines.join('\n');
  }

  // ── Submit ──────────────────────────────────────────────────────────────────

  /** True when Tab should enqueue the current draft instead of completing (C2). */
  private shouldQueueOnTab(): boolean {
    if (!this.config.isTaskRunning?.()) return false;
    const text = this.lines.join('\n').trim();
    if (!text) return false;
    if (text.startsWith('/')) return false;
    return !!this.config.onQueue;
  }

  /** Queue current draft for post-turn execution; keep composer active (C2). */
  private queueSubmit(): void {
    const text = this.lines.join('\n').trim();
    if (!text || !this.config.onQueue) return;

    const queued = this.config.onQueue(text);
    if (!queued) return;

    this.addHistory(text);
    this.clear();
    this.render();
  }

  private submit(): void {
    const rawText = this.lines.join('\n');
    // Expand paste placeholders before submit (C5)
    const expanded = this.pasteStore.expand(rawText);
    const text = expanded.trim();
    if (!text && !this.config.allowEmptySubmit) return;

    this.pasteStore.clear();
    this.addHistory(text);
    this.deactivate();

    // Fire config onSubmit first
    try {
      this.config.onSubmit(text);
    } catch {
      // Swallow
    }

    // Fire registered listeners
    for (const listener of this.submitListeners) {
      try {
        listener(text);
      } catch {
        // Swallow
      }
    }

    // Persist history to disk (fire-and-forget)
    this.saveHistory();
  }

  // ── Slash Command Popup ───────────────────────────────────────────────────────

  /** Check whether the slash command popup should be shown. (Backward-compat, used by tests) */
  private shouldShowSlashPopup(): boolean {
    return this.typeahead.shouldShowSlashPopup(this.getTypeaheadContext());
  }

  /** Get filtered slash commands (backward-compat, used by tests). */
  private getFilteredSlashCommands(): Array<{ name: string; description: string; group: string }> {
    return filterSlashCommands(this.lines[0] ?? '');
  }

  // ── @mention Popup (C3) ───────────────────────────────────────────────────────

  /** Cancel the active @mention popup and reset state. */
  private cancelMention(): void {
    this.typeahead.cancelMention();
  }

  /**
   * Check the current cursor position for a mention trigger (@-prefix).
   * Delegates to TypeaheadEngine.sync() and starts a search when query changes.
   */
  private checkMentionTrigger(): void {
    const ctx = this.getTypeaheadContext();
    const syncResult = this.typeahead.sync(ctx);

    if (syncResult.mentionQuery !== null) {
      // Query changed (or mention just activated) — start a new search
      this.startMentionSearch(syncResult.mentionQuery).catch(() => {});
    }
  }

  /**
   * Search the FTS index for files matching the @mention query.
   * Falls back to a filesystem glob walk when the index is unavailable.
   */
  private async startMentionSearch(query: string): Promise<void> {
    try {
      const { globalIndexer } = await import('../services/indexer.js');
      const hits: SearchHit[] = globalIndexer.search(query, 20);

      if (hits.length > 0) {
        const results: MentionResult[] = hits.map((r) => ({
          type: 'file' as const,
          label: r.id,
          description: r.snippet ?? '',
          insertText: r.id,
          score: r.score,
        }));
        this.typeahead.setMentionResults(results);
        if (this.active) this.render();
        return;
      }
    } catch {
      // FTS index unavailable — fall through to filesystem glob
    }
    this.searchMentionGlob(query);
  }

  /**
   * Fallback: search the filesystem for files matching the @mention query.
   */
  private searchMentionGlob(query: string): void {
    if (query.length < 2) {
      this.typeahead.setMentionResults([]);
      if (this.active) this.render();
      return;
    }
    const projectRoot = process.env['BABEL_PROJECT_ROOT'] || process.cwd();
    const results = searchFilesGlob(query, projectRoot, { maxResults: 20, maxDepth: 10 });
    this.typeahead.setMentionResults(results);
    if (this.active) this.render();
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  /** Full render: write all lines and position cursor. */
  private render(): void {
    if (!this.active) return;

    const buf = OutputBuffer.getInstance();
    let cursorRestored = false;
    if (BABEL_PROMPT_BUFFERED) buf.beginFrame();
    try {

    const viewState = this.typeahead.getViewState();
    const queuedMessages = this.config.getQueuedMessages?.() ?? [];
    const queuedLines = queuedMessages.length > 0 ? Math.min(queuedMessages.length, 3) + 1 : 0;

    // Popup heights from TypeaheadEngine view state
    const slashPopupItems = viewState.mode === 'slash' ? viewState.items : [];
    const slashPopupLines = slashPopupItems.length > 0
      ? Math.min(slashPopupItems.length, 5) + 1 // +1 for separator
      : 0;
    const mentionPopupItems = viewState.mode === 'mention' ? viewState.items : [];
    const mentionPopupHeight = mentionPopupItems.length > 0
      ? Math.min(mentionPopupItems.length, 5) + 1 // +1 for header
      : 0;
    const completerItems = viewState.mode === 'completer' ? viewState.items : [];
    const completerPopupHeight = completerItems.length > 0
      ? Math.min(completerItems.length, 5) + 1 // +1 for separator
      : 0;

    const inputHeight = Math.min(
      this.lines.length + completerPopupHeight + mentionPopupHeight,
      this.maxInputHeight + completerPopupHeight + mentionPopupHeight,
    );
    const totalHeight = inputHeight + slashPopupLines + queuedLines;
    const rows = process.stdout.rows || 24;
    const startRow = Math.max(1, rows - totalHeight);

    // Hide cursor during render
    OutputBuffer.getInstance().write('\x1b[?25l');

    // Save cursor, move to start row
    OutputBuffer.getInstance().write('\x1b[s');

    // Clear from startRow to bottom
    for (let r = startRow; r <= rows; r++) {
      OutputBuffer.getInstance().write(`\x1b[${r};1H\x1b[K`);
    }

    // Queued follow-ups (C2) — dim preview above prompt
    if (queuedLines > 0) {
      const headerRow = startRow;
      if (headerRow <= rows) {
        const header = this.config.isTaskRunning?.()
          ? dim(' Queued (Tab) · runs after current turn')
          : dim(' Queued');
        OutputBuffer.getInstance().write(
          `\x1b[${headerRow};1H${header.slice(0, Math.min(header.length, this.termWidth - 1))}`,
        );
      }
      const maxShow = Math.min(queuedMessages.length, 3);
      for (let i = 0; i < maxShow; i++) {
        const r = startRow + 1 + i;
        if (r > rows) break;
        const preview = sanitizeUserText(queuedMessages[i] ?? '');
        const oneLine = preview.replace(/\s+/g, ' ').trim();
        const truncated =
          oneLine.length > this.termWidth - 4 ? oneLine.slice(0, this.termWidth - 7) + '...' : oneLine;
        OutputBuffer.getInstance().write(`\x1b[${r};1H${dim(` ↳ ${truncated}`)}`);
      }
      if (queuedMessages.length > maxShow) {
        const r = startRow + 1 + maxShow;
        if (r <= rows) {
          OutputBuffer.getInstance().write(
            `\x1b[${r};1H${ghost(`   +${queuedMessages.length - maxShow} more queued`)}`,
          );
        }
      }
    }

    const textStartBase = startRow + queuedLines;

    // Render slash command popup above prompt area (C3)
    if (viewState.mode === 'slash' && slashPopupItems.length > 0) {
      const maxShow = Math.min(slashPopupItems.length, 5);
      const sepRow = startRow;
      if (sepRow <= rows) {
        OutputBuffer.getInstance().write(`\x1b[${sepRow};1H${dim('─'.repeat(Math.min(this.termWidth, 40)))}`);
      }
      for (let i = 0; i < maxShow; i++) {
        const r = sepRow + 1 + i;
        if (r > rows) break;
        const item = slashPopupItems[i];
        if (!item) break;
        const displayText = ` ${item.label.padEnd(12)} ${item.description}`;
        const truncated = displayText.slice(0, Math.min(displayText.length, this.termWidth - 1));
        if (i === viewState.selectedIndex) {
          OutputBuffer.getInstance().write(`\x1b[${r};1H\x1b[7m${truncated}\x1b[0m`);
        } else {
          OutputBuffer.getInstance().write(`\x1b[${r};1H${dim(truncated)}`);
        }
      }
    }

    const textStart = textStartBase + slashPopupLines;

    // Render each line of the text buffer
    for (let i = 0; i < this.lines.length; i++) {
      const row = textStart + i;
      if (row > rows) break; // Can't render beyond screen

      const prefix = i === 0 ? this.config.prompt : this.config.continuationPrompt;
      const line = sanitizeUserText(this.lines[i] ?? '');

      OutputBuffer.getInstance().write(`\x1b[${row};1H`);

      if (this.visualStart) {
        const selRange = this.getSelectionColRange(i);
        if (selRange) {
          const before = line.slice(0, selRange.start);
          const selected = line.slice(selRange.start, selRange.end);
          const after = line.slice(selRange.end);
          const selectionHighlight = selected ? `\x1b[7m${selected}\x1b[0m` : '';
          OutputBuffer.getInstance().write(prefix + before + selectionHighlight + after);
        } else {
          OutputBuffer.getInstance().write(prefix + line);
        }
      } else {
        OutputBuffer.getInstance().write(prefix + line);
      }

      // Ghost text (inline autocomplete)
      if (i === this.cursorLine) {
        const suffix = sanitizeUserText(this.ac.getGhostText() ?? '');
        if (suffix) {
          OutputBuffer.getInstance().write(ghost(suffix));
        }
      }

      // Show line continuation marker if line exceeds terminal width
      if (visibleLength(prefix + line) > this.termWidth) {
        // Truncated display — we'd need horizontal scrolling for full editing
        // For now, just show what fits
      }
    }

    // Render @mention popup below the input (C3)
    if (viewState.mode === 'mention' && mentionPopupItems.length > 0) {
      const popupRow = textStart + this.lines.length;
      const maxShow = Math.min(mentionPopupItems.length, 5);

      if (popupRow <= rows) {
        const header = ` Files matching @${viewState.mentionQuery ?? ''}`;
        OutputBuffer.getInstance().write(
          `\x1b[${popupRow};1H${dim(header.slice(0, Math.min(header.length, this.termWidth - 1)))}`,
        );

        for (let i = 0; i < maxShow; i++) {
          const r = popupRow + 1 + i;
          if (r > rows) break;
          const item = mentionPopupItems[i];
          if (!item) break;
          const isSelected = i === viewState.selectedIndex;
          const displayText = ` ${item.label}${item.description ? `  ${ghost(item.description)}` : ''}`;
          const truncated = displayText.slice(0, Math.min(displayText.length, this.termWidth - 1));
          if (isSelected) {
            OutputBuffer.getInstance().write(`\x1b[${r};1H\x1b[7m${truncated}\x1b[0m`);
          } else {
            OutputBuffer.getInstance().write(`\x1b[${r};1H${dim(truncated)}`);
          }
        }
      }
    }

    // Render completion popup below the input (C3)
    if (viewState.mode === 'completer' && completerItems.length > 0) {
      const popupRow = textStart + this.lines.length + mentionPopupHeight;
      if (popupRow <= rows) {
        const maxPopupLines = Math.min(completerItems.length, 5);
        OutputBuffer.getInstance().write(`\x1b[${popupRow};1H${dim('─'.repeat(Math.min(this.termWidth, 40)))}`);
        for (let i = 0; i < maxPopupLines; i++) {
          const r = popupRow + 1 + i;
          if (r > rows) break;
          const item = completerItems[i];
          if (!item) break;
          const entry = item.label;
          const highlighted =
            i === viewState.selectedIndex
              ? `\x1b[7m ${entry.padEnd(Math.min(this.termWidth - 2, 38))} \x1b[0m`
              : ` ${entry}`;
          OutputBuffer.getInstance().write(`\x1b[${r};1H${highlighted}`);
        }
        if (completerItems.length > maxPopupLines) {
          const r = popupRow + 1 + maxPopupLines;
          if (r <= rows) {
            OutputBuffer.getInstance().write(
              `\x1b[${r};1H${ghost(`  ... ${completerItems.length - maxPopupLines} more`)}`,
            );
          }
        }
      }
    }

    // Show vim mode indicator (right-aligned, dimmed)
    if (this.mode === 'normal') {
      const indicator = '-- NORMAL --';
      const indicatorCol = Math.max(1, this.termWidth - indicator.length + 1);
      OutputBuffer.getInstance().write(`\x1b[1;${indicatorCol}H${dim(indicator)}`);
    } else if (this.mode === 'visual') {
      const vtype = this.visualMode === 'line' ? 'LINE' : 'VISUAL';
      const indicator = `-- ${vtype} --`;
      const indicatorCol = Math.max(1, this.termWidth - indicator.length + 1);
      OutputBuffer.getInstance().write(`\x1b[1;${indicatorCol}H${dim(indicator)}`);
    }

    // Position cursor
    this.renderCursor();
    cursorRestored = true;

    // Restore saved position (actually we overwrite with cursor position, so skip restore)
    } finally {
      if (!cursorRestored) {
        buf.write('\x1b[?25h');
      }
      if (BABEL_PROMPT_BUFFERED) buf.endFrame();
    }
  }

  /** Render only the cursor at its current position. */
  private renderCursor(): void {
    if (!this.active) return;

    const buf = OutputBuffer.getInstance();
    let cursorRestored = false;
    if (BABEL_PROMPT_BUFFERED) buf.beginFrame();
    try {

    const viewState = this.typeahead.getViewState();
    const rows = process.stdout.rows || 24;
    const queuedMessages = this.config.getQueuedMessages?.() ?? [];
    const queuedLines = queuedMessages.length > 0 ? Math.min(queuedMessages.length, 3) + 1 : 0;
    const slashPopupItems = viewState.mode === 'slash' ? viewState.items : [];
    const slashPopupLines = slashPopupItems.length > 0
      ? Math.min(slashPopupItems.length, 5) + 1
      : 0;
    const mentionPopupItems = viewState.mode === 'mention' ? viewState.items : [];
    const mentionPopupHeight = mentionPopupItems.length > 0
      ? Math.min(mentionPopupItems.length, 5) + 1
      : 0;
    const completerItems = viewState.mode === 'completer' ? viewState.items : [];
    const completerPopupHeight = completerItems.length > 0
      ? Math.min(completerItems.length, 5) + 1
      : 0;
    const inputHeight = Math.min(
      this.lines.length + completerPopupHeight + mentionPopupHeight,
      this.maxInputHeight + completerPopupHeight + mentionPopupHeight,
    );
    const startRow = Math.max(1, rows - inputHeight - slashPopupLines - queuedLines);

    // G6 — CJK-aware caret parking (textStart = startRow + queued + slash)
    const { row: finalRow, col: finalCol } = computeImeCursorPos({
      startRow, queuedLines, slashPopupLines,
      cursorLine: this.cursorLine, cursorCol: this.cursorCol,
      prompt: this.config.prompt, continuationPrompt: this.config.continuationPrompt,
      termRows: rows, termCols: this.termWidth,
    });
    const show = this.cursorVisible || shouldParkImeCursor(this.imeComposing);
    buf.write(`${cupSequence({ row: finalRow, col: finalCol })}${show ? '\x1b[?25h' : '\x1b[?25l'}`);
    cursorRestored = true;

    } finally {
      if (!cursorRestored) {
        buf.write('\x1b[?25h');
      }
      if (BABEL_PROMPT_BUFFERED) buf.endFrame();
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0] ?? '';
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i] ?? '';
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
    if (prefix === '') break;
  }
  return prefix;
}
