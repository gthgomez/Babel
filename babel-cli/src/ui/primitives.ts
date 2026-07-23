/**
 * Layout primitives for Babel's TUI.
 *
 * Concrete Component subclasses for building terminal UIs: Box, Text, Stack,
 * Spacer.  Follows the same string-output model as the base Component class
 * (no virtual DOM -- every render() produces a plain string).
 *
 * @module primitives
 */

// ─── Imports ──────────────────────────────────────────────────────────────

import { Component } from './component.js';
import {
  accent,
  bold,
  colorToken,
  dim,
  error,
  ghost,
  getEffectiveTerminalWidth,
  info,
  muted,
  primary,
  success,
  truncate as truncateText,
  visibleLength,
  warning,
  wrapText,
} from './theme.js';
import { COLOR_TOKENS } from './tokens.js';
import type { KeyEvent } from './keyInput.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Parse a hex colour string to { r, g, b } components. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Wrap `text` in an ANSI background-colour sequence using the named theme
 * token.  The token is looked up in COLOR_TOKENS (from the active theme).
 */
function applyBgColor(text: string, token: string): string {
  const hex = COLOR_TOKENS[token];
  if (!hex) return text;
  const rgb = hexToRgb(hex);
  return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[49m`;
}

/** Normalise padding to a four-sided object. */
function normalizePadding(
  p: number | { top: number; right: number; bottom: number; left: number } | undefined,
): { top: number; right: number; bottom: number; left: number } {
  if (p === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof p === 'number') return { top: p, right: p, bottom: p, left: p };
  return p;
}

/** Approximate terminal height from stdout, falling back to 24 rows. */
function getTerminalHeight(): number {
  const rows = process.stdout.rows;
  return typeof rows === 'number' && rows > 0 ? rows : 24;
}

/**
 * Colour only the border runes (corners + dashes) in a title-bearing top
 * border line.  Text between the dashes keeps its original styling.
 */
function colorBorderTitleLine(
  line: string,
  border: NonNullable<(typeof BORDER_SETS)[keyof typeof BORDER_SETS]>,
  borderColorToken: string,
): string {
  const bc = (t: string) => colorToken(borderColorToken, t);
  // Walk from left: colour border chars until we hit non-border content.
  const chars = [...line];
  let i = 0;
  while (i < chars.length && (chars[i] === border.tl || chars[i] === border.h)) {
    chars[i] = bc(chars[i]!);
    i++;
  }
  // Walk from right
  let j = chars.length - 1;
  while (j >= 0 && (chars[j] === border.tr || chars[j] === border.h)) {
    chars[j] = bc(chars[j]!);
    j--;
  }
  return chars.join('');
}

// ─── Border character sets ─────────────────────────────────────────────────

interface BorderSet {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
}

const BORDER_SETS: Record<string, BorderSet | null> = {
  none: null,
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  rounded: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
};

// ─── Style-application map ────────────────────────────────────────────────

const STYLE_APPLY: Record<string, (t: string) => string> = {
  primary,
  muted,
  ghost,
  accent,
  info,
  success,
  warning,
  error,
  bold,
  dim,
};

// ══════════════════════════════════════════════════════════════════════════
//  Box
// ══════════════════════════════════════════════════════════════════════════

export interface BoxOptions {
  /** Content -- strings (rendered verbatim) and/or child Components. */
  children?: (Component | string)[];
  /** Padding inside the border.  Single number applies to all four sides. */
  padding?: number | { top: number; right: number; bottom: number; left: number };
  /** Border style.  Defaults to 'none' (no border). */
  border?: 'none' | 'single' | 'double' | 'rounded';
  /** Theme token name for border-foreground colour (e.g. 'border'). */
  borderColor?: string;
  /** Theme token name for background fill (e.g. 'background', 'panel'). */
  background?: string;
  /**
   * Optional title rendered inside the top border: `┌─ Title ──┐`.
   * Only applies when border is set.
   */
  title?: string;
  /**
   * Width constraint.
   * - number    : exact column count
   * - 'auto'    : fill terminal width
   * - undefined : natural (content-width + padding + border)
   */
  width?: number | 'auto';
  /**
   * Height constraint.
   * - number    : exact row count
   * - 'auto'    : fill terminal height
   * - undefined : natural (content + padding + border)
   */
  height?: number | 'auto';
  /** Minimum width (overrides natural width). */
  minWidth?: number;
  /** Maximum width (clamps 'auto' or natural). */
  maxWidth?: number;
  /** Minimum height (overrides natural height). */
  minHeight?: number;
  /** Maximum height (clamps 'auto' or natural). */
  maxHeight?: number;
  /** Horizontal alignment of content inside the box. */
  align?: 'left' | 'center' | 'right';
  /** Vertical alignment of content inside the box. */
  verticalAlign?: 'top' | 'middle' | 'bottom';
}

/**
 * A bordered / backgrounded container that lays out its children in a single
 * column.  Supports padding, border styles, colour, alignment, and sizing
 * constraints.
 */
export class Box extends Component {
  private _children: (Component | string)[];
  private _padding: number | { top: number; right: number; bottom: number; left: number };
  private _border: 'none' | 'single' | 'double' | 'rounded';
  private _borderColor: string | undefined;
  private _background: string | undefined;
  private _title: string | undefined;
  private _width: number | 'auto' | undefined;
  private _height: number | 'auto' | undefined;
  private _minWidth: number | undefined;
  private _maxWidth: number | undefined;
  private _minHeight: number | undefined;
  private _maxHeight: number | undefined;
  private _align: 'left' | 'center' | 'right';
  private _verticalAlign: 'top' | 'middle' | 'bottom';

  constructor(options: BoxOptions = {}) {
    super();
    this._children = options.children ?? [];
    this._padding = options.padding ?? 0;
    this._border = options.border ?? 'none';
    this._borderColor = options.borderColor;
    this._background = options.background;
    this._title = options.title;
    this._width = options.width;
    this._height = options.height;
    this._minWidth = options.minWidth;
    this._maxWidth = options.maxWidth;
    this._minHeight = options.minHeight;
    this._maxHeight = options.maxHeight;
    this._align = options.align ?? 'left';
    this._verticalAlign = options.verticalAlign ?? 'top';

    // Register Component children with the base class so they participate in
    // mount/unmount/focus lifecycle.
    for (const child of this._children) {
      if (child instanceof Component) {
        this.addChild(child);
      }
    }
  }

  // ── Component overrides ────────────────────────────────────────────────

  override handleKey(_event: KeyEvent): boolean {
    return false;
  }

  protected override canFocus(): boolean {
    return false;
  }

  // ── Render ─────────────────────────────────────────────────────────────

  override render(): string {
    // 1. Resolve border
    const border = BORDER_SETS[this._border] ?? null;
    const hasBorder = border !== null;
    const borderW = hasBorder ? 2 : 0;

    // 2. Normalize padding
    const pad = normalizePadding(this._padding);

    // 3. Render every child to flat content lines
    const contentLines: string[] = [];
    for (const child of this._children) {
      if (typeof child === 'string') {
        if (child) contentLines.push(...child.split('\n'));
      } else {
        const rendered = child.render();
        if (rendered) contentLines.push(...rendered.split('\n'));
      }
    }

    // 4. Natural content width (widest line's visual length)
    const maxContentW =
      contentLines.length > 0 ? Math.max(...contentLines.map((l) => visibleLength(l))) : 0;

    // 5. Determine outer width
    let outerW: number;
    if (this._width === 'auto') {
      outerW = getEffectiveTerminalWidth();
    } else if (typeof this._width === 'number') {
      outerW = this._width;
    } else {
      outerW = maxContentW + pad.left + pad.right + borderW;
    }
    if (this._minWidth !== undefined) outerW = Math.max(outerW, this._minWidth);
    if (this._maxWidth !== undefined) outerW = Math.min(outerW, this._maxWidth);
    outerW = Math.max(outerW, 1);

    const innerW = Math.max(1, outerW - borderW - pad.left - pad.right);

    // 6. Horizontally align every content line to innerW
    const alignedLines = contentLines.map((line) => {
      const len = visibleLength(line);
      if (len >= innerW) return truncateText(line, innerW);

      const deficit = innerW - len;
      switch (this._align) {
        case 'center': {
          const left = Math.floor(deficit / 2);
          return ' '.repeat(left) + line + ' '.repeat(deficit - left);
        }
        case 'right':
          return ' '.repeat(deficit) + line;
        default:
          return line + ' '.repeat(deficit);
      }
    });

    // 7. Determine outer height
    const naturalContentH = alignedLines.length;
    const naturalInnerH = naturalContentH + pad.top + pad.bottom;

    let outerH: number;
    if (this._height === 'auto') {
      outerH = getTerminalHeight();
    } else if (typeof this._height === 'number') {
      outerH = this._height;
    } else {
      outerH = naturalInnerH + (hasBorder ? borderW : 0);
    }
    if (this._minHeight !== undefined) outerH = Math.max(outerH, this._minHeight);
    if (this._maxHeight !== undefined) outerH = Math.min(outerH, this._maxHeight);
    outerH = Math.max(outerH, 1);

    const innerAreaH = Math.max(1, outerH - borderW);

    // 8. Build the inner area (empty lines), place content with vertical
    //    alignment and padding.
    const emptyLine = ' '.repeat(innerW);
    const innerBox: string[] = new Array(innerAreaH).fill(emptyLine);

    // Compute start Y so content is positioned according to verticalAlign,
    // then offset by top padding.
    let contentStartY: number;
    switch (this._verticalAlign) {
      case 'middle':
        contentStartY = Math.max(0, Math.floor((innerAreaH - naturalContentH) / 2));
        break;
      case 'bottom':
        contentStartY = Math.max(0, innerAreaH - naturalContentH);
        break;
      default:
        contentStartY = 0;
        break;
    }
    const contentY = contentStartY + pad.top;

    for (let i = 0; i < alignedLines.length; i++) {
      const targetY = contentY + i;
      if (targetY >= 0 && targetY < innerAreaH) {
        innerBox[targetY] = alignedLines[i]!;
      }
    }

    // 9. Wrap with border
    let resultLines: string[];
    if (hasBorder) {
      const hLine = border.h.repeat(innerW);
      const bottomLine = `${border.bl}${hLine}${border.br}`;

      // Build top border, optionally embedding a title: `┌─ Title ──┐`
      let topLine: string;
      if (this._title) {
        const titleText = ` ${this._title} `;
        const titleVisLen = visibleLength(titleText);
        // Leave at least 3 border chars on each side for padding: ┌─ ... ─┐
        const maxTitleInner = Math.max(0, innerW - 6);
        const displayed =
          titleVisLen > maxTitleInner ? truncateText(titleText, maxTitleInner) : titleText;
        const displayedLen = visibleLength(displayed);
        const leftDash = Math.max(1, Math.floor((innerW - displayedLen) / 2));
        const rightDash = Math.max(1, innerW - leftDash - displayedLen);
        topLine = `${border.tl}${border.h.repeat(leftDash)}${displayed}${border.h.repeat(rightDash)}${border.tr}`;
      } else {
        topLine = `${border.tl}${hLine}${border.tr}`;
      }

      resultLines = [
        topLine,
        ...innerBox.map((line) => `${border.v}${line}${border.v}`),
        bottomLine,
      ];
    } else {
      resultLines = innerBox;
    }

    // 10. Apply border colour (only to the border characters themselves).
    if (hasBorder && this._borderColor) {
      const bc = (t: string) => colorToken(this._borderColor!, t);

      for (let i = 0; i < resultLines.length; i++) {
        const line = resultLines[i]!;
        if (i === 0) {
          // Top border: may contain a title. Only colour the border runes
          // (corners + dashes), not the embedded title text.
          if (this._title) {
            resultLines[i] = colorBorderTitleLine(line, border, this._borderColor);
          } else {
            resultLines[i] = bc(line);
          }
        } else if (i === resultLines.length - 1) {
          // Bottom border line: every character is border.
          resultLines[i] = bc(line);
        } else {
          // Content line: first and last characters are the vertical border.
          const firstChar = line.charAt(0);
          const lastChar = line.charAt(line.length - 1);
          const mid = line.slice(1, -1);
          resultLines[i] = bc(firstChar) + mid + bc(lastChar);
        }
      }
    }

    // 11. Apply background fill to every line (fills to outer width).
    if (this._background) {
      resultLines = resultLines.map((line) => applyBgColor(line, this._background!));
    }

    return resultLines.join('\n');
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  Text
// ══════════════════════════════════════════════════════════════════════════

export interface TextOptions {
  /** Text content, or a function called on every render() for dynamic content. */
  content: string | (() => string);
  /** Whether to wrap at available width (default false). */
  wrap?: boolean;
  /** Whether to truncate with '...' if wider than available (default false). */
  truncate?: boolean;
  /**
   * Named style to apply.  Maps to the theme colour/bold/dim functions
   * exported from theme.ts.
   */
  style?:
    | 'primary'
    | 'muted'
    | 'ghost'
    | 'accent'
    | 'success'
    | 'warning'
    | 'error'
    | 'info'
    | 'bold'
    | 'dim';
  /** Horizontal alignment (only applies to single-line rendering). */
  align?: 'left' | 'center' | 'right';
}

/**
 * Renders a single text string (which may contain ANSI escapes already).
 *
 * The Text component is the leaf-level content primitive.  It handles style
 * application, optional wrapping / truncation, and alignment.
 *
 * Width-constraint is delegated to parent containers (e.g. Box) which clip
 * or pad the rendered output.  When used standalone, wrap/truncate use
 * `getEffectiveTerminalWidth()` as the available width.
 */
export class Text extends Component {
  private _content: string | (() => string);
  private _wrap: boolean;
  private _truncate: boolean;
  private _style: string | undefined;
  private _align: 'left' | 'center' | 'right';

  constructor(options: TextOptions) {
    super();
    this._content = options.content;
    this._wrap = options.wrap ?? false;
    this._truncate = options.truncate ?? false;
    this._style = options.style;
    this._align = options.align ?? 'left';
  }

  override handleKey(_event: KeyEvent): boolean {
    return false;
  }

  protected override canFocus(): boolean {
    return false;
  }

  override render(): string {
    // 1. Resolve content (dynamic via function or static string).
    const raw = typeof this._content === 'function' ? this._content() : this._content;

    // 2. Apply style.
    const styleFn = this._style ? STYLE_APPLY[this._style] : undefined;
    const styled = styleFn ? styleFn(raw) : raw;

    // 3. Determine available width.
    const maxW = getEffectiveTerminalWidth();

    // 4. Apply wrapping (takes precedence over truncation).
    if (this._wrap) {
      const lines = wrapText(styled, maxW);
      // Re-join; alignment doesn't make sense for multiline wrapped output.
      return lines.join('\n');
    }

    // 5. Apply truncation (single-line).
    if (this._truncate) {
      return truncateText(styled, maxW);
    }

    // 6. Alignment (only for single-line content with room to spare).
    if (this._align !== 'left') {
      const len = visibleLength(styled);
      if (len < maxW) {
        const deficit = maxW - len;
        if (this._align === 'center') {
          const left = Math.floor(deficit / 2);
          return ' '.repeat(left) + styled + ' '.repeat(deficit - left);
        }
        if (this._align === 'right') {
          return ' '.repeat(deficit) + styled;
        }
      }
    }

    return styled;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  Stack  (vertical layout)
// ══════════════════════════════════════════════════════════════════════════

export interface StackOptions {
  /** Child components stacked vertically. */
  children?: Component[];
  /** Gap in blank lines between children (default 0). */
  gap?: number;
  /**
   * Vertical distribution mode when the stack has more space than its
   * children need. Requires height constraint plumbing through the Component
   * tree layout pass (deferred feature). With natural height (the default,
   * since Stack has no height constraint) all modes behave as 'start'.
   */
  distribute?: 'start' | 'center' | 'end' | 'stretch';
}

/**
 * A vertical stack of Components, rendered one per row with optional gap.
 *
 * Children are rendered densely (top-to-bottom).  The stack's natural height
 * is the sum of its children's heights plus gaps.  The `distribute` option
 * requires height constraint plumbing through the Component tree layout pass
 * (deferred feature) — without an explicit parent height it behaves as 'start'.
 */
export class Stack extends Component {
  private _gap: number;
  private _distribute: 'start' | 'center' | 'end' | 'stretch';

  constructor(options: StackOptions = {}) {
    super();
    this._gap = options.gap ?? 0;
    this._distribute = options.distribute ?? 'start';

    if (options.children) {
      for (const child of options.children) {
        this.addChild(child);
      }
    }
  }

  override handleKey(_event: KeyEvent): boolean {
    return false;
  }

  protected override canFocus(): boolean {
    return false;
  }

  override render(): string {
    const childCount = this.children.length;
    if (childCount === 0) return '';

    const outputLines: string[] = [];

    for (let i = 0; i < childCount; i++) {
      // Gap lines between children.
      if (i > 0) {
        for (let g = 0; g < this._gap; g++) {
          outputLines.push('');
        }
      }

      const rendered = this.children[i]!.render();
      if (rendered) {
        outputLines.push(...rendered.split('\n'));
      }
    }

    return outputLines.join('\n');
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  Spacer
// ══════════════════════════════════════════════════════════════════════════

export interface SpacerOptions {
  /** Width in columns (0 uses terminal width).  Default 0. */
  width?: number;
  /** Height in rows.  Default 1. */
  height?: number;
}

/**
 * A blank filler that occupies a given width and height.
 *
 * Useful in Stacks to push siblings apart, or inside Boxes to reserve
 * empty space.
 */
export class Spacer extends Component {
  private _width: number;
  private _height: number;

  constructor(options: SpacerOptions = {}) {
    super();
    this._width = options.width ?? 0;
    this._height = options.height ?? 1;
  }

  override handleKey(_event: KeyEvent): boolean {
    return false;
  }

  protected override canFocus(): boolean {
    return false;
  }

  override render(): string {
    const cols = this._width > 0 ? this._width : getEffectiveTerminalWidth();
    const lines: string[] = [];
    for (let i = 0; i < this._height; i++) {
      lines.push(' '.repeat(cols));
    }
    return lines.join('\n');
  }
}
