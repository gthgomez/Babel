/**
 * Full-screen command palette overlay for Babel TUI.
 *
 * Triggered by `/palette` or Ctrl+P. Shows a searchable, categorized list of
 * all interactive commands from INTERACTIVE_COMMAND_GROUPS. The user filters
 * by typing, navigates with arrow keys, and presses Enter to inject the
 * selected command into the readline input.
 *
 * Extends Component for lifecycle (mount/unmount), dirty tracking, and
 * focus management. Routes all output through OutputBuffer for DEC 2026
 * synchronized update support.
 *
 * Architecture follows the PagerOverlay pattern: alternate-screen buffer,
 * raw-mode stdin, parsed key events, OutputBuffer-positioned rendering.
 *
 * @module palette
 */

import process from 'node:process';
import { Component } from './component.js';
import { INTERACTIVE_COMMAND_GROUPS } from '../interactive/types.js';
import { parseKeypress, type KeyEvent } from './keyInput.js';
import { stripAnsi, headerBg, bgPanel } from './theme.js';
import { OutputBuffer } from './outputBuffer.js';
import type { ReplContext } from '../interactive/context.js';
import { fuzzyScore } from '../utils/fuzzy.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CommandEntry {
  command: string;
  description: string;
  group: string;
}

interface GroupedResult {
  group: string;
  commands: CommandEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MIN_ROWS = 6;

// ─── Fuzzy Scoring ──────────────────────────────────────────────────────────

// Re-exported for backward compatibility — canonical source is ../utils/fuzzy.js
export { fuzzyScore } from '../utils/fuzzy.js';

// ─── CommandPalette ─────────────────────────────────────────────────────────

export class CommandPalette extends Component {
  /**
   * Open the command palette overlay.
   * Returns when the user selects a command or dismisses (Esc / Ctrl+C).
   * Restores terminal state exactly on exit.
   */
  static async show(ctx: ReplContext): Promise<void> {
    const palette = new CommandPalette(ctx);
    await palette.run();
  }

  private query = '';
  private selectedIdx = 0;
  private allCommands: CommandEntry[];
  private filtered: GroupedResult[] = [];
  private flatFiltered: CommandEntry[] = [];
  private rowCount = 24;
  private colCount = 80;
  private cleanupFns: Array<() => void> = [];
  private wasRaw = false;

  /** Fulfilled when the user selects a command or dismisses the palette. */
  private resolve!: () => void;

  constructor(private ctx: ReplContext) {
    super();
    // Build a flat command list from the grouped constant
    this.allCommands = INTERACTIVE_COMMAND_GROUPS.flatMap((g) =>
      g.commands.map(([cmd, desc]) => ({
        command: cmd,
        description: desc,
        group: g.title,
      })),
    );
    this.updateDimensions();
    this.filter();
  }

  /** Refresh terminal dimensions. Called on init and resize. */
  private updateDimensions(): void {
    this.rowCount = Math.max(MIN_ROWS, process.stdout.rows || 24);
    this.colCount = process.stdout.columns || 80;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  override onMount(): void {
    const stdin = process.stdin;
    this.wasRaw = stdin.isRaw ?? false;

    const buf = OutputBuffer.getInstance();
    buf.write('\x1b[?1049h\x1b[?25l');

    stdin.setRawMode(true);

    const onResize = (): void => {
      this.updateDimensions();
      this.markDirty();
      this.renderToScreen();
    };
    process.stdout.on('resize', onResize);
    this.cleanupFns.push(() => process.stdout.off('resize', onResize));
  }

  override onUnmount(): void {
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];

    const buf = OutputBuffer.getInstance();
    buf.write('\x1b[?25h\x1b[?1049l');

    const stdin = process.stdin;
    if (stdin.isTTY) {
      try {
        if (stdin.isRaw !== this.wasRaw) {
          stdin.setRawMode(this.wasRaw);
        }
      } catch {
        /* ignore */
      }
    }
  }

  // ── Component overrides ────────────────────────────────────────────────────

  override render(): string {
    return `[CommandPalette: query="${this.query}" ${this.flatFiltered.length} results]`;
  }

  override handleKey(_event: KeyEvent): boolean {
    return false; // handled via raw-mode Buffer listener
  }

  // ── Run loop ───────────────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const stdin = process.stdin;

    this.mounted = true;
    this.onMount();

    try {
      await new Promise<void>((resolve) => {
        this.resolve = resolve;
        const onData = (data: Buffer): void => {
          this.handleData(data);
        };
        stdin.on('data', onData);
        this.cleanupFns.push(() => stdin.off('data', onData));
        this.renderToScreen();
      });
    } finally {
      this.mounted = false;
      this.onUnmount();
    }
  }

  // ── Filtering ────────────────────────────────────────────────────────────

  /**
   * Recompute the filtered command list based on the current query.
   *
   * - Empty query: show all commands in their original group order.
   * - Non-empty query: fuzzy-score each command (checks both the command
   *   string and the description), sort by score descending, group.
   */
  private filter(): void {
    if (!this.query) {
      this.filtered = this.groupByCategory(this.allCommands);
      this.flatFiltered = [...this.allCommands];
      return;
    }

    const scored: Array<{ entry: CommandEntry; score: number }> = [];

    for (const entry of this.allCommands) {
      const cmdScore = fuzzyScore(this.query, entry.command);
      const descScore = fuzzyScore(this.query, entry.description);
      const combined = Math.max(cmdScore, descScore);
      if (combined > 0) {
        scored.push({ entry, score: combined });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    this.flatFiltered = scored.map((s) => s.entry);
    this.filtered = this.groupByCategory(this.flatFiltered);
  }

  /**
   * Partition entries by their `group` field, preserving the original group
   * order from INTERACTIVE_COMMAND_GROUPS (empty groups are omitted).
   */
  private groupByCategory(entries: CommandEntry[]): GroupedResult[] {
    const byGroup = new Map<string, CommandEntry[]>();
    for (const entry of entries) {
      const list = byGroup.get(entry.group);
      if (list) {
        list.push(entry);
      } else {
        byGroup.set(entry.group, [entry]);
      }
    }

    const result: GroupedResult[] = [];
    for (const g of INTERACTIVE_COMMAND_GROUPS) {
      const cmds = byGroup.get(g.title);
      if (cmds && cmds.length > 0) {
        result.push({ group: g.title, commands: cmds });
      }
    }
    return result;
  }

  // ── Data Handling ────────────────────────────────────────────────────────

  private handleData(data: Buffer): void {
    const event = parseKeypress(data);
    if (event === null) return;
    this.handleKeyEvent(event);
  }

  private handleKeyEvent(event: KeyEvent): void {
    const { name, ctrl, meta, sequence } = event;

    // Ctrl+C: cancel
    if (name === 'c' && ctrl) {
      this.resolve();
      return;
    }

    // Escape: cancel
    if (name === 'escape') {
      this.resolve();
      return;
    }

    // Enter: select the currently highlighted command
    if (name === 'enter') {
      if (this.flatFiltered.length > 0) {
        this.selectAndExit();
      }
      return;
    }

    // Arrow navigation
    if (name === 'up' && !ctrl && !meta) {
      if (this.flatFiltered.length > 0) {
        this.selectedIdx = Math.max(0, this.selectedIdx - 1);
      }
      this.renderToScreen();
      return;
    }

    if (name === 'down' && !ctrl && !meta) {
      if (this.flatFiltered.length > 0) {
        this.selectedIdx = Math.min(this.flatFiltered.length - 1, this.selectedIdx + 1);
      }
      this.renderToScreen();
      return;
    }

    // Backspace: remove last character
    if (name === 'backspace') {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selectedIdx = 0;
        this.filter();
      }
      this.renderToScreen();
      return;
    }

    // Ctrl+U: clear the entire query
    if (name === 'u' && ctrl) {
      if (this.query.length > 0) {
        this.query = '';
        this.selectedIdx = 0;
        this.filter();
        this.renderToScreen();
      }
      return;
    }

    // Printable characters
    if (sequence && sequence.length === 1 && sequence >= ' ' && !ctrl && !meta) {
      this.query += sequence;
      this.selectedIdx = 0;
      this.filter();
      this.renderToScreen();
      return;
    }

    // Ignore all other keys (Ctrl combos besides C/U, mouse sequences, etc.)
  }

  // ── Selection & Execution ────────────────────────────────────────────────

  /**
   * Inject the currently selected command into the readline input and exit.
   *
   * Writes the base command (e.g. "/mode" from "/mode [name]") followed by
   * a space so the user can type arguments. The terminal is restored by the
   * `finally` block in `run()` after the promise resolves.
   */
  private selectAndExit(): void {
    const selected = this.flatFiltered[this.selectedIdx];
    if (!selected) {
      this.resolve();
      return;
    }

    // Extract the base command (everything before the first space)
    const baseCommand = selected.command.split(' ')[0] ?? selected.command;

    // Write to readline input — this works because cleanup hasn't run yet
    // (resolve only schedules the microtask that resumes `run()`).
    this.ctx.rl.write(baseCommand + ' ');

    this.resolve();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /**
   * Full redraw: search bar, grouped results, footer, and cursor positioning.
   * Called after every state change (query update, navigation, resize).
   */
  renderToScreen(): void {
    const rows = this.rowCount;
    const cols = this.colCount;

    const buf = OutputBuffer.getInstance();
    const useSync = OutputBuffer.supportsSyncUpdate();
    if (useSync) buf.beginFrame();
    try {
      // Clear screen and home cursor
      buf.write('\x1b[2J\x1b[H');

      // ── Search bar (row 1) ──────────────────────────────────────────────
      const searchContent = this.query
        ? `  › ${this.query}█` // "  › query█"
        : '  › type to filter commands█';
      const searchLine = this.padLineToCols(searchContent, cols);
      buf.writeLine(1, 1, headerBg(searchLine));

      // ── Results area (row 2 … rows-1) ───────────────────────────────────
      const availableRows = rows - 2; // reserve search bar + footer
      let row = 2;
      let flatIdx = 0;

      if (this.flatFiltered.length === 0 && this.query) {
        // No results for the current query
        buf.writeLine(row, 1, '  \x1b[2mNo matching commands\x1b[0m');
        row++;
      } else {
        for (const group of this.filtered) {
          if (row > rows) break;

          // Group header
          const headerLine = this.padLineToCols(`  \x1b[90m${group.group}\x1b[0m`, cols);
          buf.writeLine(row, 1, headerLine);
          row++;

          for (const cmd of group.commands) {
            if (row >= rows) break;

            const isSelected = flatIdx === this.selectedIdx;
            let line: string;

            if (isSelected) {
              // Highlighted selection: reverse video on the full line
              const cmdPart = `    ${cmd.command}`;
              const descPart = `  ${cmd.description}`;
              const plainLine = `${cmdPart}${descPart}`;
              line = this.padLineToCols(bgPanel(plainLine), cols);
            } else {
              // Normal: command name in default, description in dim
              line = this.padLineToCols(
                `    ${cmd.command}  \x1b[2m${cmd.description}\x1b[0m`,
                cols,
              );
            }

            buf.writeLine(row, 1, line);
            row++;
            flatIdx++;
          }
        }
      }

      // Clear any unused result lines
      while (row < rows) {
        buf.writeLine(row, 1, '');
        row++;
      }

      // ── Footer (last row) ───────────────────────────────────────────────
      const footerText = ' ⏎ Enter: execute  Esc: cancel  ↑↓: navigate  type to filter ';
      const footerLine =
        footerText.length <= cols
          ? footerText + ' '.repeat(cols - footerText.length)
          : footerText.slice(0, cols);
      buf.writeLine(rows, 1, headerBg(footerLine));

      // ── Position cursor at the end of the search bar text ───────────────
      const cursorCol = this.query ? Math.min(cols, 3 + this.query.length + 1) : Math.min(cols, 29);
      buf.moveCursor(1, cursorCol);
    } finally {
      if (useSync) buf.endFrame();
    }
  }

  /**
   * Pad `content` with trailing spaces so the visible (non-ANSI) width
   * equals `cols`. The content is not truncated — only padded.
   */
  private padLineToCols(content: string, cols: number): string {
    const visibleLen = stripAnsi(content).length;
    if (visibleLen >= cols) return content;
    return content + ' '.repeat(cols - visibleLen);
  }
}
