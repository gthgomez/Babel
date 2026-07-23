/**
 * PromptInputAdapter — readline-compatible wrapper around PromptInput.
 *
 * Provides the same API surface as Node.js readline.Interface so it can
 * replace `readline.createInterface()` with minimal changes to interactive.ts.
 *
 * Gate: Only activates when stdout is a TTY, not in CI, and not on legacy
 * Windows console (where raw ANSI cursor control is unreliable). Falls back
 * to standard readline otherwise.
 *
 * Usage in interactive.ts:
 *   // Old:
 *   this.rl = readline.createInterface({ input, output, prompt, ... });
 *   // New:
 *   this.rl = createPromptInputAdapter({ prompt, history, completer, onSubmit, onCancel });
 *
 * @module promptInputAdapter
 */

import * as readline from 'node:readline';
import type { Interface } from 'node:readline';
import { PromptInput, type PromptInputConfig } from './promptInput.js';
import {
  enqueueComposerMessage,
  getComposerQueueSnapshot,
} from './composerQueue.js';
import { OutputBuffer } from './outputBuffer.js';
import { supportsColor } from './theme.js';
import { isLegacyWindowsConsole } from './terminalProbe.js';

// ── Detection ───────────────────────────────────────────────────────────────────

/**
 * Whether the PromptInput V2 path should be used.
 *
 * Default: ON for interactive TTY sessions. Disabled automatically on
 * non-TTY, CI, and legacy Windows consoles (where raw ANSI is unreliable).
 *
 * Override:
 *   BABEL_PROMPT_V2=1 or true  → force on (overrides safety gates)
 *   BABEL_PROMPT_V2=0 or false → force off (opt-out)
 */
export function shouldUsePromptInputV2(): boolean {
  const env = process.env['BABEL_PROMPT_V2'];
  // Force-on override: BABEL_PROMPT_V2=1 or BABEL_PROMPT_V2=true
  if (env === '1' || env === 'true') return true;
  // Opt-out: BABEL_PROMPT_V2=0 or BABEL_PROMPT_V2=false
  if (env === '0' || env === 'false') return false;
  // Safety gates: disabled on non-TTY, CI, and legacy Windows consoles
  if (!process.stdout.isTTY) return false;
  if (process.env['CI']) return false;
  if (isLegacyWindowsConsole()) return false;
  // Default: on for interactive TTY sessions
  return true;
}

// ── Readline-compatible adapter ─────────────────────────────────────────────────

type LineCallback = (line: string) => void;
type SigintCallback = () => void;

/**
 * Standalone adapter interface mirroring the readline.Interface subset used by BabelRepl.
 * Does NOT extend Node's Interface directly to avoid requiring ~20 unused properties
 * (terminal, line, cursor, getPrompt, etc.) that PromptInput doesn't need.
 */
export interface PromptInputAdapter {
  prompt(): void;
  on(event: 'line', listener: LineCallback): this;
  on(event: 'SIGINT', listener: SigintCallback): this;
  question(query: string, callback: (answer: string) => void): void;
  question(query: string): Promise<string>;
  setPrompt(prompt: string): void;
  pause(): this;
  resume(): this;
  write(data: string): void;
  close(): void;
  ref(): void;
  unref(): void;
  /** Readline-compatible history accessor. */
  readonly history: string[];
  /** Get the current history (for persistence). */
  getHistory(): string[];
  /** Enable or disable vim mode dynamically. */
  setVimMode(enabled: boolean): void;
  /** Expose the underlying PromptInput for voice dictation and other subsystems.
   *  Returns null if the adapter was created without a PromptInput (readline fallback). */
  getPromptInput(): PromptInput | null;
}

/**
 * Create a readline-compatible interface backed by PromptInput.
 *
 * @param config  Configuration matching PromptInput + readline needs
 * @returns An Interface-compatible adapter if the V2 path is active, or a standard readline Interface
 */
export function createPromptInputAdapter(config: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: string;
  historySize?: number;
  completer?: (line: string) => [string[], string];
  history?: string[];
  onSubmit?: (line: string) => void;
  onCancel?: () => void;
  onInterrupt?: () => void;
  onCommandPalette?: () => void;
  onExternalEditor?: () => void | Promise<void>;
  vimMode?: boolean;
  /** When agent is busy, Tab queues follow-up input (C2). */
  isTaskRunning?: () => boolean;
  /** Voice dictation toggle (Ctrl+Shift+V). Returns true if the key was consumed. */
  onVoiceToggle?: () => boolean;
}): Interface {
  if (!shouldUsePromptInputV2()) {
    // Fallback to standard readline
    const rl = readline.createInterface({
      input: config.input ?? process.stdin,
      output: config.output ?? process.stdout,
      prompt: config.prompt ?? '› ',
      historySize: config.historySize ?? 100,
      completer: config.completer,
    });
    return rl;
  }

  return new PromptInputAdapterImpl(config) as unknown as Interface;
}

// ── Implementation ─────────────────────────────────────────────────────────────

class PromptInputAdapterImpl implements PromptInputAdapter {
  private promptInput: PromptInput | null = null;

  /** Expose the underlying PromptInput for voice dictation and other subsystems
   *  that need direct access to the prompt state. Returns null if the adapter
   *  was created without a PromptInput (readline fallback path). */
  getPromptInput(): PromptInput | null {
    return this.promptInput;
  }
  private lineCallbacks: LineCallback[] = [];
  private sigintCallbacks: SigintCallback[] = [];
  private currentPrompt: string;
  private completer: ((line: string) => [string[], string]) | undefined;
  private paused = false;
  private closed = false;
  private internalRl: Interface; // For question() fallback
  private historySnapshot: string[];
  private vimMode: boolean;
  /** Active temporary PromptInput used by question(), if any.
   *  Tracked so close() can clean it up if the question was never answered. */
  private activeQuestionInput: PromptInput | null = null;

  constructor(config: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    prompt?: string;
    historySize?: number;
    completer?: (line: string) => [string[], string];
    history?: string[];
    onSubmit?: (line: string) => void;
    onCancel?: () => void;
    onInterrupt?: () => void;
    onCommandPalette?: () => void;
    onExternalEditor?: () => void | Promise<void>;
    vimMode?: boolean;
    isTaskRunning?: () => boolean;
    onVoiceToggle?: () => boolean;
  }) {
    this.currentPrompt = config.prompt ?? '› ';
    this.completer = config.completer;
    this.historySnapshot = config.history ?? [];
    this.vimMode = config.vimMode ?? false;

    // Internal readline for question() — PromptInput doesn't handle this yet
    this.internalRl = readline.createInterface({
      input: config.input ?? process.stdin,
      output: config.output ?? process.stdout,
      prompt: config.prompt ?? '› ',
    });

    // Wire SIGINT callbacks through PromptInput's cancel/interrupt hooks
    // so readline-compatible `on('SIGINT', ...)` listeners fire on Ctrl+C.
    const fireSigintCallbacks = () => {
      for (const cb of this.sigintCallbacks) {
        try {
          cb();
        } catch {
          /* swallow */
        }
      }
    };

    this.promptInput = new PromptInput({
      prompt: this.currentPrompt,
      history: this.historySnapshot,
      historySize: config.historySize ?? 200,
      ...(config.completer !== undefined ? { completer: config.completer } : {}),
      onSubmit: (text: string) => {
        config.onSubmit?.(text);
      },
      onCancel: () => {
        config.onCancel?.();
        fireSigintCallbacks();
      },
      onInterrupt: () => {
        config.onInterrupt?.();
        fireSigintCallbacks();
      },
      ...(config.onCommandPalette !== undefined
        ? { onCommandPalette: config.onCommandPalette }
        : {}),
      ...(config.onExternalEditor !== undefined
        ? { onExternalEditor: config.onExternalEditor }
        : {}),
      vimMode: this.vimMode,
      ...(config.isTaskRunning !== undefined ? { isTaskRunning: config.isTaskRunning } : {}),
      ...(config.onVoiceToggle !== undefined ? { onVoiceToggle: config.onVoiceToggle } : {}),
      getQueuedMessages: getComposerQueueSnapshot,
      onQueue: enqueueComposerMessage,
    });

    // Register line callbacks via the public onSubmit listener API
    this.promptInput.onSubmit((text: string) => {
      for (const cb of this.lineCallbacks) {
        try {
          cb(text);
        } catch {
          /* swallow */
        }
      }
    });
  }

  // ── Readline-compatible API ────────────────────────────────────────────────

  /** Expose the current prompt string so reverse-search can save/restore it.
   *  Matches readline.Interface's internal `_prompt` property. */
  get _prompt(): string {
    return this.currentPrompt;
  }

  prompt(): void {
    if (this.closed || this.paused) return;
    if (this.promptInput) {
      this.promptInput.activate();
    }
  }

  on(event: 'line' | 'SIGINT', listener: LineCallback | SigintCallback): this {
    if (event === 'line') {
      this.lineCallbacks.push(listener as LineCallback);
    } else if (event === 'SIGINT') {
      this.sigintCallbacks.push(listener as SigintCallback);
    }
    return this;
  }

  question(query: string, callback: (answer: string) => void): void;
  question(query: string): Promise<string>;
  question(query: string, callback?: (answer: string) => void): void | Promise<string> {
    // PromptInput V2 requires an interactive TTY for raw-mode key handling
    // and proper rendering. Fall back to readline for non-TTY/CI environments.
    if (!shouldUsePromptInputV2() || !process.stdout.isTTY) {
      // Non-V2 path: use internal readline (also works in non-TTY environments)
      if (this.promptInput?.getState().active) {
        this.promptInput.deactivate();
      }

      if (callback) {
        this.internalRl.question(query, callback);
        return;
      }
      return new Promise<string>((resolve) => {
        this.internalRl.question(query, resolve);
      });
    }

    // V2 path: use a temporary PromptInput so the question benefits from
    // V2 features (undo/redo, vim bindings, fuzzy completion, etc.)
    const wasActive = this.promptInput?.getState().active;
    if (wasActive) {
      this.promptInput!.deactivate();
    }

    // Clean up any stale active question input (shouldn't happen, but be safe)
    if (this.activeQuestionInput) {
      try {
        this.activeQuestionInput.deactivate();
      } catch {
        /* ignore */
      }
      this.activeQuestionInput = null;
    }

    // Write the query text via OutputBuffer, same as readline.question()
    // This goes through the unified output path for a11y stripping and DEC 2026 sync.
    OutputBuffer.getInstance().write(query);

    const finishQuestion = (
      qInput: PromptInput,
      resolve: (answer: string) => void,
      answer: string,
    ) => {
      this.activeQuestionInput = null;
      qInput.deactivate();
      if (wasActive) {
        this.promptInput?.activate();
      }
      resolve(answer);
    };

    const doQuestion = (resolve: (answer: string) => void) => {
      const qInput = new PromptInput({
        prompt: '',
        onSubmit: (text: string) => {
          finishQuestion(qInput, resolve, text);
        },
        onCancel: () => {
          finishQuestion(qInput, resolve, '');
        },
        onInterrupt: () => {
          finishQuestion(qInput, resolve, '');
        },
        allowEmptySubmit: true,
      });
      this.activeQuestionInput = qInput;
      qInput.activate();
    };

    if (callback) {
      doQuestion(callback);
      return;
    }
    return new Promise<string>((resolve) => {
      doQuestion(resolve);
    });
  }

  setPrompt(prompt: string): void {
    this.currentPrompt = prompt;
    this.internalRl.setPrompt(prompt);
  }

  pause(): this {
    this.paused = true;
    if (this.promptInput?.getState().active) {
      this.promptInput.deactivate();
    }
    // internalRl is a real Interface on the same stdin — must pause it too or
    // it will consume/buffer keystrokes during overlays (SessionPicker) and
    // can re-emit a phantom 'line' after resume (e.g. the "11" picker choice
    // was being executed as a chat task — see TUI-Output-Bug.md).
    try {
      this.internalRl.pause();
    } catch {
      /* ignore */
    }
    return this;
  }

  resume(): this {
    this.paused = false;
    try {
      this.internalRl.resume();
    } catch {
      /* ignore */
    }
    return this;
  }

  write(data: string): void {
    if (this.promptInput) {
      this.promptInput.setText(data);
      this.promptInput.activate();
    } else {
      // Fallback: write to internal readline
      this.internalRl.write(data);
    }
  }

  close(): void {
    this.closed = true;
    if (this.promptInput?.getState().active) {
      this.promptInput.deactivate();
    }
    // Clean up any active question PromptInput that was never answered
    if (this.activeQuestionInput) {
      try {
        this.activeQuestionInput.deactivate();
      } catch {
        /* ignore */
      }
      this.activeQuestionInput = null;
    }
    this.internalRl.close();
    this.lineCallbacks = [];
    this.sigintCallbacks = [];
  }

  ref(): void {
    // no-op — PromptInput doesn't interact with event loop ref counting
  }

  unref(): void {
    // no-op
  }

  // ── Additional helpers ─────────────────────────────────────────────────────

  /** Get the current history (for persistence). */
  getHistory(): string[] {
    return this.promptInput?.getHistory() ?? this.historySnapshot;
  }

  /** Readline-compatible history accessor. */
  get history(): string[] {
    return this.getHistory();
  }

  /** Fire SIGINT callbacks manually (used by InputCoordinator). */
  fireSigint(): void {
    for (const cb of this.sigintCallbacks) {
      try {
        cb();
      } catch {
        /* swallow */
      }
    }
  }

  /** Enable or disable vim mode dynamically. */
  setVimMode(enabled: boolean): void {
    this.vimMode = enabled;
    if (this.promptInput) {
      this.promptInput.setVimMode(enabled);
    }
  }

  /** Current prompt buffer text (empty when inactive or on readline fallback). */
  getInputText(): string {
    return this.promptInput?.getState().text ?? '';
  }

  /** Replace prompt buffer text and refresh the display. */
  setInputText(text: string): void {
    if (this.promptInput) {
      this.promptInput.setText(text);
      if (this.promptInput.getState().active) {
        this.promptInput.activate();
      }
    }
  }
}
