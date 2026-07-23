/**
 * Paste placeholder collapse/expand for Babel's composer (C5).
 *
 * Large pastes insert a compact placeholder in the buffer while the full text
 * is stored in `pendingPastes`. Placeholders expand on submit and external
 * editor open (Codex-style `[Pasted Content N chars]`).
 *
 * @module pastePlaceholders
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Match Codex `LARGE_PASTE_CHAR_THRESHOLD`. */
export const LARGE_PASTE_CHAR_THRESHOLD = 1000;

/** Placeholder labels currently in the buffer or pending store. */
export const PASTE_PLACEHOLDER_PATTERN = /\[Pasted Content \d+ chars(?: #\d+)?\]/g;

export const PASTE_PLACEHOLDER_TEST = /\[Pasted Content \d+ chars(?: #\d+)?\]/;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingPaste {
  placeholder: string;
  content: string;
}

export type PendingPastePair = [placeholder: string, content: string];

// ── Helpers ───────────────────────────────────────────────────────────────────

export function normalizePasteText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function formatPastePlaceholder(charCount: number, suffix?: number): string {
  const base = `[Pasted Content ${charCount} chars]`;
  return suffix ? `${base} #${suffix}` : base;
}

/** Allocate the next placeholder label for a paste of `charCount` chars. */
export function nextLargePastePlaceholder(
  charCount: number,
  knownPlaceholders: readonly string[],
): string {
  const base = formatPastePlaceholder(charCount);
  const prefix = `${base} #`;
  let maxSuffix = 0;

  for (const placeholder of knownPlaceholders) {
    if (placeholder === base) {
      maxSuffix = Math.max(maxSuffix, 1);
      continue;
    }
    if (placeholder.startsWith(prefix)) {
      const value = Number.parseInt(placeholder.slice(prefix.length), 10);
      if (!Number.isNaN(value)) maxSuffix = Math.max(maxSuffix, value);
    }
  }

  return maxSuffix === 0 ? base : formatPastePlaceholder(charCount, maxSuffix + 1);
}

export function collectPlaceholderLabels(
  bufferText: string,
  pending: readonly PendingPaste[],
): string[] {
  const labels = new Set<string>();
  for (const entry of pending) labels.add(entry.placeholder);
  for (const match of bufferText.matchAll(PASTE_PLACEHOLDER_PATTERN)) {
    if (match[0]) labels.add(match[0]);
  }
  return [...labels];
}

export function expandPastePlaceholders(
  text: string,
  pending: readonly PendingPaste[],
): string {
  let result = text;
  for (const { placeholder, content } of pending) {
    if (result.includes(placeholder)) {
      result = result.split(placeholder).join(content);
    }
  }
  return result;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class PastePlaceholderStore {
  private pending: PendingPaste[] = [];

  shouldCollapse(charCount: number): boolean {
    return charCount > LARGE_PASTE_CHAR_THRESHOLD;
  }

  getPending(): readonly PendingPaste[] {
    return this.pending;
  }

  toPairs(): PendingPastePair[] {
    return this.pending.map((p) => [p.placeholder, p.content]);
  }

  restoreFromPairs(pairs: readonly PendingPastePair[]): void {
    this.pending = pairs.map(([placeholder, content]) => ({ placeholder, content }));
  }

  clear(): void {
    this.pending = [];
  }

  /**
   * Decide how to integrate pasted text.
   * Returns placeholder to insert when collapsed, or full text for small pastes.
   */
  integratePaste(pasted: string, bufferText: string): { insertText: string; collapsed: boolean } {
    const normalized = normalizePasteText(pasted);
    const charCount = [...normalized].length;
    if (!this.shouldCollapse(charCount)) {
      return { insertText: normalized, collapsed: false };
    }
    const placeholder = nextLargePastePlaceholder(
      charCount,
      collectPlaceholderLabels(bufferText, this.pending),
    );
    this.pending.push({ placeholder, content: normalized });
    return { insertText: placeholder, collapsed: true };
  }

  /** Drop pending entries whose placeholder no longer appears in the buffer. */
  syncWithBuffer(bufferText: string): void {
    this.pending = this.pending.filter((p) => bufferText.includes(p.placeholder));
  }

  expand(bufferText: string): string {
    return expandPastePlaceholders(bufferText, this.pending);
  }
}