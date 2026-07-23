/**
 * ComposerHistory — dual-layer input history for Babel's composer (C4).
 *
 * Combines persistent cross-session entries (text-only, loaded at session start)
 * with rich in-session entries (full draft text + paste placeholder metadata).
 *
 * Offset space matches Codex `ChatComposerHistory`: persistent indices come first,
 * session submissions append at the end. New session submissions do not mutate the
 * in-memory persistent layer — they are persisted to disk separately on save.
 *
 * @module composerHistory
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type HistoryLayer = 'persistent' | 'session';

export interface ComposerHistoryEntry {
  text: string;
  layer: HistoryLayer;
  /** Session metadata — e.g. `pendingPastes` for C5 placeholder recall. */
  meta?: Record<string, unknown>;
}

// ── ComposerHistory ───────────────────────────────────────────────────────────

export class ComposerHistory {
  private persistent: ComposerHistoryEntry[] = [];
  private session: ComposerHistoryEntry[] = [];
  private cursor: number | null = null;
  private lastRecalledText: string | null = null;

  /** Load cross-session history (oldest → newest). */
  setPersistentEntries(texts: readonly string[]): void {
    this.persistent = texts
      .filter((t) => t.trim().length > 0)
      .map((text) => ({ text, layer: 'persistent' as const }));
    this.cursor = null;
    this.lastRecalledText = null;
  }

  totalEntries(): number {
    return this.persistent.length + this.session.length;
  }

  isBrowsing(): boolean {
    return this.cursor !== null;
  }

  getLastRecalledText(): string | null {
    return this.lastRecalledText;
  }

  /**
   * Whether Up/Down should traverse history instead of moving the cursor.
   * Empty buffer always qualifies; non-empty requires an exact match with the
   * last recalled entry and the cursor at a buffer boundary (start or end).
   */
  shouldHandleNavigation(text: string, cursorOffset: number): boolean {
    if (this.totalEntries() === 0) return false;
    if (text.length === 0) return true;
    if (cursorOffset !== 0 && cursorOffset !== text.length) return false;
    return this.lastRecalledText === text;
  }

  /** Record a submission from the current session (rich layer). */
  recordSessionSubmission(text: string, meta?: Record<string, unknown>): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    this.resetNavigation();
    const entry: ComposerHistoryEntry = meta
      ? { text: trimmed, layer: 'session', meta }
      : { text: trimmed, layer: 'session' };
    if (this.session.at(-1)?.text === trimmed) return false;
    this.session.push(entry);
    return true;
  }

  /** Move toward older entries; returns null when already at the oldest. */
  navigateOlder(): ComposerHistoryEntry | null {
    const total = this.totalEntries();
    if (total === 0) return null;

    let nextIdx =
      this.cursor === null ? total - 1 : this.cursor <= 0 ? -1 : this.cursor - 1;
    if (nextIdx < 0) return null;

    nextIdx = this.skipPersistentDuplicates(nextIdx, -1);
    if (nextIdx < 0) return null;

    this.cursor = nextIdx;
    const entry = this.entryAt(nextIdx);
    if (entry) this.lastRecalledText = entry.text;
    return entry;
  }

  /**
   * Move toward newer entries.
   * Returns `'past_newest'` when the user moves past the newest known entry.
   */
  navigateNewer(): ComposerHistoryEntry | 'past_newest' | null {
    if (this.cursor === null) return null;
    const total = this.totalEntries();
    if (this.cursor >= total - 1) {
      this.resetNavigation();
      return 'past_newest';
    }

    let nextIdx = this.cursor + 1;
    nextIdx = this.skipPersistentDuplicates(nextIdx, 1);
    if (nextIdx >= total) {
      this.resetNavigation();
      return 'past_newest';
    }

    this.cursor = nextIdx;
    const entry = this.entryAt(nextIdx);
    if (entry) this.lastRecalledText = entry.text;
    return entry;
  }

  resetNavigation(): void {
    this.cursor = null;
    this.lastRecalledText = null;
  }

  /** All entry texts for autocomplete and reverse search (persistent then session, deduped). */
  getAllTexts(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of [...this.persistent, ...this.session]) {
      if (!seen.has(entry.text)) {
        seen.add(entry.text);
        out.push(entry.text);
      }
    }
    return out;
  }

  /** Newest-last list for persistence (includes session submissions this run). */
  getTextsForPersistence(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of [...this.persistent, ...this.session]) {
      if (!seen.has(entry.text)) {
        seen.add(entry.text);
        out.push(entry.text);
      }
    }
    return out;
  }

  getPersistentTexts(): string[] {
    return this.persistent.map((e) => e.text);
  }

  getSessionTexts(): string[] {
    return this.session.map((e) => e.text);
  }

  getSessionEntries(): readonly ComposerHistoryEntry[] {
    return this.session;
  }

  private entryAt(index: number): ComposerHistoryEntry | null {
    if (index < 0 || index >= this.totalEntries()) return null;
    if (index < this.persistent.length) {
      return this.persistent[index] ?? null;
    }
    return this.session[index - this.persistent.length] ?? null;
  }

  /** Skip persistent entries whose text already exists in the session layer. */
  private skipPersistentDuplicates(start: number, direction: -1 | 1): number {
    let idx = start;
    const total = this.totalEntries();
    while (idx >= 0 && idx < total && idx < this.persistent.length) {
      const entry = this.entryAt(idx);
      if (!entry || !this.session.some((s) => s.text === entry.text)) {
        return idx;
      }
      const next = idx + direction;
      if (next < 0 || next >= total) return direction < 0 ? -1 : total;
      idx = next;
    }
    return idx;
  }
}