/**
 * Side-by-side diff view component for Babel's TUI.
 *
 * Parses unified diff output and renders left (old) / right (new) panels
 * using Box primitives, with color-coded additions, removals, and context.
 *
 * Usage:
 *   const view = new DiffView({ diff: rawUnifiedDiff, width: 120 });
 *   const output = view.render();
 *
 * @module diffView
 */

import { Component } from './component.js';
import { Box, Text } from './primitives.js';
import {
  dim,
  success,
  error,
  accent,
  muted,
  bold,
  getEffectiveTerminalWidth,
  truncate,
  visibleLength,
} from './theme.js';
import type { KeyEvent } from './keyInput.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiffViewOptions {
  /** Raw unified diff text */
  diff: string;
  /** Total width available (default: terminal width) */
  width?: number;
  /** Maximum number of lines to display (default: unlimited) */
  maxLines?: number;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk';
  leftNum: number | null;
  rightNum: number | null;
  content: string;
}

// ─── Diff Parser ────────────────────────────────────────────────────────────

function parseUnifiedDiff(raw: string, maxLines: number = Infinity): DiffLine[] {
  const lines: DiffLine[] = [];
  let leftNum = 0;
  let rightNum = 0;

  const inputLines = raw.split('\n');
  const displayLines = inputLines.slice(0, maxLines);

  for (const line of displayLines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      lines.push({ type: 'header', leftNum: null, rightNum: null, content: line });
    } else if (line.startsWith('@@')) {
      // Parse hunk header: @@ -oldStart[,oldCount] +newStart[,newCount] @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        leftNum = Number(match[1]) - 1;
        rightNum = Number(match[2]) - 1;
      }
      lines.push({ type: 'hunk', leftNum: null, rightNum: null, content: line });
    } else if (line.startsWith('+')) {
      rightNum++;
      lines.push({ type: 'add', leftNum: null, rightNum, content: line.slice(1) });
    } else if (line.startsWith('-')) {
      leftNum++;
      lines.push({ type: 'remove', leftNum, rightNum: null, content: line.slice(1) });
    } else if (line.startsWith(' ')) {
      leftNum++;
      rightNum++;
      lines.push({ type: 'context', leftNum, rightNum, content: line.slice(1) });
    }
    // Other lines (empty, binary indicator, etc.) are skipped
  }

  if (inputLines.length > maxLines) {
    lines.push({
      type: 'context',
      leftNum: null,
      rightNum: null,
      content: `... (${inputLines.length - maxLines} more lines)`,
    });
  }

  return lines;
}

// ─── DiffView Component ─────────────────────────────────────────────────────

export class DiffView extends Component {
  private diff: string;
  private viewWidth: number;
  private maxLines: number;

  constructor(options: DiffViewOptions) {
    super();
    this.diff = options.diff;
    this.viewWidth = options.width ?? getEffectiveTerminalWidth();
    this.maxLines = options.maxLines ?? Infinity;
  }

  override handleKey(_event: KeyEvent): boolean {
    return false; // Read-only view
  }

  override render(): string {
    const parsed = parseUnifiedDiff(this.diff, this.maxLines);
    if (parsed.length === 0) return '(empty diff)';

    // Calculate panel widths: each panel gets ~half the available width,
    // minus 1 for the center gutter and 2 for outer padding.
    const gutterWidth = 1;
    const available = this.viewWidth - 2; // 1-char outer padding each side
    const panelWidth = Math.max(20, Math.floor((available - gutterWidth) / 2));
    const gutterNumWidth = Math.min(4, Math.floor(panelWidth / 8));

    const leftLines: string[] = [];
    const rightLines: string[] = [];

    for (const entry of parsed) {
      if (entry.type === 'header' || entry.type === 'hunk') {
        // Span both panels: center the header across the full width
        const headerLine = muted(entry.content);
        const padded = ' '.repeat(Math.max(0, available - visibleLength(headerLine)));
        leftLines.push(headerLine + padded);
        rightLines.push('');
      } else {
        // Build line number prefix (4 chars right-aligned, or empty if no number)
        const fmtNum = (n: number | null): string => {
          if (n === null) return ' '.repeat(gutterNumWidth) + ' ';
          return dim(String(n).padStart(gutterNumWidth)) + ' ';
        };

        const leftContent = truncate(entry.content, panelWidth - gutterNumWidth - 1);
        const rightContent = truncate(entry.content, panelWidth - gutterNumWidth - 1);

        let leftLine: string;
        let rightLine: string;

        switch (entry.type) {
          case 'add':
            // Added line: shows on right panel only
            leftLine = fmtNum(null) + ' '.repeat(panelWidth - gutterNumWidth - 1);
            rightLine = fmtNum(entry.rightNum) + success(rightContent);
            break;
          case 'remove':
            // Removed line: shows on left panel only
            leftLine = fmtNum(entry.leftNum) + error(leftContent);
            rightLine = fmtNum(null) + ' '.repeat(panelWidth - gutterNumWidth - 1);
            break;
          case 'context':
            // Context line: shows on both panels
            leftLine = fmtNum(entry.leftNum) + dim(leftContent);
            rightLine = fmtNum(entry.rightNum) + dim(rightContent);
            break;
          default:
            leftLine = '';
            rightLine = '';
        }

        // Pad each panel line to its exact width
        leftLine = leftLine.padEnd(panelWidth);
        rightLine = rightLine.padEnd(panelWidth);

        leftLines.push(leftLine);
        rightLines.push(rightLine);
      }
    }

    // Interleave: each output line is leftPanel | rightPanel
    const outputLines: string[] = [];
    for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
      const left = leftLines[i] ?? '';
      const right = rightLines[i] ?? '';
      const gutter = i === 0 ? dim('│') : dim('│');
      // Only show gutter when both sides have content
      const showGutter = left.trim().length > 0 || right.trim().length > 0;
      if (showGutter) {
        outputLines.push(` ${left}${gutter}${right}`);
      } else {
        outputLines.push(` ${left}`);
      }
    }

    // Wrap in a single columnar box for consistent border
    const box = new Box({
      padding: { top: 0, right: 1, bottom: 0, left: 0 },
      width: this.viewWidth,
      children: outputLines,
    });

    return box.render();
  }

  /** Static convenience: render a diff for display. */
  static render(options: DiffViewOptions): string {
    const view = new DiffView(options);
    return view.render();
  }
}
