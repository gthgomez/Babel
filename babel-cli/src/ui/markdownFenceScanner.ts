/**
 * markdownFenceScanner.ts — Shared stateful Markdown code block fence scanner.
 *
 * Conforms to CommonMark Specification (v0.31.2, Section 4.5: Fenced code blocks):
 *   - Opener: 0..3 leading spaces, followed by 3+ backticks (`) or 3+ tildes (~), followed by optional info string.
 *   - CommonMark Backtick Invariant: For backtick fences, the info string CANNOT contain any backtick characters (`).
 *   - Tilde Invariant: Tilde fences CAN contain backticks in the info string.
 *   - Closer: 0..3 leading spaces, followed by the same fence character with length >= opener length,
 *             and ONLY optional trailing whitespace.
 */

export interface OpenFence {
  char: '`' | '~';
  length: number;
  info: string;
  language: string;
}

export interface FenceScanResult {
  isOpener: boolean;
  isCloser: boolean;
  fence: OpenFence | null;
}

/**
 * Scan a single line of text against an active open fence state.
 *
 * @param line Line of markdown text
 * @param currentFence Currently active open fence, or null if outside code block
 */
export function scanFenceLine(line: string, currentFence: OpenFence | null): FenceScanResult {
  if (!currentFence) {
    // Opener: 0..3 spaces, 3+ backticks or 3+ tildes, followed by rest of line
    const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match || !match[1]) {
      return { isOpener: false, isCloser: false, fence: null };
    }

    const fenceSeq = match[1];
    const fenceChar = fenceSeq[0] as '`' | '~';
    const fenceLength = fenceSeq.length;
    const rawTail = match[2] ?? '';

    // CommonMark: For backtick fences, the info string cannot contain any backtick characters
    if (fenceChar === '`' && rawTail.includes('`')) {
      return { isOpener: false, isCloser: false, fence: null };
    }

    const info = rawTail.trim();
    const language = info ? (info.split(/\s+/)[0] ?? '') : '';
    const fence: OpenFence = { char: fenceChar, length: fenceLength, info, language };
    return { isOpener: true, isCloser: false, fence };
  }

  // Closer: 0..3 spaces, same fence character with length >= opener length, only trailing whitespace
  const closerPattern =
    currentFence.char === '`' ? /^[ ]{0,3}(`{3,})[ \t]*$/ : /^[ ]{0,3}(~{3,})[ \t]*$/;
  const match = line.match(closerPattern);
  if (match && match[1] && match[1].length >= currentFence.length) {
    return { isOpener: false, isCloser: true, fence: null };
  }

  // Inside code block
  return { isOpener: false, isCloser: false, fence: currentFence };
}
