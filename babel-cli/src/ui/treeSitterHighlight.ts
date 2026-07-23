/**
 * treeSitterHighlight.ts — Optional tree-sitter syntax highlighting backend.
 *
 * Dynamically loads tree-sitter (if available) to produce ANSI-highlighted
 * code via AST node-type mapping.  Falls back gracefully when tree-sitter or
 * the requested grammar is not installed — callers check availability and
 * revert to the hand-written highlighter in highlight.ts.
 *
 * This module intentionally has no hard dependency on tree-sitter.  All
 * required() calls are wrapped in try-catch so the module loads cleanly even
 * when no tree-sitter packages are present.
 *
 * Node types are mapped to Babel theme colors:
 *   Function/method  → accentBright
 *   Keyword          → primary
 *   String           → success
 *   Comment          → muted
 *   Type/class       → accent
 *   Number           → warning
 *   Identifier/var   → plain (no color)
 */

import { createRequire } from 'node:module';
import { accentBright, primary, success, muted, accent, warning } from './theme.js';

// ─── Module-level state ─────────────────────────────────────────────────────

const _require = createRequire(import.meta.url);

let tsModule: any = null;
let tsAvailable = false;

// Lazily loaded grammar cache: normalized language → compiled grammar object
const grammarCache = new Map<string, any>();

// ─── Dynamic tree-sitter loader ─────────────────────────────────────────────

(function tryLoadCore(): void {
  try {
    tsModule = _require('tree-sitter');
    tsAvailable = true;
  } catch {
    tsAvailable = false;
  }
})();

// ─── Public API ─────────────────────────────────────────────────────────────

/** True when the tree-sitter native module loaded successfully. */
export function isTreeSitterAvailable(): boolean {
  return tsAvailable;
}

/**
 * Return the list of languages for which a tree-sitter grammar was found.
 * Empty array = no grammars installed → every language falls back to the
 * hand-written highlighter.
 */
export function getTreeSitterLanguages(): string[] {
  // Eagerly probe every grammar we know about
  for (const lang of ['typescript', 'javascript', 'python', 'rust', 'go', 'json']) {
    ensureGrammar(lang);
  }
  return [...grammarCache.keys()];
}

/**
 * Highlight `code` with tree-sitter, returning ANSI-styled text.
 *
 * @returns ANSI-highlighted string, or `null` when tree-sitter is unavailable
 *          or the requested language grammar is not installed.
 */
export function highlightWithTreeSitter(code: string, language: string): string | null {
  if (!tsAvailable) return null;

  const normLang = normalizeLanguage(language);
  const grammar = ensureGrammar(normLang);
  if (!grammar) return null;

  try {
    const parser = new tsModule();
    parser.setLanguage(grammar);
    const tree = parser.parse(code);
    const spans: ColorSpan[] = [];

    collectColorSpans(tree.rootNode, code, spans);
    return buildColoredOutput(code, spans);
  } catch {
    return null;
  }
}

// ─── Language normalisation ─────────────────────────────────────────────────

export function normalizeLanguage(lang: string): string {
  const MAP: Record<string, string> = {
    ts: 'typescript',
    typescript: 'typescript',
    js: 'javascript',
    javascript: 'javascript',
    py: 'python',
    python: 'python',
    rs: 'rust',
    rust: 'rust',
    go: 'go',
    golang: 'go',
    json: 'json',
  };
  return MAP[lang.toLowerCase()] ?? '';
}

// ─── Grammar loading ────────────────────────────────────────────────────────

function ensureGrammar(normLang: string): any | null {
  if (!normLang) return null;
  if (grammarCache.has(normLang)) {
    const cached = grammarCache.get(normLang);
    return cached ?? null;
  }

  let grammar: any = null;

  try {
    switch (normLang) {
      case 'typescript': {
        const mod = _require('tree-sitter-typescript');
        grammar = mod?.typescript ?? null;
        break;
      }
      case 'javascript':
        grammar = _require('tree-sitter-javascript');
        break;
      case 'python':
        grammar = _require('tree-sitter-python');
        break;
      case 'rust':
        grammar = _require('tree-sitter-rust');
        break;
      case 'go':
        grammar = _require('tree-sitter-go');
        break;
      case 'json':
        grammar = _require('tree-sitter-json');
        break;
    }
  } catch {
    grammar = null;
  }

  grammarCache.set(normLang, grammar);
  return grammar;
}

// ─── Color span collection (tree traversal) ─────────────────────────────────

interface ColorSpan {
  start: number;
  end: number;
  color: (text: string) => string;
}

function collectColorSpans(node: any, code: string, spans: ColorSpan[]): void {
  const childCount = node.childCount;

  if (childCount > 0) {
    for (let i = 0; i < childCount; i++) {
      const child = node.child(i);
      if (child) collectColorSpans(child, code, spans);
    }
    return;
  }

  // Leaf node — try to assign a colour
  const colorFn = getNodeColor(node);
  if (colorFn) {
    spans.push({ start: node.startIndex, end: node.endIndex, color: colorFn });
  }
}

// ─── Node type → theme colour mapping ───────────────────────────────────────

/** Broad keyword set covering all supported languages.  Used for anonymous
 *  keyword leaf nodes (e.g. `"function"`, `"if"`, `"return"` in the TS
 *  grammar) whose node type IS the keyword text. */
const KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'declare',
  'default',
  'defer',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'extern',
  'false',
  'finally',
  'for',
  'from',
  'fn',
  'func',
  'function',
  'go',
  'goto',
  'if',
  'impl',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'iota',
  'is',
  'lambda',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'new',
  'nil',
  'None',
  'not',
  'null',
  'of',
  'or',
  'package',
  'pass',
  'print',
  'println',
  'private',
  'protected',
  'pub',
  'public',
  'raise',
  'return',
  'select',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unsafe',
  'use',
  'var',
  'void',
  'where',
  'while',
  'with',
  'yield',
]);

function getNodeColor(node: any): ((text: string) => string) | null {
  const type = node.type;
  const isNamed = node.isNamed();

  // Named leaf nodes — type-check against grammar-specific names
  if (isNamed) {
    switch (type) {
      // ── Strings ──
      case 'string':
      case 'string_fragment':
      case 'string_literal':
      case 'template_string':
      case 'interpreted_string_literal':
      case 'raw_string_literal':
      case 'f_string':
      case 'f_string_fragment':
        return success;

      // ── Comments ──
      case 'comment':
      case 'line_comment':
      case 'block_comment':
      case 'doc_comment':
      case 'hash_bang_line':
        return muted;

      // ── Numbers ──
      case 'number':
      case 'integer':
      case 'float':
      case 'decimal':
      case 'real_float_literal':
      case 'escape_sequence':
        return warning;

      // ── Types / classes ──
      case 'type_identifier':
      case 'predefined_type':
      case 'type_parameter':
      case 'class_identifier':
      case 'interface_identifier':
      case 'enum_identifier':
        return accent;

      // ── Functions ──
      case 'function_identifier':
      case 'method_identifier':
      case 'function_name':
      case 'method_name':
        return accentBright;
    }
    return null;
  }

  // Anonymous leaf node — check if it is a keyword
  if (KEYWORDS.has(type)) return primary;

  return null;
}

// ─── Output assembly ────────────────────────────────────────────────────────

function buildColoredOutput(code: string, spans: ColorSpan[]): string {
  if (spans.length === 0) return code;

  // Sort by start position
  spans.sort((a, b) => a.start - b.start);

  // Merge overlapping spans (keep the first / most specific one)
  const merged: ColorSpan[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (!last) {
      merged.push(span);
    } else if (span.start >= last.end) {
      // No overlap
      merged.push(span);
    }
    // Overlapping spans are dropped (the earlier one wins)
  }

  let result = '';
  let pos = 0;

  for (const span of merged) {
    if (pos < span.start) {
      result += code.slice(pos, span.start);
    }
    result += span.color(code.slice(span.start, span.end));
    pos = span.end;
  }

  if (pos < code.length) {
    result += code.slice(pos);
  }

  return result;
}
