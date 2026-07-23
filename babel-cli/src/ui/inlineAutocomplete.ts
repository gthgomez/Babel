/**
 * InlineAutocomplete — ghost-text inline completion engine for Babel's TUI.
 *
 * Provides inline suggestions as the user types, based on:
 *   1. History matching (always available, works offline)
 *   2. Optional AI provider (debounced, with timeout)
 *
 * This module is pure business logic — it does no terminal rendering.
 * Rendering the ghost text is the caller's responsibility. The caller
 * (typically PromptInput) renders the ghost suffix dimmed after the cursor
 * and calls accept() on Tab or Right arrow.
 *
 * Usage:
 *   const ac = new InlineAutocomplete({ aiProvider: myProvider });
 *   const completion = ac.suggest('deplo', 'deplo\nsome\nlines', 5);
 *   if (completion) {
 *     // render ac.getGhostText() dimmed after cursor
 *   }
 *   // On Tab/Right:
 *   const suffix = ac.accept(); // returns "y.sh --prod" to insert
 *
 * @module inlineAutocomplete
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InlineCompletion {
  /** The full suggested line text */
  text: string;
  /** The prefix this completion is based on */
  prefix: string;
  /** Source of the suggestion */
  source: 'history' | 'ai' | 'lsp';
}

export interface InlineAutocompleteConfig {
  /** Max completions to keep in cache (default 50) */
  maxCacheSize?: number;
  /** Debounce delay in ms before fetching AI completions (default 150) */
  debounceMs?: number;
  /** Called to fetch AI completions — receives the current prefix and full
   *  multi-line context. Should return the full suggested line, or null. */
  aiProvider?: (prefix: string, context: string) => Promise<string | null>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CACHE_SIZE = 50;
const DEFAULT_DEBOUNCE_MS = 150;
const AI_TIMEOUT_MS = 2000;

// ── InlineAutocomplete ────────────────────────────────────────────────────────

export class InlineAutocomplete {
  private config: {
    maxCacheSize: number;
    debounceMs: number;
    aiProvider: (prefix: string, context: string) => Promise<string | null>;
  };
  private history: string[] = [];
  private cache: Map<string, InlineCompletion> = new Map();
  private currentSuggestion: InlineCompletion | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private aiPending = false;

  constructor(config?: InlineAutocompleteConfig) {
    this.config = {
      maxCacheSize: config?.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE,
      debounceMs: config?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      aiProvider: config?.aiProvider ?? (() => Promise.resolve(null)),
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Feed the current input state — returns a completion if available.
   *
   * Evaluates history matches synchronously and schedules an AI fetch
   * behind a debounce if an aiProvider is configured. AI results, once
   * available, override history suggestions for the same prefix.
   *
   * @param currentLine - The current line being edited
   * @param fullText    - The full multi-line text buffer
   * @param cursorCol   - Cursor column position on the current line (0-based)
   * @returns An InlineCompletion if a suggestion is available, null otherwise
   */
  suggest(currentLine: string, fullText: string, cursorCol: number): InlineCompletion | null {
    const prefix = currentLine.slice(0, cursorCol);
    if (!prefix) {
      this.dismiss();
      return null;
    }

    // Kick off debounced AI fetch if provider is configured (fire-and-forget)
    this.scheduleAiCompletion(prefix, fullText);

    // Check cache for a previously fetched AI result for this prefix first,
    // since AI results override history suggestions for the same prefix
    const cached = this.cache.get(prefix);
    if (cached && cached.source === 'ai') {
      this.currentSuggestion = cached;
      return cached;
    }

    // Fall back to history-based completion (always available, synchronous)
    const historyMatch = this.findHistoryCompletion(prefix);
    if (historyMatch) {
      this.currentSuggestion = historyMatch;
      return historyMatch;
    }

    this.currentSuggestion = null;
    return null;
  }

  /**
   * Accept the current suggestion.
   * Returns the text to insert (the suffix after the prefix), or null if
   * no suggestion is active.
   */
  accept(): string | null {
    if (!this.currentSuggestion) return null;
    const suffix = this.extractSuffix(this.currentSuggestion);
    this.currentSuggestion = null;
    return suffix;
  }

  /** Dismiss the current suggestion without accepting. */
  dismiss(): void {
    this.currentSuggestion = null;
  }

  /** Whether a suggestion is currently active. */
  hasSuggestion(): boolean {
    return this.currentSuggestion !== null;
  }

  /**
   * Get the current suggestion text for rendering.
   * Returns only the portion that should appear dimmed after the cursor
   * (the suffix after the prefix), or null if no suggestion is active.
   */
  getGhostText(): string | null {
    if (!this.currentSuggestion) return null;
    return this.extractSuffix(this.currentSuggestion);
  }

  /** Add a history entry for future suggestions. */
  addHistoryEntry(text: string): void {
    if (!text.trim()) return;
    this.history.push(text);
  }

  /** Clear the suggestion cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Extract the suffix (portion after the prefix) from a completion.
   * If the completion text doesn't actually start with the prefix, returns
   * the full text as a fallback.
   */
  private extractSuffix(completion: InlineCompletion): string {
    if (completion.text.startsWith(completion.prefix)) {
      return completion.text.slice(completion.prefix.length);
    }
    return completion.text;
  }

  // ── History-based completion ─────────────────────────────────────────────

  /**
   * Find the best history completion for the given prefix.
   *
   * Searches history for entries starting with the prefix, then picks the
   * most frequent one. Ties are broken by most-recently-used (last in the
   * history array wins).
   */
  private findHistoryCompletion(prefix: string): InlineCompletion | null {
    if (this.history.length === 0) return null;

    // Collect all history entries that start with the prefix and are longer
    const matches: Array<{ text: string; index: number }> = [];
    for (let i = 0; i < this.history.length; i++) {
      const entry = this.history[i]!;
      if (entry.startsWith(prefix) && entry.length > prefix.length) {
        matches.push({ text: entry, index: i });
      }
    }

    if (matches.length === 0) return null;

    // Count frequency of each matching text
    const freq = new Map<string, number>();
    for (const m of matches) {
      freq.set(m.text, (freq.get(m.text) ?? 0) + 1);
    }

    // Pick the most frequent match; ties broken by most recent (highest index)
    let best: (typeof matches)[number] | null = null;
    for (const m of matches) {
      const count = freq.get(m.text) ?? 0;
      if (
        best === null ||
        count > (freq.get(best.text) ?? 0) ||
        (count === (freq.get(best.text) ?? 0) && m.index > best.index)
      ) {
        best = m;
      }
    }

    if (!best) return null;

    return {
      text: best.text,
      prefix,
      source: 'history',
    };
  }

  // ── AI completion ─────────────────────────────────────────────────────────

  /**
   * Schedule an AI completion fetch with debounce.
   * Cancels any pending debounce timer so rapid typing doesn't flood the
   * AI provider.
   */
  private scheduleAiCompletion(prefix: string, fullText: string): void {
    if (!this.config.aiProvider) return;

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.fetchAiCompletion(prefix, fullText);
    }, this.config.debounceMs);
  }

  /**
   * Fetch AI completion with timeout.
   * Stores the result in cache so the next suggest() call with the same
   * prefix can pick it up. If a history suggestion is still active for the
   * same prefix, the AI result overrides it.
   */
  private async fetchAiCompletion(prefix: string, fullText: string): Promise<void> {
    if (this.aiPending) return;
    this.aiPending = true;

    try {
      const result = await this.withTimeout(
        this.config.aiProvider(prefix, fullText),
        AI_TIMEOUT_MS,
      );

      if (result && result.length > prefix.length) {
        const completion: InlineCompletion = {
          text: result,
          prefix,
          source: 'ai',
        };

        this.addToCache(prefix, completion);

        // If the current suggestion is still for the same prefix, promote
        // the AI result (AI overrides history for the same prefix)
        if (this.currentSuggestion && this.currentSuggestion.prefix === prefix) {
          this.currentSuggestion = completion;
        }
      }
    } catch {
      // Silently fail — AI errors must never block the UI
    } finally {
      this.aiPending = false;
    }
  }

  /**
   * Add a completion to the LRU-ish cache.
   * Evicts the oldest entry when the cache exceeds maxCacheSize.
   */
  private addToCache(prefix: string, completion: InlineCompletion): void {
    if (this.cache.size >= this.config.maxCacheSize) {
      const firstKey = this.cache.keys().next();
      if (!firstKey.done && firstKey.value !== undefined) {
        this.cache.delete(firstKey.value);
      }
    }
    this.cache.set(prefix, completion);
  }

  /**
   * Wrap a promise with a timeout rejection.
   * If the promise doesn't settle within `ms`, the returned promise rejects.
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI completion timeout')), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
