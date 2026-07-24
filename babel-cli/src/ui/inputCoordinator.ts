import { Writable } from 'node:stream';
import type { Interface } from 'node:readline';
import * as readline from 'node:readline';

import type { AgentAction } from '../agent/actions.js';
import type { PermissionDialogConfig } from './dialog.js';
import { PermissionDialog } from './dialog.js';
import { OutputBuffer } from './outputBuffer.js';
import { DEC_2026_END } from './terminalEscapeSequences.js';
import {
  initialInputArbiterState,
  reduceInputArbiter,
  consumeInputArbiterEffects,
  type InputArbiterState,
  type InputArbiterEvent,
  type InputArbiterEffect,
} from './inputArbiterModes.js';

export { consumeInputArbiterEffects };

/** P2-B: process-wide input arbiter mode (single stdin owner). */
let _arbiterState: InputArbiterState = initialInputArbiterState();

export function getInputArbiterState(): InputArbiterState {
  return _arbiterState;
}

export function dispatchInputArbiter(
  event: InputArbiterEvent,
): { state: InputArbiterState; effects: InputArbiterEffect[] } {
  const result = reduceInputArbiter(_arbiterState, event);
  _arbiterState = result.state;
  return result;
}

export function resetInputArbiterForTests(): void {
  _arbiterState = initialInputArbiterState();
}

/**
 * Broader action union for the permission dialog system.
 * Covers all action types the PermissionDialog can display, including
 * executor-level tool calls that are not part of the canonical AgentAction type.
 */
export type PermissionAction =
  | AgentAction
  | { type: 'shell_exec'; command: string }
  | { type: 'delete_file'; path: string }
  | { type: 'mcp_call'; toolName: string; arguments: string }
  | { type: 'generic'; description: string };

let runDepth = 0;
let readlinePausedForRun = false;
let registeredReadline: Interface | null = null;

export function registerReadlineInterface(rl: Interface): void {
  registeredReadline = rl;
}

/**
 * Pause readline while a governed/lite/ask run owns the terminal.
 * Nested calls are reference-counted so inner prompts can release without resuming early.
 */
export function stdinCoordinatorPauseForRun(rl: Interface = registeredReadline!): void {
  runDepth += 1;
  if (runDepth === 1) {
    rl.pause();
    readlinePausedForRun = true;
    dispatchInputArbiter({ type: 'run_started' });
  }
}

export function stdinCoordinatorResumeAfterRun(rl: Interface = registeredReadline!): void {
  runDepth = Math.max(0, runDepth - 1);
  if (runDepth === 0 && readlinePausedForRun) {
    readlinePausedForRun = false;
    rl.resume();
    dispatchInputArbiter({ type: 'run_ended' });
  }
}

/**
 * Exclusive raw-mode stdin for plan checklist and similar overlays.
 * Expects the parent session to have paused readline already.
 */
export async function withRawStdinPrompt<T>(fn: () => Promise<T>): Promise<T> {
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  try {
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
    }
    return await fn();
  } finally {
    if (stdin.isTTY) {
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }
  }
}

export function stdinCoordinatorRunDepth(): number {
  return runDepth;
}

/**
 * RAII-style wrapper that pauses readline for the duration of a run,
 * guaranteeing resume in a finally block even if the callback throws.
 *
 * Prefer this over manual stdinCoordinatorPauseForRun / ResumeAfterRun
 * pairs at call sites where an exception between pause and resume would
 * leave stdin permanently paused.
 *
 * @example
 * await withPausedStdin(async () => {
 *   // run that owns the terminal
 * });
 */
export async function withPausedStdin<T>(
  fn: () => Promise<T>,
  rl: Interface | null = registeredReadline,
): Promise<T> {
  // No-op when no readline is registered (standalone overlays / early bootstrap tests)
  if (!rl) {
    return fn();
  }
  stdinCoordinatorPauseForRun(rl);
  try {
    return await fn();
  } finally {
    stdinCoordinatorResumeAfterRun(rl);
  }
}

/**
 * Discard any bytes already buffered on stdin (paused or flowing).
 * Call after an exclusive overlay prompt so residual keystrokes (e.g. the
 * digits typed into the resume picker) cannot be delivered to the REPL as
 * the first chat task.
 */
export function drainStdinResiduals(): void {
  const stdin = process.stdin;
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      // Cooked mode for a clean drain; PromptInput re-enables raw on activate.
      stdin.setRawMode(false);
    }
  } catch {
    /* ignore */
  }

  // Switch to paused mode and read out the kernel/userland buffer.
  try {
    stdin.pause();
  } catch {
    /* ignore */
  }
  if (typeof stdin.read === 'function') {
    try {
      let chunk: string | Buffer | null;
      while ((chunk = stdin.read()) !== null) {
        void chunk;
      }
    } catch {
      /* ignore */
    }
  }
}

export type Owner = 'repl' | 'renderer' | 'jit';

export async function captureRawKeypress(question: string): Promise<boolean> {
  const stdin = process.stdin;
  const isTTY = stdin.isTTY && process.env['BABEL_TEST_FORCE_NON_TTY'] !== 'true';

  if (!isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: stdin,
        output: process.stdout,
      });
      rl.question(question, (answer) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === 'y' || trimmed === 'yes');
      });
    });
  }

  return new Promise<boolean>((resolve) => {
    // Write JIT prompt question through OutputBuffer for a11y stripping.
    // Outside any frame so this reaches stdout immediately.
    OutputBuffer.getInstance().write(question);
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();
    stdin.setRawMode(true);
    stdin.resume();

    const watchdog = setTimeout(() => {
      cleanup();
      OutputBuffer.getInstance().write('\n[TIMEOUT] JIT prompt timed out after 30s. Auto-denying.\n');
      resolve(false);
    }, 30000);

    const onData = (data: Buffer) => {
      const char = data.toString('utf8');
      if (char === '') {
        // Ctrl+C
        clearTimeout(watchdog);
        cleanup();
        process.exit(130);
      }
      const lower = char.toLowerCase();
      if (lower === 'y' || char === '\r' || char === '\n') {
        clearTimeout(watchdog);
        cleanup();
        OutputBuffer.getInstance().write('\n');
        resolve(true);
      } else if (lower === 'n') {
        clearTimeout(watchdog);
        cleanup();
        OutputBuffer.getInstance().write('\n');
        resolve(false);
      }
    };

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      if (wasPaused) {
        stdin.pause();
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Build a compact preview summary for a JIT permission prompt before the y/n question.
 *
 * For write_file: shows file path, total line count, and first 3 lines truncated.
 * For apply_patch: shows patch diff stats (+/-) and first 3 lines truncated.
 * Returns empty string for action types that cannot be previewed.
 */
export function formatPermissionPreview(action: PermissionAction): string {
  switch (action.type) {
    case 'write_file': {
      const lines = action.content.split('\n');
      const totalLines = lines.length;
      const previewLines = lines.slice(0, 3);
      let out = `File: ${action.path}\n`;
      out += `Lines: ${totalLines}\n`;
      out += previewLines.map((l) => `  ${l}`).join('\n');
      if (totalLines > 3) out += '\n  ...';
      return out;
    }
    case 'apply_patch': {
      const patchLines = action.patch.split('\n');
      const added = patchLines.filter((l) => l.startsWith('+')).length;
      const removed = patchLines.filter((l) => l.startsWith('-')).length;
      const previewLines = patchLines.slice(0, 3);
      let out = `Patch: +${added}/-${removed} lines\n`;
      out += previewLines.map((l) => `  ${l}`).join('\n');
      if (patchLines.length > 3) out += '\n  ...';
      return out;
    }
    case 'shell_exec': {
      const cmdLines = action.command.split('\n');
      const previewLines = cmdLines.slice(0, 3);
      let out = `Command: ${cmdLines[0] ?? ''}\n`;
      out += previewLines.map((l) => `  ${l}`).join('\n');
      if (cmdLines.length > 3) out += '\n  ...';
      return out;
    }
    case 'delete_file': {
      return `Delete: ${action.path}`;
    }
    case 'mcp_call': {
      const argLines = action.arguments.split('\n');
      const previewLines = argLines.slice(0, 3);
      let out = `Tool: ${action.toolName}\n`;
      out += previewLines.map((l) => `  ${l}`).join('\n');
      if (argLines.length > 3) out += '\n  ...';
      return out;
    }
    case 'generic': {
      return action.description;
    }
    default:
      return '';
  }
}

/**
 * Build a PermissionDialogConfig from an AgentAction for use with the
 * dialog-based permission system (replaces raw y/n prompt).
 */
/**
 * Map a chat/agent action to a PermissionDialog-compatible action shape.
 * Returns null for read-only actions that should not prompt.
 */
export function agentActionToPermissionAction(action: AgentAction): PermissionAction | null {
  switch (action.type) {
    case 'write_file':
    case 'apply_patch':
      return action;
    case 'run_command':
      return { type: 'shell_exec', command: action.command };
    default:
      return null;
  }
}

export function buildPermissionDialogConfig(
  action: PermissionAction,
): PermissionDialogConfig | null {
  switch (action.type) {
    case 'write_file': {
      const lines = action.content.split('\n');
      const preview = lines.slice(0, 8).join('\n');
      return {
        title: `Write to ${action.path}`,
        message: `The agent wants to write a file. ${lines.length} lines will be written.`,
        actionType: 'write_file',
        path: action.path,
        preview: preview + (lines.length > 8 ? `\n... ${lines.length - 8} more lines` : ''),
        metadata: [`${lines.length} lines`, `File: ${action.path}`],
      };
    }
    case 'apply_patch': {
      const patchLines = action.patch.split('\n');
      const added = patchLines.filter((l) => l.startsWith('+')).length;
      const removed = patchLines.filter((l) => l.startsWith('-')).length;
      const preview = patchLines.slice(0, 8).join('\n');
      return {
        title: `Apply patch`,
        message: `The agent wants to apply a patch (+${added}/-${removed} lines).`,
        actionType: 'apply_patch',
        preview:
          preview + (patchLines.length > 8 ? `\n... ${patchLines.length - 8} more lines` : ''),
        metadata: [`+${added}/-${removed} lines`],
        showDiff: true,
      };
    }
    case 'shell_exec': {
      const cmdLines = action.command.split('\n');
      const preview = cmdLines.slice(0, 8).join('\n');
      const firstLine = cmdLines[0] ?? '';
      return {
        title: `Execute command`,
        message: `The agent wants to execute a shell command.`,
        actionType: 'shell_exec',
        path: action.command,
        preview: preview + (cmdLines.length > 8 ? `\n... ${cmdLines.length - 8} more lines` : ''),
        metadata: [
          `${cmdLines.length} line${cmdLines.length !== 1 ? 's' : ''}`,
          `Command: ${firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine}`,
        ],
      };
    }
    case 'delete_file': {
      return {
        title: `Delete file`,
        message: `The agent wants to delete a file:\n  ${action.path}`,
        actionType: 'delete_file',
        path: action.path,
        preview: `The file at "${action.path}" will be permanently deleted.`,
        metadata: [`Path: ${action.path}`],
      };
    }
    case 'mcp_call': {
      const argStr = action.arguments;
      const argLines = argStr.split('\n');
      const preview = argLines.slice(0, 8).join('\n');
      return {
        title: `MCP call`,
        message: `The agent wants to call MCP tool "${action.toolName}".`,
        actionType: 'mcp_call',
        path: action.toolName,
        preview: preview + (argLines.length > 8 ? `\n... ${argLines.length - 8} more lines` : ''),
        metadata: [`Tool: ${action.toolName}`],
      };
    }
    case 'generic': {
      return {
        title: `Action`,
        message: action.description || `The agent wants to perform an action.`,
        actionType: 'generic',
        metadata: [`Description: ${action.description}`],
      };
    }
    default:
      return null;
  }
}

/**
 * Show a structured permission dialog for an agent action.
 *
 * Uses the Dialog system (PermissionDialog) for all known action types
 * (write_file, apply_patch, shell_exec, delete_file, mcp_call, generic),
 * falling back to raw keypress capture for any unrecognized action type.
 *
 * Callers should wrap this in `coordinator.withLock('jit', ...)` and
 * pause/resume the active renderer — this function only handles the
 * dialog/keypress interaction itself.
 */
export async function promptPermissionDialog(action: PermissionAction): Promise<boolean> {
  const config = buildPermissionDialogConfig(action);
  if (!config) {
    // Fallback to raw keypress for unsupported action types
    const question = `\n[JIT APPROVAL] Allow action type "${action.type}"? [y/N]: `;
    return captureRawKeypress(question);
  }
  return PermissionDialog.show(config);
}

export class InputCoordinator {
  private static instance: InputCoordinator | null = null;
  private isBuffering = false;
  private buffer: string[] = [];
  private bufferSize = 0;
  private readonly maxBufferSize = 64 * 1024; // 64KB
  private originalStdoutWrite: typeof process.stdout.write | null = null;
  private originalStderrWrite: typeof process.stderr.write | null = null;
  private altScreenActive = false;

  // Mutex state
  private locked = false;
  private currentOwner: Owner | null = null;
  private queue: Array<{ owner: Owner; resolve: () => void }> = [];

  public static getInstance(): InputCoordinator {
    if (!InputCoordinator.instance) {
      InputCoordinator.instance = new InputCoordinator();
    }
    return InputCoordinator.instance;
  }

  constructor() {
    process.on('SIGINT', () => {
      this.emergencyRestore();
      process.exit(130);
    });
    process.on('exit', () => {
      this.emergencyRestore();
    });
    process.on('SIGTERM', () => {
      this.emergencyRestore();
      process.exit(143);
    });
    process.on('SIGHUP', () => {
      this.emergencyRestore();
      process.exit(129);
    });
    process.on('uncaughtException', (err) => {
      this.emergencyRestore();
      console.error('\nUncaught Exception:', err);
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      this.emergencyRestore();
      console.error('\nUnhandled Rejection:', reason);
      process.exit(1);
    });
  }

  public emergencyRestore(): void {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    // Raw stdout writes during emergency restore: process.stdout.write may be
    // monkey-patched by startBuffering() during a governed run. If we're
    // crashing, we bypass OutputBuffer to guarantee terminal sequences reach
    // the terminal before the process exits. OutputBuffer should not be used
    // while stdout.write is replaced.
    process.stdout.write('[?25h');
    // Disable mouse tracking inline (same reason — avoid OutputBuffer while
    // stdout.write is monkey-patched)
    process.stdout.write('[?1006l[?1003l[?1002l[?1000l');
    // Exit alternate screen buffer (only if active)
    if (this.altScreenActive) {
      process.stdout.write('[?1049l');
      this.altScreenActive = false;
    }
    // End DEC 2026 synchronized update if active. Must be a raw write
    // (before restoring the monkey-patched stdout.write) because OutputBuffer
    // may be in a corrupted state during a crash. Without this, a crash
    // mid-frame on a DEC-2026 terminal leaves all subsequent output
    // invisibly buffered.
    process.stdout.write(DEC_2026_END);


    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }
    this.locked = false;
    this.currentOwner = null;
    this.queue = [];
  }

  public enterAlternateScreen(): void {
    this.altScreenActive = true;
    const buf = OutputBuffer.getInstance();
    // Enter alternate screen buffer
    buf.write('[?1049h');
    // Clear screen
    buf.write('[2J');
    // Move cursor to home
    buf.write('[H');
    // Enable XTerm SGR mouse tracking so mouse wheel scrolls agent output
    this.enableMouseTracking();
  }

  public exitAlternateScreen(): void {
    if (!this.altScreenActive) return;
    // Disable mouse tracking before leaving alternate screen
    this.disableMouseTracking();
    const buf = OutputBuffer.getInstance();
    // Exit alternate screen buffer
    buf.write('[?1049l');
    // Show cursor
    buf.write('[?25h');
    this.altScreenActive = false;
  }

  /** Enable XTerm SGR mouse tracking (mode 1003 = any-event, 1006 = SGR encoding). */
  public enableMouseTracking(): void {
    if (!process.stdin.isTTY) return;
    // 1000 = basic tracking, 1002 = button-event, 1003 = any-event, 1006 = SGR
    // Routes through OutputBuffer for a11y stripping; immediate when no frame active.
    OutputBuffer.getInstance().write('[?1000h[?1002h[?1003h[?1006h');
  }

  /** Disable XTerm SGR mouse tracking. */
  public disableMouseTracking(): void {
    if (!process.stdin.isTTY) return;
    // Routes through OutputBuffer for a11y stripping; immediate when no frame active.
    OutputBuffer.getInstance().write('[?1006l[?1003l[?1002l[?1000l');
  }

  public isLocked(): boolean {
    return this.locked;
  }

  public getOwner(): Owner | null {
    return this.currentOwner;
  }

  public tryAcquire(owner: Owner): (() => void) | null {
    if (!this.locked) {
      this.locked = true;
      this.currentOwner = owner;
      return () => this.release(owner);
    }
    return null;
  }

  public acquire(owner: Owner): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      this.currentOwner = owner;
      return Promise.resolve(() => this.release(owner));
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push({
        owner,
        resolve: () => resolve(() => this.release(owner)),
      });
    });
  }

  public release(owner: Owner): void {
    if (this.currentOwner !== owner) {
      throw new Error(
        `InputCoordinator: Cannot release lock owned by '${this.currentOwner}' from owner '${owner}'`,
      );
    }
    const next = this.queue.shift();
    if (next) {
      this.currentOwner = next.owner;
      next.resolve();
    } else {
      this.locked = false;
      this.currentOwner = null;
    }
  }

  public async withLock<T>(owner: Owner, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(owner);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public getOriginalStdoutWrite(): typeof process.stdout.write | null {
    return this.originalStdoutWrite;
  }

  public startBuffering(): void {
    if (this.isBuffering) return;
    this.isBuffering = true;
    this.buffer = [];
    this.bufferSize = 0;

    this.originalStdoutWrite = process.stdout.write;
    this.originalStderrWrite = process.stderr.write;

    const self = this;

    process.stdout.write = function (chunk: any, encoding?: any, callback?: any): boolean {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      self.addToBuffer(str);
      if (callback) callback();
      return true;
    } as any;

    process.stderr.write = function (chunk: any, encoding?: any, callback?: any): boolean {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      self.addToBuffer(str);
      if (callback) callback();
      return true;
    } as any;
  }

  private addToBuffer(str: string): void {
    let toAdd = str;
    let bytes = Buffer.byteLength(toAdd, 'utf8');

    if (bytes > this.maxBufferSize) {
      toAdd = toAdd.slice(0, this.maxBufferSize);
      bytes = Buffer.byteLength(toAdd, 'utf8');
    }

    if (this.bufferSize + bytes > this.maxBufferSize) {
      const warning = '\n--- [WARNING: STDOUT BUFFER TRUNCATED FOR MEMORY SAFETY] ---\n';
      const warningBytes = Buffer.byteLength(warning, 'utf8');

      while (
        this.buffer.length > 0 &&
        this.bufferSize + bytes + warningBytes > this.maxBufferSize
      ) {
        const removed = this.buffer.shift() || '';
        this.bufferSize -= Buffer.byteLength(removed, 'utf8');
      }

      if (!this.buffer.includes(warning)) {
        this.buffer.push(warning);
        this.bufferSize += warningBytes;
      }

      if (this.bufferSize + bytes > this.maxBufferSize) {
        const allowedBytes = Math.max(0, this.maxBufferSize - this.bufferSize);
        const buf = Buffer.from(toAdd, 'utf8').subarray(0, allowedBytes);
        toAdd = buf.toString('utf8');
        bytes = Buffer.byteLength(toAdd, 'utf8');
      }
    }

    if (bytes > 0) {
      this.buffer.push(toAdd);
      this.bufferSize += bytes;
    }
  }

  public stopBuffering(): string {
    if (!this.isBuffering) return '';
    this.isBuffering = false;

    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }

    const flushed = this.buffer.join('');
    this.buffer = [];
    this.bufferSize = 0;
    return flushed;
  }
}
