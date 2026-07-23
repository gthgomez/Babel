/**
 * Session resume picker for chat sessions.
 *
 * Default UI is a **one-shot numbered list** (no CSI redraws). Full-screen /
 * in-place interactive redraw is opt-in only (BABEL_INTERACTIVE_RESUME_PICKER=1)
 * because CSI clear/cursor-up is unreliable on Windows Terminal scrollback
 * (see TUI-Output-Bug.md).
 *
 * Critical stdin rules:
 *   - Pause the registered REPL interface for the whole picker
 *   - Never create a second readline.Interface on the same stdin (leaks the
 *     typed choice into the REPL as a phantom chat task)
 *   - Drain stdin residuals before returning control to the REPL
 */

import process from 'node:process';
import { parseKeypress, type KeyEvent } from './keyInput.js';
import { headerBg, accentBright, muted, primary, dim } from './theme.js';
import { OutputBuffer } from './outputBuffer.js';
import { withPausedStdin, drainStdinResiduals } from './inputCoordinator.js';
import { shouldAvoidAltScreen } from './a11y.js';
import { fuzzyScore } from '../utils/fuzzy.js';
import type { ChatSessionInfo } from '../services/chatSessionIndex.js';

export type SessionPickerResult =
  | { action: 'resume'; sessionId: string }
  | { action: 'new' }
  | { action: 'cancel' };

/** Interactive CSI picker is opt-in only — see file header. */
function wantInteractivePicker(): boolean {
  if (!process.stdout.isTTY) return false;
  if (shouldAvoidAltScreen()) return false;
  const term = (process.env['TERM'] ?? '').toLowerCase();
  if (term === 'dumb') return false;
  const flag = process.env['BABEL_INTERACTIVE_RESUME_PICKER'];
  return flag === '1' || flag === 'true';
}

/**
 * Read one cooked line without creating a readline.Interface.
 * Creates a temporary exclusive `data` listener; caller must ensure other
 * consumers (REPL readline / PromptInput) are paused.
 */
function readExclusiveLine(promptText: string): Promise<string> {
  const stdin = process.stdin;
  const buf = OutputBuffer.getInstance();
  buf.write(promptText);

  if (stdin.isTTY) {
    try {
      stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
  stdin.resume();

  return new Promise<string>((resolve) => {
    let acc = '';
    const onData = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          stdin.off('data', onData);
          buf.write('\n');
          resolve(acc);
          return;
        }
        // Backspace / DEL
        if (ch === '\u007f' || ch === '\b') {
          if (acc.length > 0) {
            acc = acc.slice(0, -1);
            // erase last echoed char (via OutputBuffer — stdout allowlist)
            buf.write('\b \b');
          }
          continue;
        }
        // Ctrl+C → empty cancel
        if (ch === '\u0003') {
          stdin.off('data', onData);
          buf.write('^C\n');
          resolve('');
          return;
        }
        if (ch >= ' ' || ch === '\t') {
          acc += ch;
          buf.write(ch);
        }
      }
    };
    stdin.on('data', onData);
  });
}

export class SessionPicker {
  /** True while any SessionPicker owns the terminal (resize guards, etc.). */
  private static activeCount = 0;

  static isActive(): boolean {
    return SessionPicker.activeCount > 0;
  }

  static async show(sessions: ChatSessionInfo[]): Promise<SessionPickerResult> {
    if (!process.stdout.isTTY || sessions.length === 0) {
      return { action: 'cancel' };
    }

    SessionPicker.activeCount += 1;
    try {
      // Pause REPL readline for the entire picker lifetime (plain or interactive).
      const result = await withPausedStdin(async () => {
        if (wantInteractivePicker()) {
          const picker = new SessionPicker(sessions);
          return picker.run();
        }
        return SessionPicker.showPlain(sessions);
      });
      // Drop any leftover keystrokes so the first REPL line is not "11".
      drainStdinResiduals();
      return result;
    } finally {
      SessionPicker.activeCount -= 1;
    }
  }

  /**
   * Linear, non-redrawing picker — the default and the only reliable path.
   * Prints once; accepts number / n / empty.
   */
  private static async showPlain(sessions: ChatSessionInfo[]): Promise<SessionPickerResult> {
    const buf = OutputBuffer.getInstance();
    buf.writeControl('\x1b[?25h');

    buf.write('\n');
    buf.write(primary('  Resume chat session\n'));
    buf.write(muted('  Enter # to resume · n = new session · empty = cancel\n\n'));

    const limit = Math.min(sessions.length, 30);
    for (let i = 0; i < limit; i++) {
      const s = sessions[i]!;
      const num = String(i + 1).padStart(2, ' ');
      const id = s.id.slice(0, 28).padEnd(28);
      const msgs = `${s.turnCount} msgs`.padEnd(8);
      const preview = s.preview.slice(0, 48);
      buf.write(`  ${primary(num)}  ${id}  ${muted(msgs)}  ${dim(preview)}\n`);
    }
    if (sessions.length > limit) {
      buf.write(muted(`  … ${sessions.length - limit} more not shown\n`));
    }
    buf.write('\n');

    // Exclusive line read — no second readline.Interface (avoids phantom tasks).
    const answer = (await readExclusiveLine(muted('  › '))).trim().toLowerCase();
    if (!answer) return { action: 'cancel' };
    if (answer === 'n' || answer === 'new') return { action: 'new' };
    const idx = Number.parseInt(answer, 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= limit) {
      const session = sessions[idx - 1];
      if (session) return { action: 'resume', sessionId: session.id };
    }
    buf.write(muted('  Unrecognized input — starting a new session.\n'));
    return { action: 'new' };
  }

  // ── Interactive path (opt-in via BABEL_INTERACTIVE_RESUME_PICKER=1) ───────

  private query = '';
  private selectedIdx = 0;
  private filtered: ChatSessionInfo[];
  private rowCount = 24;
  private colCount = 80;
  private cleanupFns: Array<() => void> = [];
  private wasRaw = false;
  private wasPaused = false;
  private resolve!: (r: SessionPickerResult) => void;
  private settled = false;
  private lastPaintedRows = 0;

  constructor(private readonly sessions: ChatSessionInfo[]) {
    this.filtered = [...sessions];
  }

  private async run(): Promise<SessionPickerResult> {
    return new Promise<SessionPickerResult>((resolve) => {
      this.resolve = resolve;
      void this.mount();
    });
  }

  private async mount(): Promise<void> {
    const stdin = process.stdin;
    this.wasRaw = stdin.isTTY ? (stdin.isRaw ?? false) : false;
    this.wasPaused = stdin.isPaused();

    OutputBuffer.getInstance().writeControl('\x1b[?25l');

    if (stdin.isTTY) {
      try {
        stdin.setRawMode(true);
      } catch {
        /* ignore */
      }
      stdin.resume();
    }

    this.rowCount = process.stdout.rows || 24;
    this.colCount = process.stdout.columns || 80;
    this.applyFilter();
    this.render();

    const onResize = () => {
      this.rowCount = process.stdout.rows || 24;
      this.colCount = process.stdout.columns || 80;
      this.render();
    };
    process.stdout.on('resize', onResize);
    this.cleanupFns.push(() => process.stdout.off('resize', onResize));

    const onData = (chunk: Buffer | string) => {
      const bufData = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const key = parseKeypress(bufData);
      if (!key) return;
      this.handleKey(key);
    };
    stdin.on('data', onData);
    this.cleanupFns.push(() => stdin.off('data', onData));
  }

  private handleKey(key: KeyEvent): void {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      this.unmount({ action: 'cancel' });
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const session = this.filtered[this.selectedIdx];
      if (session) {
        this.unmount({ action: 'resume', sessionId: session.id });
      }
      return;
    }
    if (key.name === 'n' && !key.ctrl) {
      this.unmount({ action: 'new' });
      return;
    }
    if (key.name === 'up') {
      this.selectedIdx = Math.max(0, this.selectedIdx - 1);
      this.render();
      return;
    }
    if (key.name === 'down') {
      this.selectedIdx = Math.min(this.filtered.length - 1, this.selectedIdx + 1);
      this.render();
      return;
    }
    if (key.name === 'backspace') {
      this.query = this.query.slice(0, -1);
      this.applyFilter();
      this.render();
      return;
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && key.name !== 'tab') {
      this.query += key.sequence;
      this.applyFilter();
      this.render();
    }
  }

  private applyFilter(): void {
    const q = this.query.trim().toLowerCase();
    if (!q) {
      this.filtered = [...this.sessions];
    } else {
      this.filtered = this.sessions
        .map((s) => ({
          session: s,
          score: Math.max(fuzzyScore(q, s.id), fuzzyScore(q, s.preview)),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.session);
    }
    this.selectedIdx = Math.min(this.selectedIdx, Math.max(0, this.filtered.length - 1));
  }

  private buildLines(): string[] {
    const width = Math.min(this.colCount, 100);
    const maxTotal = Math.max(5, this.rowCount - 1);
    const headerLines = 3;
    const maxSessions = Math.max(1, maxTotal - headerLines);

    const lines: string[] = [];
    lines.push(headerBg(' Resume chat session '.padEnd(width - 2)));
    lines.push(muted(`  Filter: ${this.query || '(type to filter)'}  │  n=new  Esc=cancel`));
    lines.push('');

    const maxRows = Math.min(this.filtered.length, maxSessions);
    let start = 0;
    if (this.selectedIdx >= maxRows) {
      start = this.selectedIdx - maxRows + 1;
    }
    const end = Math.min(this.filtered.length, start + maxRows);

    for (let i = start; i < end; i++) {
      const s = this.filtered[i]!;
      const selected = i === this.selectedIdx;
      const marker = selected ? accentBright('›') : ' ';
      const id = primary(s.id.slice(0, 28).padEnd(28));
      const meta = muted(`${s.turnCount} msgs`);
      const preview = dim(s.preview.slice(0, width - 40));
      lines.push(`${marker} ${id} ${meta}  ${preview}`);
    }

    if (this.filtered.length === 0) {
      lines.push(muted('  No sessions match filter.'));
    } else if (this.filtered.length > maxRows) {
      lines.push(muted(`  … ${this.filtered.length - maxRows} more (type to filter)`));
    }

    return lines.slice(0, maxTotal);
  }

  private render(): void {
    const lines = this.buildLines();
    const parts: string[] = [];

    if (this.lastPaintedRows > 0) {
      parts.push(`\x1b[${this.lastPaintedRows}A`);
    }
    for (const line of lines) {
      parts.push(`\r\x1b[2K${line}\n`);
    }
    const leftover = this.lastPaintedRows - lines.length;
    for (let i = 0; i < leftover; i++) {
      parts.push('\r\x1b[2K\n');
    }
    if (leftover > 0) {
      parts.push(`\x1b[${leftover}A`);
    }

    OutputBuffer.getInstance().writeControl(parts.join(''));
    this.lastPaintedRows = lines.length;
  }

  private erasePaintedRegion(): void {
    if (this.lastPaintedRows <= 0) return;
    const parts: string[] = [];
    parts.push(`\x1b[${this.lastPaintedRows}A`);
    for (let i = 0; i < this.lastPaintedRows; i++) {
      parts.push('\r\x1b[2K\n');
    }
    parts.push(`\x1b[${this.lastPaintedRows}A`);
    OutputBuffer.getInstance().writeControl(parts.join(''));
    this.lastPaintedRows = 0;
  }

  private unmount(result: SessionPickerResult): void {
    if (this.settled) return;
    this.settled = true;

    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];

    this.erasePaintedRegion();
    OutputBuffer.getInstance().writeControl('\x1b[?25h');

    const stdin = process.stdin;
    if (stdin.isTTY) {
      try {
        if (stdin.isRaw !== this.wasRaw) {
          stdin.setRawMode(this.wasRaw);
        }
      } catch {
        /* ignore */
      }
      if (this.wasPaused) {
        stdin.pause();
      } else {
        stdin.resume();
      }
    }

    this.resolve(result);
  }
}
