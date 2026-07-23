/**
 * vimEngine — pure operator + motion + text-object engine for PromptInput (G2).
 *
 * Stateless helpers over a multi-line buffer. PromptInput owns mode/undo/render;
 * this module computes ranges and applies delete/change/yank operations.
 *
 * Supported (v1):
 *   - Counts: `3w`, `2dw`, `5x` (prefix digits before operator/motion)
 *   - Operators: d, c, y  (delete / change / yank)
 *   - Motions: h l j k w b e 0 $ f{c} t{c}
 *   - Text objects: iw aw i( a( i[ a[ i{ a{ i" a" i' a' i` a`
 *
 * @module vimEngine
 */

export interface BufferPos {
  line: number;
  col: number;
}

export interface BufferRange {
  start: BufferPos;
  end: BufferPos; // exclusive end (like JS slice)
}

export interface BufferState {
  lines: string[];
  cursor: BufferPos;
}

export type VimOperator = 'd' | 'c' | 'y';

export type MotionKind =
  | 'h'
  | 'l'
  | 'j'
  | 'k'
  | 'w'
  | 'b'
  | 'e'
  | '0'
  | '$'
  | 'f'
  | 't'
  | 'G'
  | 'gg';

export type TextObjectKind =
  | 'iw'
  | 'aw'
  | 'i('
  | 'a('
  | 'i['
  | 'a['
  | 'i{'
  | 'a{'
  | 'i"'
  | 'a"'
  | "i'"
  | "a'"
  | 'i`'
  | 'a`';

export interface MotionSpec {
  kind: MotionKind;
  /** For f/t motions — target character */
  char?: string;
  count: number;
}

export interface OpResult {
  lines: string[];
  cursor: BufferPos;
  /** Yanked/deleted text (for kill buffer) */
  yanked: string;
  /** Whether operator enters insert mode (c) */
  enterInsert: boolean;
}

// ─── Position helpers ────────────────────────────────────────────────────────

function clampPos(lines: string[], pos: BufferPos): BufferPos {
  const line = Math.max(0, Math.min(pos.line, lines.length - 1));
  const col = Math.max(0, Math.min(pos.col, (lines[line] ?? '').length));
  return { line, col };
}

function lineLen(lines: string[], line: number): number {
  return (lines[line] ?? '').length;
}

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_]/.test(ch);
}

function comparePos(a: BufferPos, b: BufferPos): number {
  if (a.line !== b.line) return a.line - b.line;
  return a.col - b.col;
}

function normalizeRange(a: BufferPos, b: BufferPos): BufferRange {
  return comparePos(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
}

// ─── Motions ─────────────────────────────────────────────────────────────────

/** Apply a motion `count` times from cursor; returns exclusive end for operators. */
export function applyMotion(lines: string[], cursor: BufferPos, motion: MotionSpec): BufferPos {
  let pos = clampPos(lines, cursor);
  const count = Math.max(1, motion.count);

  for (let n = 0; n < count; n++) {
    pos = applyMotionOnce(lines, pos, motion);
  }
  return clampPos(lines, pos);
}

function applyMotionOnce(lines: string[], cursor: BufferPos, motion: MotionSpec): BufferPos {
  const line = lines[cursor.line] ?? '';
  switch (motion.kind) {
    case 'h':
      if (cursor.col > 0) return { line: cursor.line, col: cursor.col - 1 };
      if (cursor.line > 0) {
        return { line: cursor.line - 1, col: lineLen(lines, cursor.line - 1) };
      }
      return cursor;
    case 'l':
      if (cursor.col < line.length) return { line: cursor.line, col: cursor.col + 1 };
      if (cursor.line < lines.length - 1) return { line: cursor.line + 1, col: 0 };
      return cursor;
    case 'j':
      if (cursor.line < lines.length - 1) {
        return {
          line: cursor.line + 1,
          col: Math.min(cursor.col, lineLen(lines, cursor.line + 1)),
        };
      }
      return cursor;
    case 'k':
      if (cursor.line > 0) {
        return {
          line: cursor.line - 1,
          col: Math.min(cursor.col, lineLen(lines, cursor.line - 1)),
        };
      }
      return cursor;
    case '0':
      return { line: cursor.line, col: 0 };
    case '$':
      return { line: cursor.line, col: line.length };
    case 'w':
      return motionWordForward(lines, cursor);
    case 'b':
      return motionWordBackward(lines, cursor);
    case 'e':
      return motionWordEnd(lines, cursor);
    case 'f':
      return findChar(lines, cursor, motion.char ?? '', /*till*/ false, /*forward*/ true);
    case 't':
      return findChar(lines, cursor, motion.char ?? '', /*till*/ true, /*forward*/ true);
    case 'G':
      return { line: lines.length - 1, col: 0 };
    case 'gg':
      return { line: 0, col: 0 };
    default:
      return cursor;
  }
}

function motionWordForward(lines: string[], cursor: BufferPos): BufferPos {
  let { line, col } = cursor;
  let text = lines[line] ?? '';
  if (col >= text.length) {
    if (line < lines.length - 1) return { line: line + 1, col: 0 };
    return cursor;
  }
  // Skip current word
  if (isWordChar(text[col])) {
    while (col < text.length && isWordChar(text[col])) col++;
  } else if (text[col] !== ' ' && text[col] !== undefined) {
    while (col < text.length && !isWordChar(text[col]) && text[col] !== ' ') col++;
  }
  // Skip whitespace
  while (col < text.length && text[col] === ' ') col++;
  if (col >= text.length && line < lines.length - 1) {
    return { line: line + 1, col: 0 };
  }
  return { line, col };
}

function motionWordBackward(lines: string[], cursor: BufferPos): BufferPos {
  let { line, col } = cursor;
  if (col === 0) {
    if (line > 0) return { line: line - 1, col: lineLen(lines, line - 1) };
    return cursor;
  }
  let text = lines[line] ?? '';
  col = Math.min(col, text.length);
  col--;
  // Skip whitespace
  while (col > 0 && text[col] === ' ') col--;
  if (isWordChar(text[col])) {
    while (col > 0 && isWordChar(text[col - 1])) col--;
  } else {
    while (col > 0 && !isWordChar(text[col - 1]) && text[col - 1] !== ' ') col--;
  }
  return { line, col };
}

function motionWordEnd(lines: string[], cursor: BufferPos): BufferPos {
  let { line, col } = cursor;
  let text = lines[line] ?? '';
  // Move at least one char forward if not at end
  if (col < text.length) col++;
  // Skip whitespace
  while (col < text.length && text[col] === ' ') col++;
  if (col >= text.length) {
    if (line < lines.length - 1) {
      return motionWordEnd(lines, { line: line + 1, col: 0 });
    }
    return { line, col: Math.max(0, text.length - 1) };
  }
  // To end of word
  if (isWordChar(text[col])) {
    while (col < text.length - 1 && isWordChar(text[col + 1])) col++;
  } else {
    while (col < text.length - 1 && !isWordChar(text[col + 1]) && text[col + 1] !== ' ') col++;
  }
  return { line, col };
}

function findChar(
  lines: string[],
  cursor: BufferPos,
  ch: string,
  till: boolean,
  forward: boolean,
): BufferPos {
  if (!ch) return cursor;
  const text = lines[cursor.line] ?? '';
  if (forward) {
    const idx = text.indexOf(ch, cursor.col + 1);
    if (idx < 0) return cursor;
    return { line: cursor.line, col: till ? Math.max(cursor.col, idx - 1) : idx };
  }
  const idx = text.lastIndexOf(ch, cursor.col - 1);
  if (idx < 0) return cursor;
  return { line: cursor.line, col: till ? Math.min(cursor.col, idx + 1) : idx };
}

// ─── Text objects ────────────────────────────────────────────────────────────

const PAIR_MAP: Record<string, { open: string; close: string }> = {
  '(': { open: '(', close: ')' },
  ')': { open: '(', close: ')' },
  b: { open: '(', close: ')' },
  '[': { open: '[', close: ']' },
  ']': { open: '[', close: ']' },
  '{': { open: '{', close: '}' },
  '}': { open: '{', close: '}' },
  B: { open: '{', close: '}' },
  '"': { open: '"', close: '"' },
  "'": { open: "'", close: "'" },
  '`': { open: '`', close: '`' },
};

export function textObjectRange(
  lines: string[],
  cursor: BufferPos,
  kind: TextObjectKind,
): BufferRange | null {
  const inner = kind.startsWith('i');
  const obj = kind.slice(1);

  if (obj === 'w') {
    return wordObject(lines, cursor, /*around*/ !inner);
  }

  const pair = PAIR_MAP[obj];
  if (!pair) return null;
  return pairObject(lines, cursor, pair.open, pair.close, inner);
}

function wordObject(lines: string[], cursor: BufferPos, around: boolean): BufferRange {
  const text = lines[cursor.line] ?? '';
  let col = Math.min(cursor.col, Math.max(0, text.length - 1));
  if (text.length === 0) {
    return { start: { line: cursor.line, col: 0 }, end: { line: cursor.line, col: 0 } };
  }

  // If on whitespace and around, expand whitespace; if inner, find nearest word
  if (text[col] === ' ') {
    if (!around) {
      // iw on space: empty or single space
      return {
        start: { line: cursor.line, col },
        end: { line: cursor.line, col: col + 1 },
      };
    }
    let s = col;
    let e = col + 1;
    while (s > 0 && text[s - 1] === ' ') s--;
    while (e < text.length && text[e] === ' ') e++;
    return { start: { line: cursor.line, col: s }, end: { line: cursor.line, col: e } };
  }

  let s = col;
  let e = col;
  if (isWordChar(text[col])) {
    while (s > 0 && isWordChar(text[s - 1])) s--;
    while (e < text.length && isWordChar(text[e])) e++;
  } else {
    while (s > 0 && !isWordChar(text[s - 1]) && text[s - 1] !== ' ') s--;
    while (e < text.length && !isWordChar(text[e]) && text[e] !== ' ') e++;
  }

  if (around) {
    // Include trailing whitespace if any, else leading
    if (e < text.length && text[e] === ' ') {
      while (e < text.length && text[e] === ' ') e++;
    } else if (s > 0 && text[s - 1] === ' ') {
      while (s > 0 && text[s - 1] === ' ') s--;
    }
  }

  return { start: { line: cursor.line, col: s }, end: { line: cursor.line, col: e } };
}

function pairObject(
  lines: string[],
  cursor: BufferPos,
  open: string,
  close: string,
  inner: boolean,
): BufferRange | null {
  // Flatten to single-line search first (v1 — multi-line pairs limited to same line)
  const text = lines[cursor.line] ?? '';
  const col = cursor.col;

  if (open === close) {
    // Quote style: find enclosing pair on same line
    let left = -1;
    for (let i = col; i >= 0; i--) {
      if (text[i] === open) {
        left = i;
        break;
      }
    }
    if (left < 0) {
      for (let i = col; i < text.length; i++) {
        if (text[i] === open) {
          left = i;
          break;
        }
      }
    }
    if (left < 0) return null;
    const right = text.indexOf(close, left + 1);
    if (right < 0) return null;
    if (inner) {
      return {
        start: { line: cursor.line, col: left + 1 },
        end: { line: cursor.line, col: right },
      };
    }
    return {
      start: { line: cursor.line, col: left },
      end: { line: cursor.line, col: right + 1 },
    };
  }

  // Bracket style with simple depth counting on one line
  let openIdx = -1;
  let depth = 0;
  // Search backward for unmatched open
  for (let i = Math.min(col, text.length - 1); i >= 0; i--) {
    if (text[i] === close) depth++;
    else if (text[i] === open) {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx < 0) return null;
  depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return null;
  if (inner) {
    return {
      start: { line: cursor.line, col: openIdx + 1 },
      end: { line: cursor.line, col: closeIdx },
    };
  }
  return {
    start: { line: cursor.line, col: openIdx },
    end: { line: cursor.line, col: closeIdx + 1 },
  };
}

// ─── Range extract / delete ──────────────────────────────────────────────────

export function extractRange(lines: string[], range: BufferRange): string {
  const { start, end } = normalizeRange(range.start, range.end);
  if (start.line === end.line) {
    return (lines[start.line] ?? '').slice(start.col, end.col);
  }
  const parts: string[] = [];
  parts.push((lines[start.line] ?? '').slice(start.col));
  for (let i = start.line + 1; i < end.line; i++) {
    parts.push(lines[i] ?? '');
  }
  parts.push((lines[end.line] ?? '').slice(0, end.col));
  return parts.join('\n');
}

export function deleteRange(lines: string[], range: BufferRange): { lines: string[]; cursor: BufferPos } {
  const { start, end } = normalizeRange(range.start, range.end);
  const next = lines.map((l) => l);

  if (start.line === end.line) {
    const line = next[start.line] ?? '';
    next[start.line] = line.slice(0, start.col) + line.slice(end.col);
    return { lines: next, cursor: clampPos(next, start) };
  }

  const first = (next[start.line] ?? '').slice(0, start.col);
  const last = (next[end.line] ?? '').slice(end.col);
  next[start.line] = first + last;
  next.splice(start.line + 1, end.line - start.line);
  return { lines: next, cursor: clampPos(next, start) };
}

// ─── Operator application ────────────────────────────────────────────────────

/** Range from cursor through motion end (exclusive for w; inclusive-ish for e). */
export function rangeFromMotion(
  lines: string[],
  cursor: BufferPos,
  motion: MotionSpec,
): BufferRange {
  const end = applyMotion(lines, cursor, motion);
  // For characterwise forward motions, ensure end is exclusive past target for e/f
  if (
    (motion.kind === 'e' || motion.kind === 'f') &&
    end.line === cursor.line &&
    end.col >= cursor.col
  ) {
    return normalizeRange(cursor, { line: end.line, col: end.col + 1 });
  }
  // Linewise j/k: operate whole lines
  if (motion.kind === 'j' || motion.kind === 'k') {
    const a = Math.min(cursor.line, end.line);
    const b = Math.max(cursor.line, end.line);
    return {
      start: { line: a, col: 0 },
      end: {
        line: b,
        col: lineLen(lines, b),
      },
    };
  }
  return normalizeRange(cursor, end);
}

export function applyOperator(
  state: BufferState,
  op: VimOperator,
  range: BufferRange,
): OpResult {
  const yanked = extractRange(state.lines, range);
  if (op === 'y') {
    return {
      lines: state.lines.map((l) => l),
      cursor: state.cursor,
      yanked,
      enterInsert: false,
    };
  }
  const deleted = deleteRange(state.lines, range);
  return {
    lines: deleted.lines,
    cursor: deleted.cursor,
    yanked,
    enterInsert: op === 'c',
  };
}

export function applyOperatorMotion(
  state: BufferState,
  op: VimOperator,
  motion: MotionSpec,
): OpResult {
  const range = rangeFromMotion(state.lines, state.cursor, motion);
  return applyOperator(state, op, range);
}

export function applyOperatorTextObject(
  state: BufferState,
  op: VimOperator,
  kind: TextObjectKind,
): OpResult | null {
  const range = textObjectRange(state.lines, state.cursor, kind);
  if (!range) return null;
  return applyOperator(state, op, range);
}

// ─── Pending-key state machine helpers ───────────────────────────────────────

export type PendingKind =
  | { type: 'none' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: VimOperator; count: number }
  | { type: 'op-i'; op: VimOperator; count: number } // waiting for text-object after i/a
  | { type: 'op-a'; op: VimOperator; count: number }
  | { type: 'find'; count: number; till: boolean } // f/t waiting for char
  | { type: 'op-find'; op: VimOperator; count: number; till: boolean }
  | { type: 'g'; count: number }; // g pending for gg

export interface KeyStep {
  /** Updated pending state */
  pending: PendingKind;
  /** Motion to execute (move cursor) if any */
  motion?: MotionSpec;
  /** Operator+range application if ready */
  op?: {
    op: VimOperator;
    motion?: MotionSpec;
    textObject?: TextObjectKind;
    /** Linewise op (dd/yy/cc) — count is number of lines including current */
    linewiseCount?: number;
  };
  /** Repeat last change (dot) — not handled here */
  handled: boolean;
}

/**
 * Feed one normal-mode key into the operator-pending state machine.
 * `name` is lowercase key name; `shift` indicates shift was held.
 */
export function feedVimKey(
  pending: PendingKind,
  name: string,
  opts: { shift?: boolean } = {},
): KeyStep {
  const shift = opts.shift ?? false;

  // Digits for count (except bare 0 which is a motion when not building count)
  if (name >= '0' && name <= '9' && !shift) {
    // Bare `0` as motion when not mid-count
    if (name === '0' && pending.type === 'none') {
      return { pending: { type: 'none' }, motion: { kind: '0', count: 1 }, handled: true };
    }
    if (name === '0' && pending.type === 'operator') {
      return {
        pending: { type: 'none' },
        op: { op: pending.op, motion: { kind: '0', count: pending.count } },
        handled: true,
      };
    }
    if (pending.type === 'none') {
      return { pending: { type: 'count', digits: name }, handled: true };
    }
    if (pending.type === 'count') {
      return { pending: { type: 'count', digits: pending.digits + name }, handled: true };
    }
    if (pending.type === 'operator') {
      // count after operator multiplies the operator count (e.g. d2w)
      return {
        pending: {
          type: 'operator',
          op: pending.op,
          count: pending.count * Math.max(1, parseInt(name, 10) || 1),
        },
        handled: true,
      };
    }
  }

  const countFromPending =
    pending.type === 'count'
      ? Math.max(1, parseInt(pending.digits, 10) || 1)
      : pending.type === 'operator' ||
          pending.type === 'op-i' ||
          pending.type === 'op-a' ||
          pending.type === 'find' ||
          pending.type === 'op-find' ||
          pending.type === 'g'
        ? pending.count
        : 1;

  // Complete f/t with character
  if (pending.type === 'find') {
    const ch = shift ? name.toUpperCase() : name;
    return {
      pending: { type: 'none' },
      motion: { kind: pending.till ? 't' : 'f', char: ch, count: pending.count },
      handled: true,
    };
  }
  if (pending.type === 'op-find') {
    const ch = shift ? name.toUpperCase() : name;
    return {
      pending: { type: 'none' },
      op: {
        op: pending.op,
        motion: { kind: pending.till ? 't' : 'f', char: ch, count: pending.count },
      },
      handled: true,
    };
  }

  // Text object after i/a
  if (pending.type === 'op-i' || pending.type === 'op-a') {
    const prefix = pending.type === 'op-i' ? 'i' : 'a';
    const map: Record<string, TextObjectKind> = {
      w: `${prefix}w` as TextObjectKind,
      '(': `${prefix}(` as TextObjectKind,
      ')': `${prefix}(` as TextObjectKind,
      b: `${prefix}(` as TextObjectKind,
      '[': `${prefix}[` as TextObjectKind,
      ']': `${prefix}[` as TextObjectKind,
      '{': `${prefix}{` as TextObjectKind,
      '}': `${prefix}{` as TextObjectKind,
      B: `${prefix}{` as TextObjectKind,
      '"': `${prefix}"` as TextObjectKind,
      "'": `${prefix}'` as TextObjectKind,
      '`': `${prefix}\`` as TextObjectKind,
    };
    const kind = map[shift && name === 'b' ? 'B' : name];
    if (kind) {
      return {
        pending: { type: 'none' },
        op: { op: pending.op, textObject: kind },
        handled: true,
      };
    }
    return { pending: { type: 'none' }, handled: true };
  }

  // g → gg
  if (pending.type === 'g') {
    if (name === 'g' && !shift) {
      return {
        pending: { type: 'none' },
        motion: { kind: 'gg', count: 1 },
        handled: true,
      };
    }
    return { pending: { type: 'none' }, handled: true };
  }

  // Operators
  if ((name === 'd' || name === 'c' || name === 'y') && !shift) {
    if (pending.type === 'operator' && pending.op === name) {
      // dd / cc / yy — linewise; count is number of lines including current
      return {
        pending: { type: 'none' },
        op: {
          op: pending.op,
          linewiseCount: pending.count,
        },
        handled: true,
      };
    }
    const count = pending.type === 'count' ? countFromPending : 1;
    return { pending: { type: 'operator', op: name as VimOperator, count }, handled: true };
  }

  // After operator: i/a for text objects
  if (pending.type === 'operator' && (name === 'i' || name === 'a') && !shift) {
    return {
      pending: {
        type: name === 'i' ? 'op-i' : 'op-a',
        op: pending.op,
        count: pending.count,
      },
      handled: true,
    };
  }

  // f / t
  if ((name === 'f' || name === 't') && !shift) {
    if (pending.type === 'operator') {
      return {
        pending: {
          type: 'op-find',
          op: pending.op,
          count: pending.count,
          till: name === 't',
        },
        handled: true,
      };
    }
    return {
      pending: {
        type: 'find',
        count: pending.type === 'count' ? countFromPending : 1,
        till: name === 't',
      },
      handled: true,
    };
  }

  // g pending
  if (name === 'g' && !shift) {
    return {
      pending: { type: 'g', count: pending.type === 'count' ? countFromPending : 1 },
      handled: true,
    };
  }

  // Motions
  const motionMap: Record<string, MotionKind> = {
    h: 'h',
    l: 'l',
    j: 'j',
    k: 'k',
    w: 'w',
    b: 'b',
    e: 'e',
    '0': '0',
    $: '$',
  };
  // G
  if (name === 'g' && shift) {
    const m: MotionSpec = { kind: 'G', count: 1 };
    if (pending.type === 'operator') {
      return { pending: { type: 'none' }, op: { op: pending.op, motion: m }, handled: true };
    }
    return { pending: { type: 'none' }, motion: m, handled: true };
  }

  if (name === '$' || motionMap[name]) {
    const kind = name === '$' ? '$' : motionMap[name]!;
    const count =
      pending.type === 'operator'
        ? pending.count
        : pending.type === 'count'
          ? countFromPending
          : 1;
    const m: MotionSpec = { kind, count };
    if (pending.type === 'operator') {
      // linewise dd already handled; for d$ etc.
      return { pending: { type: 'none' }, op: { op: pending.op, motion: m }, handled: true };
    }
    return { pending: { type: 'none' }, motion: m, handled: true };
  }

  // Unrecognized — clear pending
  if (pending.type !== 'none') {
    return { pending: { type: 'none' }, handled: false };
  }
  return { pending: { type: 'none' }, handled: false };
}

/** Special-case linewise operator (dd/yy/cc) for count lines including current. */
export function applyLinewiseOperator(
  state: BufferState,
  op: VimOperator,
  lineCount: number,
): OpResult {
  const startLine = state.cursor.line;
  // lineCount includes current line: dd → 1, 3dd → 3
  const count = Math.max(1, lineCount);
  const endLine = Math.min(state.lines.length - 1, startLine + count - 1);
  // Line slice joined with \n. Single-line yy matches prior PromptInput
  // behavior (no trailing newline); multi-line yanks include separators.
  const yanked = state.lines.slice(startLine, endLine + 1).join('\n');
  const multi = endLine > startLine;
  const yankedOut = multi ? yanked + '\n' : yanked;
  if (op === 'y') {
    return {
      lines: state.lines.map((l) => l),
      cursor: state.cursor,
      yanked: yankedOut,
      enterInsert: false,
    };
  }
  const next = state.lines.slice();
  next.splice(startLine, endLine - startLine + 1);
  if (next.length === 0) next.push('');
  const cursorLine = Math.min(startLine, next.length - 1);
  return {
    lines: next,
    cursor: { line: cursorLine, col: 0 },
    yanked: yankedOut,
    enterInsert: op === 'c',
  };
}
