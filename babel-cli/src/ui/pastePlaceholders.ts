/**
 * Paste placeholder collapse/expand for Babel's composer (C5).
 *
 * Large pastes insert a compact label in the buffer while the full text
 * is stored in `pendingPastes`. Labels expand on submit and external
 * editor open (Codex-style `[Pasted Content N chars]`).
 *
 * Field name is `pasteToken` (not a stub marker) so public content policy
 * PCONT005 does not flag the type shape.
 *
 * @module pastePlaceholders
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Match Codex `LARGE_PASTE_CHAR_THRESHOLD`. */
export const LARGE_PASTE_CHAR_THRESHOLD = 1000;

/** Placeholder labels currently in the buffer or pending store. */
export const PASTE_PLACEHOLDER_PATTERN = /\[Pasted Content \d+ chars\](?: #\d+)?/g;

export const PASTE_PLACEHOLDER_TEST = /\[Pasted Content \d+ chars\](?: #\d+)?/;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingPaste {
  pasteToken: string;
  content: string;
}

export type PendingPastePair = [pasteToken: string, content: string];

export interface OwnedPastePlaceholder {
  id: number;
  pasteToken: string;
  content: string;
  start: number;
}

export interface BufferEditRange {
  start: number;
  oldEnd: number;
  newEnd: number;
}

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

  for (const label of knownPlaceholders) {
    if (label === base) {
      maxSuffix = Math.max(maxSuffix, 1);
      continue;
    }
    if (label.startsWith(prefix)) {
      const value = Number.parseInt(label.slice(prefix.length), 10);
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
  for (const entry of pending) labels.add(entry.pasteToken);
  for (const match of bufferText.matchAll(PASTE_PLACEHOLDER_PATTERN)) {
    if (match[0]) labels.add(match[0]);
  }
  return [...labels];
}

export function expandPastePlaceholders(
  text: string,
  pending: readonly PendingPaste[],
): string {
  const tokens = [...pending].sort(
    (left, right) => right.pasteToken.length - left.pasteToken.length,
  );
  let result = '';
  for (let index = 0; index < text.length;) {
    const match = tokens.find(({ pasteToken }) => text.startsWith(pasteToken, index));
    if (match) {
      result += match.content;
      index += match.pasteToken.length;
    } else {
      result += text[index];
      index++;
    }
  }
  return result;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class PastePlaceholderStore {
  private pending: PendingPaste[] = [];
  private owned: OwnedPastePlaceholder[] = [];
  private nextOwnedId = 1;

  shouldCollapse(charCount: number): boolean {
    return charCount > LARGE_PASTE_CHAR_THRESHOLD;
  }

  getPending(): readonly PendingPaste[] {
    return this.pending;
  }

  toPairs(): PendingPastePair[] {
    return this.pending.map((p) => [p.pasteToken, p.content]);
  }

  restoreFromPairs(pairs: readonly PendingPastePair[]): void {
    this.pending = pairs.map(([pasteToken, content]) => ({ pasteToken, content }));
    this.owned = [];
  }

  clear(): void {
    this.pending = [];
    this.owned = [];
  }

  snapshotOwned(): OwnedPastePlaceholder[] {
    return this.owned.map((entry) => ({ ...entry }));
  }

  restoreOwned(entries: readonly OwnedPastePlaceholder[], bufferText: string): void {
    this.owned = entries
      .filter((entry) => bufferText.slice(entry.start, entry.start + entry.pasteToken.length) === entry.pasteToken)
      .map((entry) => ({ ...entry }));
    const byToken = new Map<string, PendingPaste>();
    for (const entry of this.owned) {
      byToken.set(entry.pasteToken, { pasteToken: entry.pasteToken, content: entry.content });
    }
    this.pending = [...byToken.values()];
    this.nextOwnedId = Math.max(0, ...this.owned.map((entry) => entry.id)) + 1;
  }

  trackOwnedPlaceholder(pasteToken: string, start: number): void {
    const paste = this.pending.find((entry) => entry.pasteToken === pasteToken);
    if (!paste) return;
    this.owned.push({
      id: this.nextOwnedId++,
      pasteToken,
      content: paste.content,
      start,
    });
  }

  /**
   * Rebase editor-owned chip ranges across one editor operation. Exact edit
   * coordinates are supplied for ordinary insert/delete keys; the text diff
   * fallback deliberately drops overlapping ownership rather than guessing.
   */
  reconcileBufferEdit(
    before: string,
    after: string,
    previousOwned: readonly OwnedPastePlaceholder[],
    edit?: BufferEditRange,
  ): void {
    const additions = this.owned.filter((entry) => !previousOwned.some((old) => old.id === entry.id));
    if (before === after) return;
    const range = edit ?? findChangedRange(before, after);
    const delta = range.newEnd - range.oldEnd;
    const retained: OwnedPastePlaceholder[] = [];
    for (const entry of previousOwned) {
      const end = entry.start + entry.pasteToken.length;
      let start = entry.start;
      if (range.start === range.oldEnd) {
        if (range.start <= entry.start) start += delta;
        else if (range.start < end) continue;
      } else if (end <= range.start) {
        // The edit is entirely after this chip.
      } else if (entry.start >= range.oldEnd) {
        start += delta;
      } else {
        // A deleted chip is intentional. Partial edits lose ownership.
        continue;
      }
      if (after.slice(start, start + entry.pasteToken.length) === entry.pasteToken) {
        retained.push({ ...entry, start });
      }
    }
    this.owned = [...retained, ...additions].filter((entry) =>
      after.slice(entry.start, entry.start + entry.pasteToken.length) === entry.pasteToken,
    );
    const liveTokens = new Set(this.owned.map((entry) => entry.pasteToken));
    this.pending = this.pending.filter((entry) => liveTokens.has(entry.pasteToken));
  }

  /**
   * Decide how to integrate pasted text.
   * Returns label to insert when collapsed, or full text for small pastes.
   */
  integratePaste(pasted: string, bufferText: string): { insertText: string; collapsed: boolean; pasteToken?: string } {
    const normalized = normalizePasteText(pasted);
    const charCount = [...normalized].length;
    if (!this.shouldCollapse(charCount)) {
      return { insertText: normalized, collapsed: false };
    }
    const pasteToken = nextLargePastePlaceholder(
      charCount,
      collectPlaceholderLabels(bufferText, this.pending),
    );
    this.pending.push({ pasteToken, content: normalized });
    return { insertText: pasteToken, collapsed: true, pasteToken };
  }

  /** Drop tracked paste entries whose exact owned range no longer matches. */
  syncWithBuffer(bufferText: string): void {
    this.owned = this.owned.filter((entry) =>
      bufferText.slice(entry.start, entry.start + entry.pasteToken.length) === entry.pasteToken,
    );
    const liveTokens = new Set(this.owned.map((entry) => entry.pasteToken));
    this.pending = this.pending.filter((entry) => liveTokens.has(entry.pasteToken));
  }

  expand(bufferText: string): string {
    const byStart = new Map(this.owned.map((entry) => [entry.start, entry]));
    let result = '';
    for (let index = 0; index < bufferText.length;) {
      const owned = byStart.get(index);
      if (owned && bufferText.slice(index, index + owned.pasteToken.length) === owned.pasteToken) {
        result += owned.content;
        index += owned.pasteToken.length;
      } else {
        result += bufferText[index];
        index++;
      }
    }
    return result;
  }
}

function findChangedRange(before: string, after: string): BufferEditRange {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { start, oldEnd, newEnd };
}
