/**
 * repoMap/graph.ts — Tree-sitter symbol tags + personalized PageRank repo map.
 *
 * Algorithm ported from Aider (https://github.com/Aider-AI/aider,
 * `aider/repomap.py`, Apache-2.0). Aider is Copyright (c) 2023 Paul Gauthier.
 * Ported semantics:
 *   1. Extract symbol tags (def/ref) per file with tree-sitter when a grammar
 *      is available; otherwise fall back to a conservative regex tagger.
 *   2. Build a weighted file→file directed multi-graph: referencer → definer,
 *      weight = identityMultiplier * sqrt(referenceCount), plus 0.1-weight
 *      self edges for definitions with no references.
 *   3. Personalized PageRank seeded from files currently in chat context.
 *   4. Distribute each node's rank across its out-edges to rank (file, ident)
 *      definition pairs; render the top prefix under a token budget using a
 *      binary search over prefix size (Aider `get_ranked_tags_map_uncached`).
 *
 * Per-file tags are cached by content hash with bounded retention; writes
 * invalidate via `invalidateRepoMapFile` (the coding loop's post-edit hook).
 *
 * This module has no hard dependency on tree-sitter — it degrades to the
 * regex tagger, and the caller (repoMapPreamble) falls back to the legacy
 * directory-listing preamble if the whole pipeline fails or the repo exceeds
 * the size cap.
 */

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { stat, open, opendir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, relative, sep } from 'node:path';
import { isMainThread } from 'node:worker_threads';

import { invalidateWorkerCache, runRepoMapWorker } from './graphWorkerClient.js';
import { RepoMapTagCache } from './tagCache.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RepoTag {
  name: string;
  kind: 'def' | 'ref';
  line: number; // 0-based
}

export interface RepoMapGraphOptions {
  /** Token budget for the rendered map (default 1_000). */
  budgetTokens?: number;
  /** Repos with more source files than this fall back to the legacy preamble. */
  maxFiles?: number;
  /** Absolute paths of files currently in chat context (PageRank seeds). */
  seedFiles?: string[];
  /** Extra identifiers mentioned in chat that boost matching symbols. */
  mentionedIdents?: Set<string>;
  /** Abort active indexing; the owned worker is stopped before returning. */
  signal?: AbortSignal;
  /** Overall wall-clock budget, including worker startup and discovery. */
  maxDurationMs?: number;
  /** Maximum number of file-reference edges to materialize. */
  maxEdges?: number;
  /** Maximum total source bytes read by one indexing pass. */
  maxSourceBytes?: number;
  /** Maximum source bytes in one file. */
  maxFileBytes?: number;
  /** Prepare the legacy directory summary inside the same bounded worker. */
  includeLegacyFallback?: boolean;
}

export interface RepoMapResult {
  map: string;
  filesConsidered: number;
  tagSource: 'tree-sitter' | 'regex';
  tokens: number;
}

export type RepoMapLimitReason =
  | 'file_limit' | 'directory_limit' | 'file_size_limit' | 'source_size_limit'
  | 'tag_limit' | 'edge_limit' | 'parser_limit' | 'file_changed';

export type RepoMapGraphOutcome =
  | { status: 'ok'; result: RepoMapResult }
  | { status: 'empty'; fallback?: string }
  | { status: 'limited'; reason: RepoMapLimitReason; fallback?: string }
  | { status: 'cancelled'; reason: 'aborted' | 'deadline' }
  | { status: 'failed'; reason: 'worker_failure' | 'io_failure' };

export class RepoMapLimitError extends Error {
  constructor(readonly reason: RepoMapLimitReason) {
    super(`Repository map budget exceeded: ${reason}`);
  }
}

export class RepoMapIoError extends Error {}

const DEFAULT_MAX_EDGES = 250_000;
const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_TAGS = 250_000;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 40_000;

function boundedLimit(value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, ceiling) : 0;
}

interface WorkBudget {
  maxSourceBytes: number;
  maxFileBytes: number;
  sourceBytes: number;
  tags: number;
  directoryEntries: number;
  versions: Map<string, import('node:fs').Stats>;
}

// ─── Optional tree-sitter loader (same pattern as ui/treeSitterHighlight) ───

const _require = createRequire(import.meta.url);

interface TsParser {
  parse(code: string): { rootNode: TsNode };
}
interface TsNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  children: TsNode[];
}

let tsParserModule: any = null;
try {
  tsParserModule = _require('tree-sitter');
} catch {
  tsParserModule = null;
}

const grammarCache = new Map<string, any>();
const parserCache = new Map<string, any>();

const GRAMMAR_PACKAGES: Record<string, string[]> = {
  typescript: ['tree-sitter-typescript', 'tree-sitter-javascript'],
  tsx: ['tree-sitter-typescript'],
  javascript: ['tree-sitter-javascript', 'tree-sitter-typescript'],
  python: ['tree-sitter-python'],
  rust: ['tree-sitter-rust'],
  go: ['tree-sitter-go'],
};

function ensureGrammar(lang: string): any | null {
  if (grammarCache.has(lang)) return grammarCache.get(lang) ?? null;
  let grammar: any = null;
  for (const pkg of GRAMMAR_PACKAGES[lang] ?? []) {
    try {
      const mod = _require(pkg);
      grammar = mod.default ?? mod;
      if (grammar && typeof grammar !== 'function' && grammar.name) {
        // e.g. tree-sitter-typescript exports { typescript, tsx }
        const sub = grammar[lang];
        if (sub) grammar = sub;
      }
      break;
    } catch {
      /* optional */
    }
  }
  grammarCache.set(lang, grammar ?? null);
  return grammar;
}

function ensureParser(lang: string): any | null {
  if (!tsParserModule || !lang) return null;
  if (parserCache.has(lang)) return parserCache.get(lang) ?? null;
  const grammar = ensureGrammar(lang);
  if (!grammar) {
    parserCache.set(lang, null);
    return null;
  }
  try {
    const parser = new tsParserModule();
    parser.setLanguage(grammar);
    parserCache.set(lang, parser);
    return parser;
  } catch {
    parserCache.set(lang, null);
    return null;
  }
}

export function repoMapTagSource(): 'tree-sitter' | 'regex' {
  return tsParserModule ? 'tree-sitter' : 'regex';
}

function langForFile(file: string): string | null {
  switch (extname(file).toLowerCase()) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return 'javascript';
    case '.py':
      return 'python';
    case '.rs':
      return 'rust';
    case '.go':
      return 'go';
    default:
      return null;
  }
}

// ─── Tag extraction ─────────────────────────────────────────────────────────

/**
 * Fallback regex tagger (conservative: only extracts identifier-like tokens
 * at declaration boundaries). Used when no tree-sitter grammar is installed.
 */
const REGEX_DEF_PATTERNS: RegExp[] = [
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
  /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/gm,
  /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/gm,
  /^\s*def\s+([A-Za-z_][\w]*)/gm,
  /^\s*class\s+([A-Za-z_][\w]*)/gm,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm,
];

function appendTag(tags: RepoTag[], tag: RepoTag): void {
  if (tags.length >= DEFAULT_MAX_TAGS) throw new RepoMapLimitError('tag_limit');
  tags.push(tag);
}

function extractTagsRegex(code: string): RepoTag[] {
  const tags: RepoTag[] = [];
  for (const pattern of REGEX_DEF_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    let offset = 0;
    let line = 0;
    while ((m = pattern.exec(code)) !== null) {
      const name = m[1];
      if (!name) continue;
      for (; offset < m.index; offset++) if (code[offset] === '\n') line++;
      appendTag(tags, { name, kind: 'def', line });
    }
  }
  // References: identifier occurrences in other lines (aider-style ref pass).
  const identRe = /[A-Za-z_$][\w$]{3,}/g;
  let im: RegExpExecArray | null;
  while ((im = identRe.exec(code)) !== null) {
    appendTag(tags, { name: im[0], kind: 'ref', line: 0 });
  }
  return tags;
}

function collectTreeSitterNodes(node: TsNode, code: string, out: RepoTag[], depth = 0): void {
  if (depth > 200) return;
  const type = node.type;
  // Def-ish node types across grammars
  if (
    type === 'function_declaration' ||
    type === 'method_definition' ||
    type === 'class_declaration' ||
    type === 'class_definition' ||
    type === 'interface_declaration' ||
    type === 'type_alias_declaration' ||
    type === 'function_item' ||
    type === 'struct_item' ||
    type === 'function_definition'
  ) {
    const nameNode = node.children.find(
      (c) => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'name',
    );
    if (nameNode) {
      appendTag(out, {
        name: code.slice(nameNode.startIndex, nameNode.endIndex),
        kind: 'def',
        line: node.startPosition.row,
      });
    }
  }
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      const name = code.slice(child.startIndex, child.endIndex);
      if (name.length >= 4) appendTag(out, { name, kind: 'ref', line: child.startPosition.row });
    }
    collectTreeSitterNodes(child, code, out, depth + 1);
  }
}

export async function extractFileTags(file: string, code: string): Promise<RepoTag[]> {
  const lang = langForFile(file);
  const parser = lang ? ensureParser(lang) : null;
  // Native parsing must have its own bound: a worker termination cannot
  // interrupt arbitrary native code until the parser returns to JavaScript.
  if (parser && typeof parser.setTimeoutMicros === 'function') {
    try {
      parser.setTimeoutMicros(25_000);
      const tree = parser.parse(code);
      if (!tree) throw new RepoMapLimitError('parser_limit');
      const tags: RepoTag[] = [];
      collectTreeSitterNodes(tree.rootNode, code, tags);
      if (tags.length > 0) return tags;
    } catch (error) {
      if (error instanceof RepoMapLimitError) throw error;
      /* fall through to regex */
    }
  }
  return extractTagsRegex(code);
}

// ─── Per-file cache (mtime + hash) ──────────────────────────────────────────

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4_000;
const tagCache = new RepoMapTagCache(MAX_CACHE_BYTES, MAX_CACHE_ENTRIES);

/** Invalidate the cached tags for one file; call on write events. */
export function invalidateRepoMapFile(absPath: string): void {
  tagCache.delete(absPath);
  if (isMainThread) invalidateWorkerCache(absPath);
}

/** Invalidate the entire tag cache (e.g. on checkout/branch switch). */
export function invalidateRepoMapCache(): void {
  tagCache.clear();
  if (isMainThread) invalidateWorkerCache();
}

async function loadTags(file: string, budget?: WorkBudget): Promise<RepoTag[] | null> {
  try {
    const handle = await open(file, 'r');
    let before: import('node:fs').Stats;
    let bytes: Buffer;
    try {
      before = await handle.stat();
      const maxBytes = budget?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
      if (before.size > maxBytes) throw new RepoMapLimitError('file_size_limit');
      if (budget) {
        budget.sourceBytes += before.size;
        if (budget.sourceBytes > budget.maxSourceBytes) throw new RepoMapLimitError('source_size_limit');
      }
      // Read at most the original file size plus one byte. A file that grows
      // after stat must not bypass the per-file memory limit.
      const buffer = Buffer.allocUnsafe(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset !== before.size) throw new RepoMapLimitError('file_changed');
      bytes = buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.ino !== after.ino || before.dev !== after.dev) {
      throw new RepoMapLimitError('file_changed');
    }
    budget?.versions.set(file, after);
    const cached = tagCache.get(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (cached && cached.hash === hash) {
      return cached.tags;
    }
    const tags = await extractFileTags(file, bytes.toString('utf-8'));
    tagCache.set(file, hash, tags, bytes.length);
    return tags;
  } catch (error) {
    if (error instanceof RepoMapLimitError) throw error;
    throw new RepoMapIoError('Repository source could not be read');
  }
}

// ─── File discovery ─────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'runs',
  'artifacts',
  'runtime',
  'coverage',
  '.nyc_output',
  'tmp',
  '.venv',
  '__pycache__',
]);

const SOURCE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
]);

const DEFAULT_MAX_FILES = 4_000;

async function collectSourceFiles(
  dir: string,
  out: string[],
  maxFiles: number,
  budget: WorkBudget,
  depth = 0,
): Promise<void> {
  if (out.length >= maxFiles || depth > 12) return;
  try {
    const entries = await opendir(dir);
    for await (const entry of entries) {
      if (++budget.directoryEntries > DEFAULT_MAX_DIRECTORY_ENTRIES) {
        throw new RepoMapLimitError('directory_limit');
      }
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await collectSourceFiles(`${dir}${sep}${entry.name}`, out, maxFiles, budget, depth + 1);
      } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
        out.push(`${dir}${sep}${entry.name}`);
      }
    }
  } catch (error) {
    if (error instanceof RepoMapLimitError) throw error;
    throw new RepoMapIoError('Repository directory could not be read');
  }
}

// ─── Personalized PageRank ──────────────────────────────────────────────────

export interface GraphEdge {
  src: string;
  dst: string;
  weight: number;
  ident: string;
}

export interface FileGraph {
  nodes: string[];
  edges: GraphEdge[];
}

/**
 * Build the file→file reference graph from per-file tags.
 * Ported from Aider `get_ranked_tags` (Apache-2.0).
 */
export async function buildFileGraph(
  files: string[],
  options: {
    mentionedIdents?: Set<string>;
    chatRel?: Set<string>;
    projectRoot?: string;
    maxEdges?: number;
    budget?: WorkBudget;
  } = {},
): Promise<{ graph: FileGraph; defines: Map<string, Map<string, RepoTag[]>>; chatRel: Set<string> }> {
  const projectRoot = options.projectRoot ?? legacyProjectRoot.getStore();
  const defines = new Map<string, Map<string, RepoTag[]>>(); // ident → file → tags
  const references = new Map<string, Map<string, number>>(); // ident → file → count

  for (const file of files) {
    const rel = relativeToRoot(projectRoot, file);
    const tags = await loadTags(file, options.budget);
    if (!tags) continue;
    if (options.budget) {
      options.budget.tags += tags.length;
      if (options.budget.tags > DEFAULT_MAX_TAGS) throw new RepoMapLimitError('tag_limit');
    }
    for (const tag of tags) {
      if (tag.kind === 'def') {
        let perFile = defines.get(tag.name);
        if (!perFile) {
          perFile = new Map();
          defines.set(tag.name, perFile);
        }
        let list = perFile.get(rel);
        if (!list) {
          list = [];
          perFile.set(rel, list);
        }
        list.push(tag);
      } else {
        let counts = references.get(tag.name);
        if (!counts) {
          counts = new Map();
          references.set(tag.name, counts);
        }
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
      }
    }
  }

  // No references at all → treat every definition as a reference (Aider).
  if (references.size === 0) {
    for (const [ident, perFile] of defines) {
      references.set(ident, new Map([...perFile.keys()].map((file) => [file, 1])));
    }
  }

  const idents = [...defines.keys()].filter((ident) => references.has(ident));
  const edges: GraphEdge[] = [];
  const nodeSet = new Set<string>();
  // Count the distinct referencer × definer pairs before materializing any
  // edges. A rejected graph is never returned or installed as complete.
  let estimatedEdges = 0;
  for (const [ident, perFile] of defines) {
    const refs = references.get(ident);
    estimatedEdges += refs ? refs.size * perFile.size : perFile.size;
    if (estimatedEdges > boundedLimit(options.maxEdges, DEFAULT_MAX_EDGES)) {
      throw new RepoMapLimitError('edge_limit');
    }
  }

  // Small self-edges for unreferenced definitions (Aider).
  for (const [ident, perFile] of defines) {
    if (references.has(ident)) continue;
    for (const definer of perFile.keys()) {
      edges.push({ src: definer, dst: definer, weight: 0.1, ident });
      nodeSet.add(definer);
    }
  }

  for (const ident of idents) {
    const definers = defines.get(ident)!;
    let mul = 1.0;
    const isSnake = ident.includes('_') && /[a-zA-Z]/.test(ident);
    const isKebab = ident.includes('-') && /[a-zA-Z]/.test(ident);
    const isCamel = /[A-Z]/.test(ident) && /[a-z]/.test(ident);
    if (options.mentionedIdents?.has(ident)) mul *= 10;
    if ((isSnake || isKebab || isCamel) && ident.length >= 8) mul *= 10;
    if (ident.startsWith('_')) mul *= 0.1;
    if (definers.size > 5) mul *= 0.1;

    const refCount = references.get(ident)!;
    for (const [referencer, numRefs] of refCount) {
      for (const definer of definers.keys()) {
        // Aider: references from files already in chat count 50x.
        const useMul = options.chatRel?.has(referencer) ? mul * 50 : mul;
        edges.push({
          src: referencer,
          dst: definer,
          weight: useMul * Math.sqrt(numRefs),
          ident,
        });
        nodeSet.add(referencer);
        nodeSet.add(definer);
      }
    }
  }

  return {
    graph: { nodes: [...nodeSet], edges },
    defines,
    chatRel: new Set<string>(),
  };
}

/**
 * Personalized PageRank (power iteration) seeded with chat files.
 * Seed weight follows Aider: 100 / num_nodes per chat file, applied as both
 * personalization vector and dangling-node redistribution.
 */
export function personalizedPageRank(
  graph: FileGraph,
  seeds: Set<string>,
  iterations = 30,
  damping = 0.85,
): Map<string, number> {
  const nodes = graph.nodes;
  const n = nodes.length;
  if (n === 0) return new Map();
  const idx = new Map<string, number>(nodes.map((f, i) => [f, i]));
  const outEdges: { dst: number; weight: number }[][] = nodes.map(() => []);
  const outWeight = new Array<number>(n).fill(0);
  for (const e of graph.edges) {
    const s = idx.get(e.src);
    const d = idx.get(e.dst);
    if (s === undefined || d === undefined) continue;
    outEdges[s]?.push({ dst: d, weight: e.weight });
    outWeight[s] = (outWeight[s] ?? 0) + e.weight;
  }

  const personalize = 100 / n;
  const pers = new Array<number>(n).fill(0);
  let hasSeeds = false;
  for (const seed of seeds) {
    const i = idx.get(seed);
    if (i !== undefined) {
      pers[i] = (pers[i] ?? 0) + personalize;
      hasSeeds = true;
    }
  }
  if (!hasSeeds) pers.fill(1 / n);

  let rank: number[] = new Array<number>(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    let danglingSum = 0;
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const ri = rank[i] ?? 0;
      const ow = outWeight[i] ?? 0;
      if (ow === 0) {
        danglingSum += ri;
        continue;
      }
      const share = ri / ow;
      for (const e of outEdges[i] ?? []) next[e.dst] = (next[e.dst] ?? 0) + share * e.weight;
    }
    for (let i = 0; i < n; i++) {
      next[i] = damping * ((next[i] ?? 0) + danglingSum * (pers[i] ?? 0)) + (1 - damping) * (pers[i] ?? 0);
    }
    rank = next;
  }
  return new Map(nodes.map((f, i) => [f, rank[i] ?? 0]));
}

// ─── Rendering + token budget ───────────────────────────────────────────────

let tokenizer: { encode(text: string): number[] } | null | undefined;
function getTokenCount(text: string): number {
  if (tokenizer === undefined) {
    try {
      const mod = _require('js-tiktoken');
      const encodingForModel = mod.encodingForModel ?? mod.default?.encodingForModel;
      tokenizer = typeof encodingForModel === 'function' ? encodingForModel('gpt-4o') : null;
    } catch {
      tokenizer = null;
    }
  }
  if (tokenizer) return tokenizer.encode(text).length;
  // ~4 chars/token heuristic when js-tiktoken is unavailable
  return Math.ceil(text.length / 4);
}

interface RenderedTag {
  rel: string;
  name: string;
  line: number;
  kind: 'def' | 'ref';
}

function renderTagLines(tags: RenderedTag[]): string {
  const byFile = new Map<string, string[]>();
  for (const t of tags) {
    let lines = byFile.get(t.rel);
    if (!lines) {
      lines = [];
      byFile.set(t.rel, lines);
    }
    lines.push(`  ${(t.kind === 'def' ? 'def ' : 'ref ')}${t.name} :${t.line + 1}`);
  }
  let out = '';
  for (const [rel, lines] of byFile) {
    out += `${rel}\n${lines.join('\n')}\n\n`;
  }
  return out;
}

export function renderRepoMapTagLines(tags: RenderedTag[]): string {
  return renderTagLines(tags);
}

// ─── Top-level entry ────────────────────────────────────────────────────────

// Preserve the older low-level setter for external deep imports without
// sharing a root across asynchronous execution contexts. New code passes an
// explicit root and each graph build snapshots it before its first await.
const legacyProjectRoot = new AsyncLocalStorage<string>();

/** @deprecated Pass projectRoot to buildFileGraph instead. */
export function setRepoMapProjectRoot(root: string): void {
  legacyProjectRoot.enterWith(root);
}

function relativeToRoot(projectRoot: string | undefined, file: string): string {
  if (projectRoot) {
    const rel = relative(projectRoot, file);
    if (rel && !rel.startsWith('..')) return rel.split(sep).join('/');
  }
  return file.split(sep).join('/');
}

/**
 * Build the ranked repo map for a project under a token budget.
 * Returns `null` when the map cannot be produced (repo too large, no files);
 * the caller should then use the legacy preamble.
 */
export async function buildRepoMapGraph(
  projectRoot: string,
  options: RepoMapGraphOptions = {},
): Promise<RepoMapResult | null> {
  const outcome = await buildRepoMapGraphDetailed(projectRoot, options);
  return outcome.status === 'ok' ? outcome.result : null;
}

/** The outcome distinguishes an empty project from a rejected or cancelled scan. */
export async function buildRepoMapGraphDetailed(
  projectRoot: string,
  options: RepoMapGraphOptions = {},
): Promise<RepoMapGraphOutcome> {
  return runRepoMapWorker(projectRoot, options);
}

/** Worker-only computation. Interactive callers should use the bounded wrapper. */
export async function buildRepoMapGraphInWorker(
  projectRoot: string,
  options: Omit<RepoMapGraphOptions, 'signal' | 'maxDurationMs'> = {},
): Promise<RepoMapResult | null> {
  const budgetTokens = options.budgetTokens ?? 1_000;
  const maxFiles = boundedLimit(options.maxFiles, DEFAULT_MAX_FILES);
  const workBudget: WorkBudget = {
    maxSourceBytes: boundedLimit(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES),
    maxFileBytes: boundedLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    sourceBytes: 0,
    tags: 0,
    directoryEntries: 0,
    versions: new Map(),
  };

  const files: string[] = [];
  await collectSourceFiles(projectRoot, files, maxFiles + 1, workBudget);
  if (files.length > maxFiles) throw new RepoMapLimitError('file_limit');
  if (files.length === 0) return null;

  const seeds = new Set<string>();
  for (const seed of options.seedFiles ?? []) {
    seeds.add(relativeToRoot(projectRoot, seed));
  }

  const mentionedIdents = options.mentionedIdents;
  const chatRel = new Set<string>();
  for (const s of seeds) chatRel.add(s);
  const { graph, defines } = await buildFileGraph(files, {
    ...(mentionedIdents !== undefined ? { mentionedIdents } : {}),
    ...(options.maxEdges !== undefined ? { maxEdges: options.maxEdges } : {}),
    projectRoot,
    budget: workBudget,
    chatRel,
  });
  const rank = personalizedPageRank(graph, seeds);

  // Seed-relevance pruning: when files are seeded from chat, PageRank of a
  // disconnected component collapses to ~1/n (uniform). Skip files at or
  // below that baseline so irrelevant subtrees never enter the map.
  const relevanceFloor = seeds.size > 0 ? 1.5 / graph.nodes.length : 0;
  const isRelevant = (file: string): boolean =>
    relevanceFloor === 0 || (rank.get(file) ?? 0) > relevanceFloor;

  // Distribute node rank across out-edges onto (dst, ident) definition pairs.
  const edgeRank = new Map<string, number>(); // "dst\u0000ident" → rank
  const outWeight = new Map<string, number>();
  for (const e of graph.edges) {
    outWeight.set(e.src, (outWeight.get(e.src) ?? 0) + e.weight);
  }
  for (const e of graph.edges) {
    const srcRank = rank.get(e.src) ?? 0;
    const total = outWeight.get(e.src) ?? 0;
    if (total === 0) continue;
    const key = `${e.dst}\u0000${e.ident}`;
    edgeRank.set(key, (edgeRank.get(key) ?? 0) + (srcRank * e.weight) / total);
  }

  const chatRelSeeds = chatRel;

  // Ranked (file, ident) definition pairs (Aider ranked_definitions).
  const rankedPairs = [...edgeRank.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key]) => {
      const [dst, ident] = key.split('\u0000');
      return { dst: dst ?? '', ident: ident ?? '' };
    })
    .filter(({ dst }) => !chatRelSeeds.has(dst) && isRelevant(dst));

  // Then top-ranked files without tags (Aider tail pass).
  const includedFiles = new Set(rankedPairs.map((p) => p.dst));
  const topFiles = [...rank.entries()]
    .filter(([f]) => !chatRelSeeds.has(f) && !includedFiles.has(f) && isRelevant(f))
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);

  const renderPrefix = (count: number): string => {
    const rendered: RenderedTag[] = [];
    for (const { dst, ident } of rankedPairs.slice(0, count)) {
      const perFile = defines.get(ident)?.get(dst);
      const tag = perFile?.[0];
      if (tag) rendered.push({ rel: dst, name: ident, line: tag.line, kind: 'def' });
    }
    return renderTagLines(rendered);
  };

  const renderFileTails = (files2: string[]): string =>
    files2.map((f) => `${relativeToRoot(projectRoot, f)}\n`).join('');

  // Binary search prefix size against the token budget (Aider search_and_fit).
  const header = `## Repository Map\n\n`;
  const numPairs = rankedPairs.length;
  let lower = 0;
  let upper = numPairs;
  let best = '';
  let bestTokens = 0;
  const okErr = 0.15;
  let middle = Math.min(Math.floor(budgetTokens / 25), numPairs);
  for (let guard = 0; guard < 32 && lower <= upper; guard++) {
    const body = renderPrefix(middle);
    const tail = renderFileTails(topFiles.slice(0, Math.max(0, Math.floor((budgetTokens - getTokenCount(body)) / 8))));
    const tree = header + body + tail;
    const tokens = getTokenCount(tree);
    const pctErr = Math.abs(tokens - budgetTokens) / budgetTokens;
    // Strict budget: never accept a rendering over the budget.
    if (tokens <= budgetTokens && (tokens > bestTokens || pctErr < okErr)) {
      best = tree;
      bestTokens = tokens;
      if (pctErr < okErr) break;
    }
    if (tokens < budgetTokens) lower = middle + 1;
    else upper = middle - 1;
    middle = Math.floor((lower + upper) / 2);
  }

  if (!best) return null;

  const map = header + best.slice(header.length).replace(/\n+$/, '\n');
  // Reject scans invalidated by a file change, addition, deletion, or branch
  // switch while the graph was being assembled. This is a best-effort
  // filesystem check, not an atomic repository snapshot.
  const verifyFiles: string[] = [];
  const verifyBudget: WorkBudget = { ...workBudget, directoryEntries: 0 };
  await collectSourceFiles(projectRoot, verifyFiles, maxFiles + 1, verifyBudget);
  const originalFiles = new Set(files);
  if (verifyFiles.length !== files.length || verifyFiles.some((file) => !originalFiles.has(file))) {
    throw new RepoMapLimitError('file_changed');
  }
  for (const [file, before] of workBudget.versions) {
    let after: import('node:fs').Stats;
    try { after = await stat(file); } catch { throw new RepoMapLimitError('file_changed'); }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.ino !== after.ino || before.dev !== after.dev) {
      throw new RepoMapLimitError('file_changed');
    }
  }
  return {
    map,
    filesConsidered: files.length,
    tagSource: repoMapTagSource(),
    tokens: getTokenCount(map),
  };
}
