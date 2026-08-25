/**
 * textLayout.ts — Terminal display measurement, truncation, and line wrapping.
 *
 * Pure, renderer-independent layout transformation engine.
 * Leaf module: has ZERO dependencies on Markdown, themes, tokens, or chat records.
 */

import stringWidth from 'string-width';
import { scanTerminalTokens, ESC, type TerminalToken } from './terminalSequenceScanner.js';
import { graphemeClusters } from './textUtils.js';

export type LongTokenPolicy = 'hard-wrap' | 'overflow' | 'truncate';

export interface TruncateOptions {
  ellipsis?: string;
}

export interface WrapDisplayOptions {
  longTokenPolicy?: LongTokenPolicy;
}

export interface PrefixedBlockOptions {
  firstPrefix: string;
  continuationPrefix: string;
  width: number;
  longTokenPolicy?: LongTokenPolicy;
}

interface LayoutStyleState {
  sgr: string;
  osc8: string;
}

/**
 * Measure true visible terminal column width of a string.
 * Strips ANSI CSI and OSC 8 sequences before measuring grapheme widths.
 */
export function measureDisplayWidth(text: string): number {
  if (!text) return 0;
  let plain = '';
  for (const token of scanTerminalTokens(text)) {
    if (token.type === 'text') {
      plain += token.raw;
    }
  }
  return stringWidth(plain);
}

/**
 * Truncate text to fit within `maxWidth` visible columns.
 * Grapheme-cluster and ANSI-aware. Clamps to column bounds and safely closes
 * any open SGR graphic rendition attributes (\x1b[0m) and OSC 8 hyperlinks
 * (\x1b]8;;\x1b\) to prevent style or link leakage into adjacent terminal cells.
 */
export function truncateDisplay(
  text: string,
  maxWidth: number,
  options: TruncateOptions = {},
): string {
  if (maxWidth <= 0) return '';
  const ellipsis = options.ellipsis ?? '…';
  const ellipsisWidth = measureDisplayWidth(ellipsis);

  const totalWidth = measureDisplayWidth(text);
  if (totalWidth <= maxWidth) {
    return text;
  }

  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);
  let currentWidth = 0;
  let result = '';
  let activeSgr = false;
  let activeOsc8 = false;

  for (const token of scanTerminalTokens(text)) {
    if (token.type === 'sgr') {
      result += token.raw;
      activeSgr = token.raw !== `${ESC}[0m` && token.raw !== `${ESC}[m`;
      continue;
    }

    if (token.type === 'osc8_open') {
      result += token.raw;
      activeOsc8 = true;
      continue;
    }

    if (token.type === 'osc8_close') {
      result += token.raw;
      activeOsc8 = false;
      continue;
    }

    if (token.type === 'csi' || token.type === 'osc' || token.type === 'dcs') {
      result += token.raw;
      continue;
    }

    if (token.type === 'text') {
      const clusters = graphemeClusters(token.raw);
      for (const cluster of clusters) {
        const clusterWidth = stringWidth(cluster);
        if (currentWidth + clusterWidth > targetWidth) {
          result += ellipsis;
          if (activeOsc8) {
            result += `${ESC}]8;;${ESC}\\`;
          }
          if (activeSgr) {
            result += `${ESC}[0m`;
          }
          return result;
        }
        result += cluster;
        currentWidth += clusterWidth;
      }
      continue;
    }

    if (token.type === 'newline' || token.type === 'carriage_return') {
      // In truncation mode, newlines trigger early break
      break;
    }
  }

  result += ellipsis;
  if (activeOsc8) {
    result += `${ESC}]8;;${ESC}\\`;
  }
  if (activeSgr) {
    result += `${ESC}[0m`;
  }
  return result;
}

/**
 * Wrap a sequence of terminal tokens into lines using dynamic line-budget callbacks.
 * Carries active SGR styling and OSC 8 hyperlink state across physical wraps:
 *   - Closes active OSC 8 and SGR before breaking the line.
 *   - Inserts prefix.
 *   - Reopens active SGR and OSC 8 after the prefix before continuing content.
 *   - Avoids trailing whitespace before line breaks.
 */
function wrapTokensWithStyleCarry(
  tokens: TerminalToken[],
  getWidthLimit: (lineIndex: number) => number,
  getPrefix: (lineIndex: number) => string,
  policy: LongTokenPolicy,
): string[] {
  const lines: string[] = [];
  let lineIndex = 0;
  let currentPrefix = getPrefix(lineIndex);
  let currentWidthLimit = Math.max(1, getWidthLimit(lineIndex));
  let currentLineContent = '';
  let currentLineWidth = 0;
  let pendingSpace = '';

  const state: LayoutStyleState = { sgr: '', osc8: '' };

  const closeCurrentLine = (): void => {
    let closed = currentLineContent;
    if (state.osc8) {
      closed += `${ESC}]8;;${ESC}\\`;
    }
    if (state.sgr) {
      closed += `${ESC}[0m`;
    }
    lines.push(currentPrefix + closed);

    lineIndex++;
    currentPrefix = getPrefix(lineIndex);
    currentWidthLimit = Math.max(1, getWidthLimit(lineIndex));
    pendingSpace = '';

    currentLineContent = '';
    if (state.sgr) {
      currentLineContent += state.sgr;
    }
    if (state.osc8) {
      currentLineContent += state.osc8;
    }
    currentLineWidth = 0;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token.type === 'sgr') {
      currentLineContent += token.raw;
      if (token.raw === `${ESC}[0m` || token.raw === `${ESC}[m`) {
        state.sgr = '';
      } else {
        state.sgr += token.raw;
      }
      continue;
    }

    if (token.type === 'osc8_open') {
      currentLineContent += token.raw;
      state.osc8 = token.raw;
      continue;
    }

    if (token.type === 'osc8_close') {
      currentLineContent += token.raw;
      state.osc8 = '';
      continue;
    }

    if (token.type === 'csi' || token.type === 'osc' || token.type === 'dcs') {
      currentLineContent += token.raw;
      continue;
    }

    if (token.type !== 'text') {
      continue;
    }

    // Split text into whitespace and word chunks
    const parts = token.raw.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;

      const isWhitespace = /^\s+$/.test(part);
      if (isWhitespace) {
        if (currentLineWidth === 0) {
          const partWidth = stringWidth(part);
          if (partWidth <= currentWidthLimit) {
            // Preserve leading line indentation (e.g. code blocks, blockquotes)
            currentLineContent += part;
            currentLineWidth += partWidth;
          } else if (policy === 'overflow') {
            currentLineContent += part;
            currentLineWidth += partWidth;
          } else if (policy === 'truncate') {
            const trunc = truncateDisplay(part, currentWidthLimit);
            currentLineContent += trunc;
            currentLineWidth = measureDisplayWidth(trunc);
          } else {
            // 'hard-wrap': chunk long leading whitespace across lines
            const clusters = graphemeClusters(part);
            for (const cluster of clusters) {
              const cWidth = stringWidth(cluster);
              if (currentLineWidth + cWidth > currentWidthLimit && currentLineWidth > 0) {
                closeCurrentLine();
              }
              currentLineContent += cluster;
              currentLineWidth += cWidth;
            }
          }
        } else {
          // Queue interstitial whitespace to only be committed if next word fits on this line
          pendingSpace += part;
        }
        continue;
      }

      const word = part;
      const wordWidth = stringWidth(word);
      const spaceWidth = stringWidth(pendingSpace);

      // Check if word fits on current line (with pending space if any)
      const neededWidth = currentLineWidth + (currentLineWidth > 0 ? spaceWidth : 0) + wordWidth;

      if (neededWidth <= currentWidthLimit) {
        if (currentLineWidth > 0 && pendingSpace) {
          currentLineContent += pendingSpace;
          currentLineWidth += spaceWidth;
        }
        pendingSpace = '';
        currentLineContent += word;
        currentLineWidth += wordWidth;
        continue;
      }

      // Word does not fit on current line
      if (currentLineWidth > 0) {
        closeCurrentLine();
      }

      // Now on a fresh line: check if word fits on this new line
      if (wordWidth <= currentWidthLimit) {
        currentLineContent += word;
        currentLineWidth += wordWidth;
        continue;
      }

      // Word itself exceeds the full width limit
      if (policy === 'overflow') {
        currentLineContent += word;
        currentLineWidth += wordWidth;
        continue;
      }

      if (policy === 'truncate') {
        const trunc = truncateDisplay(word, currentWidthLimit);
        currentLineContent += trunc;
        currentLineWidth = measureDisplayWidth(trunc);
        continue;
      }

      // 'hard-wrap': split long token across lines by grapheme clusters
      const clusters = graphemeClusters(word);
      for (const cluster of clusters) {
        const cWidth = stringWidth(cluster);
        if (currentLineWidth + cWidth > currentWidthLimit && currentLineWidth > 0) {
          closeCurrentLine();
        }
        currentLineContent += cluster;
        currentLineWidth += cWidth;
      }
    }
  }

  // Push final line
  lines.push(currentPrefix + currentLineContent);

  return lines;
}

/**
 * Wrap a single paragraph into multiple lines fitting within maxWidth.
 */
function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  policy: LongTokenPolicy = 'hard-wrap',
): string[] {
  if (maxWidth <= 0) return [];
  if (measureDisplayWidth(paragraph) <= maxWidth) {
    return [paragraph];
  }

  const tokens = [...scanTerminalTokens(paragraph)];
  return wrapTokensWithStyleCarry(
    tokens,
    () => maxWidth,
    () => '',
    policy,
  );
}

/**
 * Wrap text across multiple lines fitting within maxWidth.
 * Preserves explicit paragraph newlines (\n).
 */
export function wrapDisplayLines(
  text: string,
  maxWidth: number,
  options: WrapDisplayOptions = {},
): string[] {
  if (maxWidth <= 0) return [];
  const policy = options.longTokenPolicy ?? 'hard-wrap';
  const paragraphs = String(text ?? '').split('\n');
  const result: string[] = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p] ?? '';
    const wrapped = wrapParagraph(paragraph, maxWidth, policy);
    result.push(...wrapped);
  }

  return result;
}

/**
 * Wrap a body of text with distinct first-line and continuation-line prefixes.
 *
 * Guaranteed Invariants:
 *   1. measureDisplayWidth(line) <= width for all output lines under 'hard-wrap' policy.
 *   2. Active SGR and OSC 8 hyperlinks are cleanly closed before line breaks and reopened
 *      AFTER continuation prefixes so prefixes are never styled or hyperlinked.
 *   3. No dangling trailing whitespace before line breaks.
 */
export function wrapPrefixedBlock(body: string, options: PrefixedBlockOptions): string[] {
  const { firstPrefix, continuationPrefix, width, longTokenPolicy = 'hard-wrap' } = options;
  if (width <= 0) return [];

  const firstPrefixWidth = measureDisplayWidth(firstPrefix);
  const continuationWidth = measureDisplayWidth(continuationPrefix);

  const firstContentWidth = Math.max(1, width - firstPrefixWidth);
  const continuationContentWidth = Math.max(1, width - continuationWidth);

  const paragraphs = String(body ?? '').split('\n');
  const output: string[] = [];

  let isFirstParagraph = true;

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p] ?? '';
    const tokens = [...scanTerminalTokens(paragraph)];

    if (isFirstParagraph) {
      const wrapped = wrapTokensWithStyleCarry(
        tokens,
        (lineIndex) => (lineIndex === 0 ? firstContentWidth : continuationContentWidth),
        (lineIndex) => (lineIndex === 0 ? firstPrefix : continuationPrefix),
        longTokenPolicy,
      );
      output.push(...wrapped);
      isFirstParagraph = false;
    } else {
      const wrapped = wrapTokensWithStyleCarry(
        tokens,
        () => continuationContentWidth,
        () => continuationPrefix,
        longTokenPolicy,
      );
      output.push(...wrapped);
    }
  }

  return output.length > 0 ? output : [firstPrefix];
}
