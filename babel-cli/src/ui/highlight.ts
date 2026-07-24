/**
 * highlight.ts — ANSI syntax highlighting for code blocks + markdown-to-ANSI.
 *
 * Uses the `marked` library's lexer to produce an AST, then walks the token
 * tree to emit ANSI-styled terminal output. Fenced code blocks are syntax-
 * highlighted via per-language keyword/type sets.
 *
 * An optional tree-sitter backend (treeSitterHighlight.ts) is consulted first
 * when available — `highlightLine()` prefers tree-sitter by default and falls
 * back to the hand-written regex-based highlighter gracefully.
 */

import { marked } from 'marked';
// marked v16+ exports Token and Tokens at the top level. We use dynamic
// type imports via the constructor to avoid namespace-as-type issues.
type MdToken = ReturnType<typeof marked.lexer>[number];
type MdTokens = any; // namespace not usable as type in TS 5.x with ESM
import {
  supportsColor,
  bold,
  dim,
  muted,
  info,
  accentBright,
  primary,
  success,
  error,
  ghost,
  getTerminalWidth,
} from './theme.js';
import { sanitizeLlmOutput, sanitizeCodeLine } from './sanitize.js';
import { isTreeSitterAvailable, highlightWithTreeSitter } from './treeSitterHighlight.js';
const HAS_COLOR = supportsColor();
const ANSI_ITALIC_OPEN = '\x1b[3m';
const ANSI_ITALIC_CLOSE = '\x1b[23m';

// ─── ANSI codes ───────────────────────────────────────────────────────────────

const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ─── Token patterns ───────────────────────────────────────────────────────────

const TS_KEYWORDS = new Set([
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
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield',
]);

const TS_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'void',
  'never',
  'any',
  'unknown',
  'Promise',
  'Array',
  'Map',
  'Set',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'NonNullable',
  'ReturnType',
  'Parameters',
  'ConstructorParameters',
  'InstanceType',
]);

const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'self',
  'print',
]);

const PY_TYPES = new Set([
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'bytes',
  'bytearray',
  'memoryview',
  'Optional',
  'Union',
  'Any',
  'Callable',
  'Iterable',
  'Sequence',
  'Mapping',
  'Literal',
  'TypedDict',
  'Type',
]);

const RS_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'yield',
]);

const RS_TYPES = new Set([
  'bool',
  'char',
  'f32',
  'f64',
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'str',
  'String',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
  'Vec',
  'Option',
  'Result',
  'HashMap',
  'HashSet',
  'Box',
  'Rc',
  'Arc',
  'Cell',
  'RefCell',
  'Cow',
  'Path',
  'PathBuf',
]);

const GO_KEYWORDS = new Set([
  'break',
  'case',
  'chan',
  'const',
  'continue',
  'default',
  'defer',
  'else',
  'fallthrough',
  'for',
  'func',
  'go',
  'goto',
  'if',
  'import',
  'interface',
  'map',
  'package',
  'range',
  'return',
  'select',
  'struct',
  'switch',
  'type',
  'var',
  'nil',
  'true',
  'false',
  'iota',
  'make',
  'new',
  'append',
  'len',
  'cap',
  'copy',
  'delete',
  'close',
  'panic',
  'recover',
  'print',
  'println',
]);

const GO_TYPES = new Set([
  'bool',
  'byte',
  'complex64',
  'complex128',
  'error',
  'float32',
  'float64',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'rune',
  'string',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'any',
  'comparable',
]);

const JSON_TOKENS = new Set(['true', 'false', 'null']);

// ── G1 hybrid: additional regex families ─────────────────────────────────────
// Expand coverage for common fences without bundling syntect/tree-sitter for all.
// Aliases are normalized via normalizeHighlightLang() before the switch.

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
  'in',
  'time',
  'coproc',
  'return',
  'exit',
  'break',
  'continue',
  'declare',
  'local',
  'export',
  'readonly',
  'unset',
  'shift',
  'source',
  'alias',
  'bg',
  'fg',
  'jobs',
  'kill',
  'wait',
  'trap',
  'true',
  'false',
  'test',
  'echo',
  'printf',
  'read',
  'cd',
  'pwd',
  'set',
  'eval',
  'exec',
  'let',
  'typeset',
]);

const SHELL_TYPES = new Set(['stdin', 'stdout', 'stderr']);

const SQL_KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'and',
  'or',
  'not',
  'insert',
  'into',
  'values',
  'update',
  'set',
  'delete',
  'create',
  'table',
  'index',
  'view',
  'drop',
  'alter',
  'add',
  'column',
  'primary',
  'key',
  'foreign',
  'references',
  'unique',
  'null',
  'not',
  'default',
  'check',
  'constraint',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'on',
  'as',
  'order',
  'by',
  'group',
  'having',
  'limit',
  'offset',
  'union',
  'all',
  'distinct',
  'exists',
  'in',
  'between',
  'like',
  'is',
  'case',
  'when',
  'then',
  'else',
  'end',
  'with',
  'recursive',
  'returning',
  'true',
  'false',
  'asc',
  'desc',
  'count',
  'sum',
  'avg',
  'min',
  'max',
]);

const SQL_TYPES = new Set([
  'int',
  'integer',
  'bigint',
  'smallint',
  'serial',
  'text',
  'varchar',
  'char',
  'boolean',
  'bool',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'numeric',
  'decimal',
  'real',
  'double',
  'float',
  'json',
  'jsonb',
  'uuid',
  'bytea',
]);

const JAVA_KEYWORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'try',
  'void',
  'volatile',
  'while',
  'true',
  'false',
  'null',
  'var',
  'yield',
  'record',
  'sealed',
  'permits',
  'non-sealed',
]);

const JAVA_TYPES = new Set([
  'String',
  'Integer',
  'Long',
  'Boolean',
  'Double',
  'Float',
  'Object',
  'List',
  'Map',
  'Set',
  'Optional',
  'Stream',
  'ArrayList',
  'HashMap',
  'HashSet',
]);

const CSHARP_KEYWORDS = new Set([
  'abstract',
  'as',
  'base',
  'bool',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'checked',
  'class',
  'const',
  'continue',
  'decimal',
  'default',
  'delegate',
  'do',
  'double',
  'else',
  'enum',
  'event',
  'explicit',
  'extern',
  'false',
  'finally',
  'fixed',
  'float',
  'for',
  'foreach',
  'goto',
  'if',
  'implicit',
  'in',
  'int',
  'interface',
  'internal',
  'is',
  'lock',
  'long',
  'namespace',
  'new',
  'null',
  'object',
  'operator',
  'out',
  'override',
  'params',
  'private',
  'protected',
  'public',
  'readonly',
  'ref',
  'return',
  'sbyte',
  'sealed',
  'short',
  'sizeof',
  'stackalloc',
  'static',
  'string',
  'struct',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'uint',
  'ulong',
  'unchecked',
  'unsafe',
  'ushort',
  'using',
  'virtual',
  'void',
  'volatile',
  'while',
  'async',
  'await',
  'var',
  'dynamic',
  'nameof',
  'when',
  'yield',
  'record',
  'init',
  'required',
  'noint',
  'nint',
  'nuint',
]);

const CSHARP_TYPES = new Set([
  'string',
  'int',
  'bool',
  'object',
  'List',
  'Dictionary',
  'IEnumerable',
  'Task',
  'Action',
  'Func',
  'Span',
  'ReadOnlySpan',
]);

const RUBY_KEYWORDS = new Set([
  'alias',
  'and',
  'BEGIN',
  'begin',
  'break',
  'case',
  'class',
  'def',
  'defined?',
  'do',
  'else',
  'elsif',
  'END',
  'end',
  'ensure',
  'false',
  'for',
  'if',
  'in',
  'module',
  'next',
  'nil',
  'not',
  'or',
  'redo',
  'rescue',
  'retry',
  'return',
  'self',
  'super',
  'then',
  'true',
  'undef',
  'unless',
  'until',
  'when',
  'while',
  'yield',
  'require',
  'include',
  'extend',
  'attr_reader',
  'attr_writer',
  'attr_accessor',
]);

const RUBY_TYPES = new Set(['String', 'Integer', 'Array', 'Hash', 'Symbol', 'NilClass', 'TrueClass', 'FalseClass']);

const PHP_KEYWORDS = new Set([
  'abstract',
  'and',
  'array',
  'as',
  'break',
  'callable',
  'case',
  'catch',
  'class',
  'clone',
  'const',
  'continue',
  'declare',
  'default',
  'die',
  'do',
  'echo',
  'else',
  'elseif',
  'empty',
  'enddeclare',
  'endfor',
  'endforeach',
  'endif',
  'endswitch',
  'endwhile',
  'eval',
  'exit',
  'extends',
  'final',
  'finally',
  'fn',
  'for',
  'foreach',
  'function',
  'global',
  'goto',
  'if',
  'implements',
  'include',
  'include_once',
  'instanceof',
  'insteadof',
  'interface',
  'isset',
  'list',
  'match',
  'namespace',
  'new',
  'or',
  'print',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'require_once',
  'return',
  'static',
  'switch',
  'throw',
  'trait',
  'try',
  'unset',
  'use',
  'var',
  'while',
  'xor',
  'yield',
  'true',
  'false',
  'null',
]);

const PHP_TYPES = new Set(['string', 'int', 'float', 'bool', 'array', 'object', 'mixed', 'void', 'never', 'iterable']);

const HTML_KEYWORDS = new Set([
  'html',
  'head',
  'body',
  'div',
  'span',
  'script',
  'style',
  'link',
  'meta',
  'title',
  'header',
  'footer',
  'main',
  'nav',
  'section',
  'article',
  'aside',
  'form',
  'input',
  'button',
  'label',
  'select',
  'option',
  'textarea',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'br',
  'hr',
  'strong',
  'em',
  'code',
  'pre',
  'blockquote',
  'svg',
  'path',
  'true',
  'false',
  'null',
]);

const HTML_TYPES = new Set(['class', 'id', 'href', 'src', 'type', 'name', 'value', 'style', 'alt', 'title', 'width', 'height']);

const CSS_KEYWORDS = new Set([
  'important',
  'and',
  'or',
  'not',
  'only',
  'from',
  'to',
  'through',
  'in',
  'var',
  'calc',
  'min',
  'max',
  'clamp',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'url',
  'attr',
  'true',
  'false',
  'inherit',
  'initial',
  'unset',
  'none',
  'auto',
  'block',
  'inline',
  'flex',
  'grid',
  'absolute',
  'relative',
  'fixed',
  'sticky',
  'hidden',
  'visible',
  'solid',
  'dashed',
  'dotted',
]);

const CSS_TYPES = new Set([
  'px',
  'em',
  'rem',
  'vh',
  'vw',
  'vmin',
  'vmax',
  'ch',
  'ex',
  'fr',
  'deg',
  'rad',
  'turn',
  's',
  'ms',
  'Hz',
  'kHz',
  'dpi',
  'dpcm',
  'dppx',
  '%',
]);

const TOML_KEYWORDS = new Set(['true', 'false']);
const TOML_TYPES = new Set([]);

const PS_KEYWORDS = new Set([
  'begin',
  'break',
  'catch',
  'class',
  'continue',
  'data',
  'define',
  'do',
  'dynamicparam',
  'else',
  'elseif',
  'end',
  'exit',
  'filter',
  'finally',
  'for',
  'foreach',
  'from',
  'function',
  'if',
  'in',
  'param',
  'process',
  'return',
  'switch',
  'throw',
  'trap',
  'try',
  'until',
  'using',
  'var',
  'while',
  'workflow',
  'parallel',
  'sequence',
  'inlinescript',
  'configuration',
  'true',
  'false',
  'null',
  'function',
  'filter',
  'workflow',
  'CmdletBinding',
  'Parameter',
  'ValidateNotNull',
  'ValidateSet',
]);

const PS_TYPES = new Set([
  'string',
  'int',
  'long',
  'bool',
  'switch',
  'hashtable',
  'psobject',
  'pscustomobject',
  'array',
  'xml',
  'scriptblock',
  'datetime',
  'guid',
  'version',
  'securestring',
]);

/**
 * Canonical regex-highlighter language families (G1 hybrid).
 * Tree-sitter may still cover a subset with higher quality when available.
 */
export const REGEX_HIGHLIGHT_FAMILIES = [
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'json',
  'yaml',
  'shell',
  'sql',
  'java',
  'csharp',
  'ruby',
  'php',
  'html',
  'css',
  'toml',
  'powershell',
] as const;

export type RegexHighlightFamily = (typeof REGEX_HIGHLIGHT_FAMILIES)[number];

/** Fence / alias → canonical family used by highlightLine. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  py: 'python',
  pyi: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  shellscript: 'shell',
  sql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  java: 'java',
  kt: 'java', // approximate fallback
  kotlin: 'java',
  cs: 'csharp',
  csharp: 'csharp',
  'c#': 'csharp',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  sass: 'css',
  toml: 'toml',
  ps1: 'powershell',
  psm1: 'powershell',
  powershell: 'powershell',
  pwsh: 'powershell',
};

/**
 * Normalize a fence language tag to a canonical highlight family, or '' if unknown.
 */
export function normalizeHighlightLang(lang: string | undefined | null): string {
  if (!lang) return '';
  const key = lang.trim().toLowerCase();
  return LANG_ALIASES[key] ?? '';
}

/**
 * Whether the regex highlighter has keyword sets for this language (after aliasing).
 */
export function isRegexHighlightSupported(lang: string | undefined | null): boolean {
  const canon = normalizeHighlightLang(lang);
  return (REGEX_HIGHLIGHT_FAMILIES as readonly string[]).includes(canon);
}

/** Honest language matrix for docs / tests (G1). */
export function getHighlightLanguageMatrix(): {
  regexFamilies: readonly string[];
  aliases: Record<string, string>;
} {
  return { regexFamilies: REGEX_HIGHLIGHT_FAMILIES, aliases: { ...LANG_ALIASES } };
}

// ─── Highlighting ─────────────────────────────────────────────────────────────

function isInsideString(line: string, pos: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < pos; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
  }
  return inSingle || inDouble || inBacktick;
}

// ── highlightLine per-line cache ──────────────────────────────────────────
// Code block lines are identical across multiple renders (live HUD, snapshot,
// transcript). Cache by content hash to avoid repeated character-by-character
// scanning for strings, identifiers, and keyword/type matches.

const highlightCache = new Map<string, string>();
const HIGHLIGHT_CACHE_MAX = 512;

/** Insert a result into the highlight cache, evicting the oldest entry if full. */
function cacheHighlightResult(key: string, result: string): void {
  if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
    const firstKey = highlightCache.keys().next().value;
    if (firstKey !== undefined) highlightCache.delete(firstKey);
  }
  highlightCache.set(key, result);
}

export function highlightLine(
  line: string,
  lang?: string,
  options?: { preferTreeSitter?: boolean },
): string {
  const opts = { preferTreeSitter: true, ...options };

  // Build cache key: language prefix + sanitized line
  const cacheKey = (lang ?? 'ts') + '|' + sanitizeCodeLine(line);
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Sanitize against escape injection before highlighting
  line = sanitizeCodeLine(line);

  // Try tree-sitter first when enabled and available
  if (opts.preferTreeSitter && isTreeSitterAvailable()) {
    const tsResult = highlightWithTreeSitter(line, lang ?? 'typescript');
    if (tsResult !== null) {
      cacheHighlightResult(cacheKey, tsResult);
      return tsResult;
    }
  }

  let keywords = TS_KEYWORDS;
  let typeSet = TS_TYPES;
  /** Match keywords case-insensitively (SQL and similar). */
  let caseInsensitiveKeywords = false;
  const canon = normalizeHighlightLang(lang) || (lang ? lang.toLowerCase() : '');
  if (canon) {
    switch (canon) {
      case 'python':
        keywords = PY_KEYWORDS;
        typeSet = PY_TYPES;
        break;
      case 'rust':
        keywords = RS_KEYWORDS;
        typeSet = RS_TYPES;
        break;
      case 'go':
        keywords = GO_KEYWORDS;
        typeSet = GO_TYPES;
        break;
      case 'json':
        keywords = JSON_TOKENS;
        typeSet = new Set();
        break;
      case 'yaml': {
        const result = highlightYamlLine(line);
        cacheHighlightResult(cacheKey, result);
        return result;
      }
      case 'shell':
        keywords = SHELL_KEYWORDS;
        typeSet = SHELL_TYPES;
        break;
      case 'sql':
        // SQL keywords are case-insensitive in practice.
        keywords = SQL_KEYWORDS;
        typeSet = SQL_TYPES;
        caseInsensitiveKeywords = true;
        break;
      case 'java':
        keywords = JAVA_KEYWORDS;
        typeSet = JAVA_TYPES;
        break;
      case 'csharp':
        keywords = CSHARP_KEYWORDS;
        typeSet = CSHARP_TYPES;
        break;
      case 'ruby':
        keywords = RUBY_KEYWORDS;
        typeSet = RUBY_TYPES;
        break;
      case 'php':
        keywords = PHP_KEYWORDS;
        typeSet = PHP_TYPES;
        break;
      case 'html':
        keywords = HTML_KEYWORDS;
        typeSet = HTML_TYPES;
        break;
      case 'css':
        keywords = CSS_KEYWORDS;
        typeSet = CSS_TYPES;
        break;
      case 'toml':
        keywords = TOML_KEYWORDS;
        typeSet = TOML_TYPES;
        break;
      case 'powershell':
        keywords = PS_KEYWORDS;
        typeSet = PS_TYPES;
        break;
      case 'typescript':
      case 'javascript':
      default:
        // Keep TS defaults for ts/js and unknown canon that fell through.
        break;
    }
  }
  const commentIdx = line.indexOf('//');
  if (commentIdx >= 0 && !isInsideString(line, commentIdx)) {
    const code = line.slice(0, commentIdx);
    const comment = line.slice(commentIdx);
    const result = highlightLine(code, lang) + DIM + comment + RESET;
    cacheHighlightResult(cacheKey, result);
    return result;
  }
  let result = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end >= 0) {
        result += GREEN + line.slice(i, end + 1) + RESET;
        i = end + 1;
        continue;
      }
    }
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end >= 0) {
        result += GREEN + line.slice(i, end + 1) + RESET;
        i = end + 1;
        continue;
      }
    }
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end >= 0) {
        result += YELLOW + line.slice(i, end + 1) + RESET;
        i = end + 1;
        continue;
      }
    }
    if (/\w/.test(ch)) {
      const start = i;
      while (i < line.length && /\w/.test(line[i] ?? '')) i++;
      const word = line.slice(start, i);
      const lookup = caseInsensitiveKeywords ? word.toLowerCase() : word;
      if (typeSet.has(lookup) || typeSet.has(word)) result += CYAN + word + RESET;
      else if (keywords.has(lookup) || keywords.has(word)) result += BLUE + word + RESET;
      else result += word;
      continue;
    }
    result += line[i];
    i++;
  }

  cacheHighlightResult(cacheKey, result);
  return result;
}

/** Clear the per-line highlight cache (for testing / theme changes). */
export function clearHighlightCache(): void {
  highlightCache.clear();
}

function highlightYamlLine(line: string): string {
  const commentIdx = line.indexOf(' #');
  let code = line;
  let comment = '';
  if (commentIdx >= 0 && !line.slice(0, commentIdx).includes('"')) {
    code = line.slice(0, commentIdx);
    comment = line.slice(commentIdx);
  }
  const kvMatch = code.match(/^(\s*)([\w.-]+)(\s*:)/);
  if (kvMatch) {
    const indent = kvMatch[1] ?? '';
    const key = kvMatch[2] ?? '';
    const colon = kvMatch[3] ?? '';
    const rest = code.slice((indent + key + colon).length);
    const coloredKey = `${indent}${BLUE}${key}${RESET}${colon}`;
    const trimmedRest = rest.trim();
    if (trimmedRest === 'true' || trimmedRest === 'false' || trimmedRest === 'null')
      return coloredKey + ` ${CYAN}${trimmedRest}${RESET}` + comment;
    if (/^-?\d+(\.\d+)?$/.test(trimmedRest))
      return coloredKey + ` ${YELLOW}${trimmedRest}${RESET}` + comment;
    if (trimmedRest.startsWith('"') || trimmedRest.startsWith("'"))
      return coloredKey + ` ${GREEN}${rest}${RESET}` + comment;
    return coloredKey + rest + comment;
  }
  const listMatch = code.match(/^(\s*)(-\s+)(.*)/);
  if (listMatch) {
    const indent = listMatch[1] ?? '';
    const dash = listMatch[2] ?? '';
    const rest = listMatch[3] ?? '';
    return `${indent}${CYAN}${dash}${RESET}${rest}` + comment;
  }
  if (code.trim().startsWith('#')) return DIM + line + RESET;
  return line;
}

export function langFromExtension(filePath: string): string {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const MAP: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    pyi: 'python',
    rs: 'rust',
    go: 'go',
    json: 'json',
    jsonc: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    css: 'css',
    scss: 'css',
    less: 'css',
    html: 'html',
    htm: 'html',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    sql: 'sql',
    toml: 'toml',
  };
  return MAP[ext] || '';
}

export function highlightCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  for (const line of lines) {
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch && !inCodeBlock) {
      inCodeBlock = true;
      codeLang = (fenceMatch[1] ?? '').toLowerCase();
      result.push(line);
      continue;
    }
    if (inCodeBlock && line.trim() === '```') {
      inCodeBlock = false;
      codeLang = '';
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      if (isRegexHighlightSupported(codeLang) || codeLang === 'ts' || codeLang === 'js') {
        result.push(highlightLine(line, codeLang));
      } else if (codeLang) result.push(dim(line));
      else result.push(line);
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

// ─── Markdown-to-ANSI via marked AST ────────────────────────────────────────

/**
 * Render markdown text to ANSI-colored terminal output using the `marked`
 * library's lexer to produce a proper AST. Handles multi-line structures,
 * nested formatting, tables, and all standard markdown features correctly —
 * unlike the previous regex line-scanner.
 *
 * When NO_COLOR is set, returns text unchanged.
 */
/** Quick check for markdown syntax characters before invoking
 *  the full lexer. Returns false for plain text with no formatting. */
const MARKDOWN_SYNTAX_RE =
  /[`*_~#>\[\]|\\<!]|^ {0,3}\d+\.|^ {0,3}[-*+] |^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/m;
function hasMarkdownSyntax(text: string): boolean {
  return MARKDOWN_SYNTAX_RE.test(text);
}

// ── renderMarkdown memoization ────────────────────────────────────────────
// renderMarkdown is called repeatedly on the same text (live HUD every 50ms,
// snapshot, transcript, T-key toggle). Cache rendered output by input text to
// avoid re-lexing + re-rendering identical content.

const mdRenderCache = new Map<string, string>();
const MD_CACHE_MAX = 128;

export function renderMarkdown(text: string): string {
  // Check cache first (must happen before the HAS_COLOR/sanitize path so
  // we can serve cached results even when color is disabled)
  const cached = mdRenderCache.get(text);
  if (cached !== undefined) return cached;

  if (!HAS_COLOR) return text;
  if (!text) return '';

  // Sanitize LLM-produced text against terminal escape injection
  const safe = sanitizeLlmOutput(text);

  // Fast-path — skip lexer for text with no markdown syntax
  if (!hasMarkdownSyntax(safe)) {
    mdRenderCache.set(text, safe);
    return safe;
  }

  const tokens = marked.lexer(safe);
  const blocks: string[] = [];

  for (const token of tokens) {
    const rendered = renderBlockToken(token);
    if (rendered) blocks.push(rendered);
  }

  const result = blocks.join('\n\n');

  // Evict oldest if cache is full
  if (mdRenderCache.size >= MD_CACHE_MAX) {
    const firstKey = mdRenderCache.keys().next().value;
    if (firstKey !== undefined) mdRenderCache.delete(firstKey);
  }
  mdRenderCache.set(text, result);
  return result;
}

/** Clear the renderMarkdown memoization cache (for testing / theme changes). */
export function clearMdRenderCache(): void {
  mdRenderCache.clear();
}

type MdTableRow = { tokens: any[] };

function renderBlockToken(token: MdToken): string {
  switch (token.type) {
    case 'heading':
      return renderHeading(token as any);
    case 'paragraph':
      return renderParagraph(token as any);
    case 'code':
      return renderCodeBlock(token as any);
    case 'list':
      return renderList(token as any);
    case 'blockquote':
      return renderBlockquote(token as any);
    case 'hr':
      return dim('─'.repeat(getTerminalWidth()));
    case 'space':
      return '';
    case 'table':
      return renderTable(token as any);
    default: {
      if ('tokens' in token && Array.isArray(token['tokens'])) {
        return (token as any).tokens
          .map((t: MdToken) => renderBlockToken(t))
          .filter(Boolean)
          .join('\n');
      }
      if ('raw' in token) return (token as any).raw;
      return '';
    }
  }
}

function renderHeading(token: MdTokens['Heading']): string {
  const text = renderInlineTokens(token.tokens);
  return accentBright(text);
}

function renderParagraph(token: MdTokens['Paragraph']): string {
  return renderInlineTokens(token.tokens);
}

function renderCodeBlock(token: MdTokens['Code']): string {
  const lang = token.lang || '';
  const lines = token.text.split('\n');
  const knownLang = isRegexHighlightSupported(lang);
  return lines
    .map((line: string) => {
      if (knownLang) return '  ' + highlightLine(line, lang.toLowerCase());
      if (lang) return '  ' + dim(line);
      return '  ' + line;
    })
    .join('\n');
}

function renderList(token: MdTokens['List']): string {
  const lines: string[] = [];
  let itemNum = token.start || 1;
  for (const item of token.items) {
    const prefix = token.ordered ? dim(`${itemNum}.`) : dim('·');
    const content = renderInlineTokens(item.tokens);
    const out = `  ${prefix} ${content}`;
    lines.push(out);
    if (token.ordered) itemNum++;
    for (const subToken of item.tokens) {
      if (subToken.type === 'list') {
        const subLines = renderList(subToken as any).split('\n');
        for (const sl of subLines) lines.push('    ' + sl);
      }
    }
  }
  return lines.join('\n');
}

function renderBlockquote(token: MdTokens['Blockquote']): string {
  const content = token.tokens
    .map((t: MdToken) => renderBlockToken(t))
    .filter(Boolean)
    .join('\n');
  return content
    .split('\n')
    .map((line: string) => `  ${dim('│')} ${dim(line)}`)
    .join('\n');
}

function renderTable(token: MdTokens['Table']): string {
  if (token.rows.length === 0 && token.header.length === 0) return '';
  const allRows = token.header.length > 0 ? [token.header, ...token.rows] : token.rows;
  const align = (token as any).align || [];
  const colWidths: number[] = [];
  for (const row of allRows) {
    for (let i = 0; i < row.length; i++) {
      const cellText = renderInlineTokens(row[i]!.tokens);
      const len = stripAnsiLength(cellText);
      colWidths[i] = Math.max(colWidths[i] || 0, len);
    }
  }
  const totalWidth = colWidths.reduce((a: number, b: number) => a + b + 3, 0);
  const maxWidth = getTerminalWidth() - 2;
  if (totalWidth > maxWidth) {
    return token.rows
      .map((row: MdTokens['TableRow']) =>
        row
          .map((cell: any, i: number) => {
            const hdr = token.header[i]
              ? renderInlineTokens(token.header[i]!.tokens)
              : `Col ${i + 1}`;
            const val = renderInlineTokens(cell.tokens);
            return `  ${dim(hdr + ':')} ${val}`;
          })
          .join('\n'),
      )
      .join('\n\n');
  }
  const lines: string[] = [];
  const drawRow = (cells: any[][]) => {
    return cells
      .map((row) => {
        const padded = row
          .map((cell: any, ci: number) => {
            const text = renderInlineTokens(cell.tokens);
            const pad = colWidths[ci]! - stripAnsiLength(text);
            const adj = align[ci] === 'right' ? ' '.repeat(pad) + text : text + ' '.repeat(pad);
            return ` ${adj} `;
          })
          .join('│');
        return `  │${padded}│`;
      })
      .join('\n');
  };
  if (token.header.length > 0) {
    lines.push(drawRow([token.header]));
    const sep = token.header
      .map((_: any, i: number) => {
        const w = colWidths[i]!;
        const l =
          align[i] === 'right'
            ? '─'.repeat(w + 1) + ':'
            : align[i] === 'center'
              ? ':' + '─'.repeat(w) + ':'
              : '─'.repeat(w + 2);
        return l;
      })
      .join('┼');
    lines.push('  ├' + sep + '┤');
  }
  if (token.rows.length > 0) lines.push(drawRow(token.rows));
  return lines.join('\n');
}

// ─── Inline token rendering ─────────────────────────────────────────────────

type InlineToken = MdTokens['Generic'];

function renderInlineTokens(tokens: InlineToken[]): string {
  return tokens.map((t: InlineToken) => renderInlineToken(t)).join('');
}

function renderInlineToken(token: InlineToken): string {
  switch (token.type) {
    case 'text':
      return (token as any).text;
    case 'strong':
      return bold(renderInlineTokens((token as any).tokens));
    case 'em':
      return ANSI_ITALIC_OPEN + renderInlineTokens((token as any).tokens) + ANSI_ITALIC_CLOSE;
    case 'del':
      return dim(renderInlineTokens((token as any).tokens));
    case 'codespan':
      return info((token as any).text);
    case 'link': {
      const link = token as any;
      const text = renderInlineTokens(link.tokens);
      // OSC 8 hyperlinks — Ctrl+Click in supporting terminals
      if (HAS_COLOR) {
        return `\x1b]8;;${link.href}\x1b\\${text}\x1b]8;;\x1b\\ ${dim('(' + link.href + ')')}`;
      }
      return `${text} ${dim('(' + link.href + ')')}`;
    }
    case 'br':
      return '\n';
    case 'image':
      return dim(`[image: ${(token as any).href || (token as any).text}]`);
    default:
      return (token as any).raw || '';
  }
}

/** Measure visible length of a string, stripping ANSI escape codes. */
function stripAnsiLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}
