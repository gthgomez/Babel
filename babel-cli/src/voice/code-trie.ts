/**
 * CodeTrie — Local prefix trie for instant client-side snippet expansion.
 *
 * Bypasses LLM latency entirely for known expansions. When the user dictates
 * a phrase that matches a trie key, the expansion is inserted directly into
 * the PromptInput without waiting for the LLM refinement pass.
 *
 * Examples:
 *   "camel case"   → "camelCase"
 *   "snake case"   → "snake_case"
 *   "typescript"   → "TypeScript"
 *   "open telemetry" → "OpenTelemetry"
 *
 * Thread-safe: read-only after construction. Updates replace the entire trie
 * (construction is sub-millisecond for typical <1000 entry tries).
 *
 * @module voice/code-trie
 */

import type { TrieNode, TrieConfig } from './types.js';

// ── CodeTrie ────────────────────────────────────────────────────────────────

export class CodeTrie {
  private root: TrieNode;
  private _size = 0;

  constructor() {
    this.root = { children: new Map(), expansion: null };
  }

  /** Number of entries in the trie. */
  get size(): number {
    return this._size;
  }

  // ── Mutation ────────────────────────────────────────────────────────────

  /**
   * Insert a key → expansion mapping.
   *
   * Keys are normalised to lowercase before insertion.
   * If the key already exists, its expansion is overwritten.
   */
  insert(key: string, expansion: string): void {
    const normalised = key.toLowerCase().trim();
    if (!normalised) return;

    let node = this.root;
    for (const char of normalised) {
      let child = node.children.get(char);
      if (!child) {
        child = { children: new Map(), expansion: null };
        node.children.set(char, child);
      }
      node = child;
    }

    if (node.expansion === null) {
      this._size++;
    }
    node.expansion = expansion;
  }

  /**
   * Remove a key from the trie.
   * Does NOT compact the trie (lazy deletion — marks the terminal node).
   */
  remove(key: string): boolean {
    const normalised = key.toLowerCase().trim();
    if (!normalised) return false;

    let node = this.root;
    for (const char of normalised) {
      const child = node.children.get(char);
      if (!child) return false;
      node = child;
    }

    if (node.expansion !== null) {
      node.expansion = null;
      this._size--;
      return true;
    }
    return false;
  }

  // ── Lookup ───────────────────────────────────────────────────────────────

  /**
   * Search for the longest prefix match in the input text.
   *
   * Searches from the END of the text (most recent words) backward, finding
   * the longest matching phrase. This handles natural dictation where the
   * trigger phrase appears at the end of the utterance.
   *
   * @returns The match with its expansion, or null if nothing matched.
   */
  searchLongestMatch(text: string): { key: string; expansion: string } | null {
    if (!text) return null;

    const words = text.toLowerCase().split(/\s+/);
    let bestMatch: { key: string; expansion: string } | null = null;

    // Try every possible starting word position
    for (let start = 0; start < words.length; start++) {
      let node: TrieNode | undefined = this.root;
      let matched = '';
      const matchedWords: string[] = [];

      for (let pos = start; pos < words.length; pos++) {
        const word = words[pos] ?? '';
        let matchedChars = 0;

        for (const char of word) {
          node = node?.children.get(char);
          if (!node) break;
          matched += char;
          matchedChars++;
        }

        if (!node || matchedChars < word.length) break;

        matchedWords.push(word);

        if (node.expansion !== null) {
          const key = matchedWords.join(' ');
          // Prefer longer matches
          if (!bestMatch || key.length > bestMatch.key.length) {
            bestMatch = { key, expansion: node.expansion };
          }
        }

        // Add space between words for multi-word keys
        matched += ' ';
        // Try to traverse space character
        const spaceNode = node.children.get(' ');
        if (!spaceNode && pos < words.length - 1) break;
        node = spaceNode;
      }
    }

    return bestMatch;
  }

  /**
   * Find the expansion for an exact key match.
   * Returns null if the key is not in the trie.
   */
  lookup(key: string): string | null {
    const normalised = key.toLowerCase().trim();
    if (!normalised) return null;

    let node: TrieNode | undefined = this.root;
    for (const char of normalised) {
      node = node?.children.get(char);
      if (!node) return null;
    }

    return node.expansion;
  }

  /**
   * Get all completions for a given prefix, sorted by key length (shortest first).
   */
  findCompletions(prefix: string): Array<{ key: string; expansion: string }> {
    const normalised = prefix.toLowerCase().trim();
    if (!normalised) return [];

    // Walk to the prefix node
    let node: TrieNode | undefined = this.root;
    for (const char of normalised) {
      node = node?.children.get(char);
      if (!node) return [];
    }

    // Collect all terminal descendants
    const results: Array<{ key: string; expansion: string }> = [];
    this.collectEntries(node, normalised, results);
    results.sort((a, b) => a.key.length - b.key.length);
    return results;
  }

  private collectEntries(
    node: TrieNode,
    currentKey: string,
    results: Array<{ key: string; expansion: string }>,
  ): void {
    if (node.expansion !== null) {
      results.push({ key: currentKey, expansion: node.expansion });
    }
    for (const [char, child] of node.children) {
      this.collectEntries(child, currentKey + char, results);
    }
  }

  // ── Serialisation ────────────────────────────────────────────────────────

  /** Bulk-load entries from a JSON config. */
  static fromConfig(config: TrieConfig): CodeTrie {
    const trie = new CodeTrie();
    for (const entry of config.entries) {
      trie.insert(entry.key, entry.expansion);
    }
    return trie;
  }

  /** Serialise to JSON for persistence. */
  toConfig(): TrieConfig {
    const entries: Array<{ key: string; expansion: string }> = [];
    this.collectConfigEntries(this.root, '', entries);
    return { entries };
  }

  private collectConfigEntries(
    node: TrieNode,
    currentKey: string,
    entries: Array<{ key: string; expansion: string }>,
  ): void {
    if (node.expansion !== null) {
      entries.push({ key: currentKey, expansion: node.expansion });
    }
    for (const [char, child] of node.children) {
      this.collectConfigEntries(child, currentKey + char, entries);
    }
  }

  // ── Built-in vocabulary ──────────────────────────────────────────────────

  /**
   * Create a trie pre-loaded with Babel's default technical vocabulary.
   * Covers TypeScript/JavaScript keywords, Babel API surface, and common
   * code patterns that STT engines frequently mis-transcribe.
   */
  static createDefault(): CodeTrie {
    const trie = new CodeTrie();

    // ── Code casing patterns ─────────────────────────────────────────
    trie.insert('camel case', 'camelCase');
    trie.insert('camelcase', 'camelCase');
    trie.insert('snake case', 'snake_case');
    trie.insert('snakecase', 'snake_case');
    trie.insert('kebab case', 'kebab-case');
    trie.insert('kebabcase', 'kebab-case');
    trie.insert('pascal case', 'PascalCase');
    trie.insert('pascalcase', 'PascalCase');

    // ── Language names ────────────────────────────────────────────────
    trie.insert('typescript', 'TypeScript');
    trie.insert('type script', 'TypeScript');
    trie.insert('javascript', 'JavaScript');
    trie.insert('java script', 'JavaScript');
    trie.insert('node js', 'Node.js');
    trie.insert('nodejs', 'Node.js');
    trie.insert('rust', 'Rust');
    trie.insert('golang', 'Go');

    // ── TypeScript keywords ───────────────────────────────────────────
    for (const kw of [
      'interface',
      'type',
      'const',
      'let',
      'async',
      'await',
      'export',
      'import',
      'extends',
      'implements',
      'readonly',
      'Promise',
      'Map',
      'Set',
      'Array',
    ]) {
      trie.insert(kw, kw);
    }

    // ── Babel API surface ─────────────────────────────────────────────
    for (const api of [
      'set text',
      'insert text',
      'get state',
      'prompt input',
      'frame scheduler',
      'output buffer',
      'state mutation bus',
      'component',
    ]) {
      // Map spoken form to actual API name
      const spokenToApi: Record<string, string> = {
        'set text': 'setText',
        'insert text': 'insertText',
        'get state': 'getState',
        'prompt input': 'PromptInput',
        'frame scheduler': 'FrameScheduler',
        'output buffer': 'OutputBuffer',
        'state mutation bus': 'StateMutationBus',
        component: 'Component',
      };
      trie.insert(api, spokenToApi[api] ?? api);
    }

    // ── Common code patterns ──────────────────────────────────────────
    for (const pat of [
      'for each',
      'map',
      'filter',
      'reduce',
      'then',
      'catch',
      'finally',
      'spread operator',
      'destructure',
      'arrow function',
      'async function',
      'string literal',
    ]) {
      trie.insert(pat, pat);
    }

    // ── Observability / infrastructure terms ──────────────────────────
    trie.insert('open telemetry', 'OpenTelemetry');
    trie.insert('OTLP', 'OTLP');
    trie.insert('shared array buffer', 'SharedArrayBuffer');
    trie.insert('web socket', 'WebSocket');
    trie.insert('websocket', 'WebSocket');
    trie.insert('NDJSON', 'NDJSON');
    trie.insert('N-D-JSON', 'NDJSON');

    return trie;
  }
}
