/**
 * Normal-mode key handling for PromptInput (extracted for file-size ratchet).
 * G2 operator/motion/text-object path lives here + vimEngine.
 *
 * @module promptInputNormalMode
 */

import type { KeyEvent } from './keyInput.js';
import {
  feedVimKey,
  applyMotion,
  applyOperatorMotion,
  applyOperatorTextObject,
  applyLinewiseOperator,
  type PendingKind,
} from './vimEngine.js';

/** Minimal mutable surface PromptInput exposes to normal-mode handling. */
export interface NormalModeHost {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  killBuffer: string;
  mode: 'insert' | 'normal' | 'visual';
  vimPending: string | null;
  vimOpPending: PendingKind;
  visualStart: { line: number; col: number } | null;
  visualMode: 'char' | 'line' | null;
  marks: Map<string, { line: number; col: number }>;
  lastChange: { type: string; text?: string; shift?: boolean } | null;
  insertEntryType: string | null;
  insertSessionText: string;
  snapshot(): void;
  render(): void;
  redo(): void;
  undo(): void;
  handleDotRepeat(): void;
  deleteForward(): void;
  insertText(text: string): void;
}

/**
 * Handle one key event in normal mode. Mutates host state.
 */
export function handleNormalModeKey(host: NormalModeHost, event: KeyEvent): void {
  if (event.name === 'r' && event.ctrl) {
    host.redo();
    host.render();
    return;
  }

  // Marks (m / ' / `)
  if (host.vimPending) {
    const pending = host.vimPending;
    host.vimPending = null;
    if (pending === 'm' && event.name.length === 1 && event.name >= 'a' && event.name <= 'z') {
      const markName = event.shift ? event.name.toUpperCase() : event.name;
      host.marks.set(markName, { line: host.cursorLine, col: host.cursorCol });
      host.render();
      return;
    }
    if (
      (pending === "'" || pending === '`') &&
      event.name.length === 1 &&
      event.name >= 'a' &&
      event.name <= 'z' &&
      !event.shift
    ) {
      const mark = host.marks.get(event.name);
      if (mark) {
        host.cursorLine = mark.line;
        host.cursorCol =
          pending === '`'
            ? Math.min(mark.col, (host.lines[mark.line] ?? '').length)
            : Math.min(host.cursorCol, (host.lines[mark.line] ?? '').length);
      }
      host.render();
      return;
    }
  }

  // G2 — operator + motion + text-object + count
  if (!event.ctrl && !event.meta) {
    const step = feedVimKey(host.vimOpPending, event.name, { shift: event.shift });
    host.vimOpPending = step.pending;

    if (step.op) {
      const state = {
        lines: host.lines,
        cursor: { line: host.cursorLine, col: host.cursorCol },
      };
      const result =
        step.op.linewiseCount !== undefined
          ? applyLinewiseOperator(state, step.op.op, step.op.linewiseCount)
          : step.op.textObject
            ? applyOperatorTextObject(state, step.op.op, step.op.textObject)
            : step.op.motion
              ? applyOperatorMotion(state, step.op.op, step.op.motion)
              : null;
      if (result) {
        if (step.op.op !== 'y') host.snapshot();
        host.lines = result.lines;
        host.cursorLine = result.cursor.line;
        host.cursorCol = result.cursor.col;
        host.killBuffer = result.yanked;
        host.lastChange = { type: `op-${step.op.op}` };
        if (result.enterInsert) {
          host.mode = 'insert';
          host.insertEntryType = 'c';
          host.insertSessionText = '';
        }
      }
      host.render();
      return;
    }

    if (step.motion) {
      const pos = applyMotion(
        host.lines,
        { line: host.cursorLine, col: host.cursorCol },
        step.motion,
      );
      host.cursorLine = pos.line;
      host.cursorCol = pos.col;
      host.render();
      return;
    }

    if (step.handled && step.pending.type !== 'none') {
      host.render();
      return;
    }
  }

  switch (event.name) {
    case 'v':
      if (!event.shift) {
        host.visualStart = { line: host.cursorLine, col: host.cursorCol };
        host.visualMode = 'char';
        host.mode = 'visual';
        host.vimOpPending = { type: 'none' };
      }
      host.render();
      break;
    case 'V':
      if (event.shift) {
        host.visualStart = { line: host.cursorLine, col: 0 };
        host.visualMode = 'line';
        host.mode = 'visual';
        host.vimOpPending = { type: 'none' };
      }
      host.render();
      break;
    case 'i':
      if (host.vimOpPending.type === 'none') {
        if (event.shift) host.cursorCol = 0;
        host.mode = 'insert';
        host.insertEntryType = event.shift ? 'I' : 'i';
        host.insertSessionText = '';
      }
      host.render();
      break;
    case 'a':
      if (host.vimOpPending.type === 'none') {
        host.mode = 'insert';
        if (event.shift) {
          host.insertEntryType = 'A';
          host.cursorCol = (host.lines[host.cursorLine] ?? '').length;
        } else {
          host.insertEntryType = 'a';
          if (host.cursorCol < (host.lines[host.cursorLine] ?? '').length) host.cursorCol++;
        }
        host.insertSessionText = '';
      }
      host.render();
      break;
    case 'x':
      if (!event.shift) {
        host.snapshot();
        host.lastChange = { type: 'x' };
        host.killBuffer = host.lines[host.cursorLine]?.[host.cursorCol] ?? '';
        host.deleteForward();
      }
      host.render();
      break;
    case 'u':
      host.undo();
      host.render();
      break;
    case '.':
      host.handleDotRepeat();
      host.render();
      break;
    case 'd':
      if (event.shift) {
        host.snapshot();
        const dl = host.lines[host.cursorLine] ?? '';
        host.killBuffer = dl.slice(host.cursorCol);
        host.lines[host.cursorLine] = dl.slice(0, host.cursorCol);
        host.lastChange = { type: 'D' };
        host.render();
      }
      break;
    case 'c':
      if (event.shift) {
        host.snapshot();
        const cl = host.lines[host.cursorLine] ?? '';
        host.killBuffer = cl.slice(host.cursorCol);
        host.lines[host.cursorLine] = cl.slice(0, host.cursorCol);
        host.mode = 'insert';
        host.insertEntryType = 'C';
        host.insertSessionText = '';
        host.render();
      }
      break;
    case 'p':
      if (host.killBuffer) {
        if (event.shift) {
          host.snapshot();
          const pl = host.lines[host.cursorLine] ?? '';
          host.lines[host.cursorLine] =
            pl.slice(0, host.cursorCol) + host.killBuffer + pl.slice(host.cursorCol);
          host.cursorCol += host.killBuffer.length;
          host.lastChange = { type: 'p', shift: true };
        } else {
          host.snapshot();
          host.insertText(host.killBuffer);
          host.lastChange = { type: 'p' };
        }
      }
      host.render();
      break;
    case 'm':
      if (!event.shift) host.vimPending = 'm';
      host.render();
      break;
    case "'":
      host.vimPending = "'";
      host.render();
      break;
    case '`':
      host.vimPending = '`';
      host.render();
      break;
    case 'o':
      host.snapshot();
      host.insertEntryType = event.shift ? 'O' : 'o';
      host.insertSessionText = '';
      if (event.shift) host.lines.splice(host.cursorLine, 0, '');
      else {
        host.lines.splice(host.cursorLine + 1, 0, '');
        host.cursorLine++;
      }
      host.cursorCol = 0;
      host.mode = 'insert';
      host.vimOpPending = { type: 'none' };
      host.render();
      break;
  }
}
