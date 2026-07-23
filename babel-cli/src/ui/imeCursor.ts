/**
 * IME composition cursor parking (G6).
 *
 * Computes the absolute terminal (row, col) for the PromptInput caret so the
 * OS IME candidate window / screen-reader cursor aligns with the text caret.
 *
 * Layout model matches PromptInput.render():
 *   textStart row = startRow + queuedLines + slashPopupLines
 *   caret row     = textStart + cursorLine
 *   caret col     = 1 + visibleLength(prefix) + cursorCol  (prefix is prompt
 *                   or continuationPrompt)
 *
 * @module imeCursor
 */

import { visibleLength } from './theme.js';

export interface ImeCursorLayout {
  /** First row of the prompt input area (1-based). */
  startRow: number;
  queuedLines: number;
  slashPopupLines: number;
  cursorLine: number;
  cursorCol: number;
  prompt: string;
  continuationPrompt: string;
  /** Terminal rows (for clamping). */
  termRows: number;
  termCols: number;
}

export interface TerminalCursorPos {
  /** 1-based row */
  row: number;
  /** 1-based column */
  col: number;
}

/**
 * Compute 1-based terminal coordinates for the input caret.
 */
export function computeImeCursorPos(layout: ImeCursorLayout): TerminalCursorPos {
  const textStart = layout.startRow + layout.queuedLines + layout.slashPopupLines;
  const row = Math.min(
    layout.termRows,
    Math.max(1, textStart + layout.cursorLine),
  );
  const prefix =
    layout.cursorLine === 0 ? layout.prompt : layout.continuationPrompt;
  const col = Math.min(
    layout.termCols,
    Math.max(1, 1 + visibleLength(prefix) + layout.cursorCol),
  );
  return { row, col };
}

/**
 * CSI CUP sequence to park the hardware cursor at (row, col).
 */
export function cupSequence(pos: TerminalCursorPos): string {
  return `\x1b[${pos.row};${pos.col}H`;
}

/**
 * Whether IME cursor parking should run.
 * Enabled when composing, or when BABEL_IME_CURSOR=1 / BABEL_A11Y=1.
 */
export function shouldParkImeCursor(isComposing: boolean): boolean {
  if (isComposing) return true;
  if (process.env['BABEL_IME_CURSOR'] === '1') return true;
  if (process.env['BABEL_A11Y'] === '1') return true;
  return false;
}
