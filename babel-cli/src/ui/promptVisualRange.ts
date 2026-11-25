/** Cursor and selection state used to calculate a normalized visual range. */
export interface PromptVisualPoint {
  line: number;
  col: number;
}

export interface PromptVisualRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface PromptSelectionColRange {
  start: number;
  end: number;
}

/** Normalize the current visual selection to an exclusive end column. */
export function getNormalizedVisualRange(input: {
  visualStart: PromptVisualPoint | null;
  visualMode: 'char' | 'line' | null;
  cursorLine: number;
  cursorCol: number;
  lines: readonly string[];
}): PromptVisualRange {
  const { visualStart, visualMode, cursorLine, cursorCol, lines } = input;
  if (!visualStart) {
    return {
      startLine: cursorLine,
      startCol: cursorCol,
      endLine: cursorLine,
      endCol: cursorCol,
    };
  }

  if (visualMode === 'line') {
    const startLine = Math.min(visualStart.line, cursorLine);
    const endLine = Math.max(visualStart.line, cursorLine);
    return { startLine, startCol: 0, endLine, endCol: Infinity };
  }

  const end = { line: cursorLine, col: cursorCol };
  const normStart = visualStart.line < end.line ||
    (visualStart.line === end.line && visualStart.col <= end.col)
    ? visualStart
    : end;
  const normEnd = normStart === visualStart ? end : visualStart;
  const endLineLen = lines[normEnd.line]?.length ?? 0;
  const endCol = normEnd.col < endLineLen ? normEnd.col + 1 : endLineLen;

  return {
    startLine: normStart.line,
    startCol: normStart.col,
    endLine: normEnd.line,
    endCol,
  };
}

/** Return the selected columns for one line, or null when it is not selected. */
export function getSelectionColRange(input: {
  line: number;
  lines: readonly string[];
  visualStart: PromptVisualPoint | null;
  visualMode: 'char' | 'line' | null;
  cursorLine: number;
  cursorCol: number;
}): PromptSelectionColRange | null {
  const { line, lines, visualStart, visualMode, cursorLine, cursorCol } = input;
  if (!visualStart) return null;

  const range = getNormalizedVisualRange({
    visualStart,
    visualMode,
    cursorLine,
    cursorCol,
    lines,
  });
  if (line < range.startLine || line > range.endLine) return null;

  if (visualMode === 'line') {
    return { start: 0, end: (lines[line] ?? '').length };
  }
  if (line === range.startLine && line === range.endLine) {
    return { start: range.startCol, end: range.endCol };
  }
  if (line === range.startLine) {
    return { start: range.startCol, end: (lines[line] ?? '').length };
  }
  if (line === range.endLine) {
    return { start: 0, end: range.endCol };
  }
  return { start: 0, end: (lines[line] ?? '').length };
}

/** Delete a visual selection, mutating its line buffer and returning editor state. */
export function deleteVisualSelection(input: {
  lines: string[];
  visualStart: PromptVisualPoint | null;
  visualMode: 'char' | 'line' | null;
  cursorLine: number;
  cursorCol: number;
}): { killBuffer: string; cursorLine: number; cursorCol: number } | null {
  const { lines, visualStart, visualMode, cursorLine, cursorCol } = input;
  if (!visualStart) return null;

  const range = getNormalizedVisualRange(input);
  let killBuffer: string;
  let nextCursorLine: number;
  let nextCursorCol: number;
  if (visualMode === 'line') {
    const yankedLines: string[] = [];
    for (let i = range.startLine; i <= range.endLine; i++) {
      yankedLines.push(lines[i] ?? '');
    }
    killBuffer = yankedLines.join('\n') + '\n';
    lines.splice(range.startLine, range.endLine - range.startLine + 1);
    if (lines.length === 0) lines.push('');
    nextCursorLine = Math.min(range.startLine, lines.length - 1);
    nextCursorCol = 0;
  } else {
    const line = lines[range.startLine] ?? '';
    if (range.startLine === range.endLine) {
      killBuffer = line.slice(range.startCol, range.endCol);
      lines[range.startLine] = line.slice(0, range.startCol) + line.slice(range.endCol);
      nextCursorLine = range.startLine;
      nextCursorCol = range.startCol;
    } else {
      const yankedParts: string[] = [line.slice(range.startCol)];
      for (let i = range.startLine + 1; i < range.endLine; i++) {
        yankedParts.push(lines[i] ?? '');
      }
      const lastLine = lines[range.endLine] ?? '';
      yankedParts.push(lastLine.slice(0, range.endCol));
      killBuffer = yankedParts.join('\n');
      lines[range.startLine] = line.slice(0, range.startCol) + lastLine.slice(range.endCol);
      lines.splice(range.startLine + 1, range.endLine - range.startLine);
      nextCursorLine = range.startLine;
      nextCursorCol = range.startCol;
    }
  }
  return { killBuffer, cursorLine: nextCursorLine, cursorCol: nextCursorCol };
}

/** Copy a visual selection into the kill buffer without changing the lines. */
export function getVisualSelectionText(input: {
  lines: readonly string[];
  visualStart: PromptVisualPoint | null;
  visualMode: 'char' | 'line' | null;
  cursorLine: number;
  cursorCol: number;
}): string | null {
  const { lines, visualStart, visualMode, cursorLine, cursorCol } = input;
  if (!visualStart) return null;

  const range = getNormalizedVisualRange(input);
  if (visualMode === 'line') {
    const yankedLines: string[] = [];
    for (let i = range.startLine; i <= range.endLine; i++) {
      yankedLines.push(lines[i] ?? '');
    }
    return yankedLines.join('\n') + '\n';
  }
  if (range.startLine === range.endLine) {
    return (lines[range.startLine] ?? '').slice(range.startCol, range.endCol);
  }
  const parts: string[] = [(lines[range.startLine] ?? '').slice(range.startCol)];
  for (let i = range.startLine + 1; i < range.endLine; i++) {
    parts.push(lines[i] ?? '');
  }
  parts.push((lines[range.endLine] ?? '').slice(0, range.endCol));
  return parts.join('\n');
}
