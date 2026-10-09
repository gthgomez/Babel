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
 * Per-file tag cache is keyed by mtime + content hash; writes invalidate via
 * `invalidateRepoMapFile` (wired to the coding loop's post-edit hook).
 *
 * This module has no hard dependency on tree-sitter — it degrades to the
 * regex tagger, and the caller (repoMapPreamble) falls back to the legacy
 * directory-listing preamble if the whole pipeline fails or the repo exceeds
 * the size cap.
 */

import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, relative, sep } from 'node:path';

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
}

export interface RepoMapResult {
  map: string;
  filesConsidered: number;
  tagSource: 'tree-sitter' | 'regex';
  tokens: number;
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

function extractTagsRegex(code: string): RepoTag[] {
  const tags: RepoTag[] = [];
  const lines = code.split('\n');
  for (const pattern of REGEX_DEF_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      const name = m[1];
      if (!name) continue;
      const line = code.slice(0, m.index).split('\n').length - 1;
      if (line < lines.length) tags.push({ name, kind: 'def', line });
    }
  }
  // References: identifier occurrences in other lines (aider-style ref pass).
  const identRe = /[A-Za-z_$][\w$]{3,}/g;
  let im: RegExpExecArray | null;
  while ((im = identRe.exec(code)) !== null) {
    tags.push({ name: im[0], kind: 'ref', line: 0 });
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
      out.push({
        name: code.slice(nameNode.startIndex, nameNode.endIndex),
        kind: 'def',
        line: node.startPosition.row,
      });
    }
  }
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      const name = code.slice(child.startIndex, child.endIndex);
      if (name.length >= 4) out.push({ name, kind: 'ref', line: child.startPosition.row });
    }
    collectTreeSitterNodes(child, code, out, depth + 1);
  }
}

export async function extractFileTags(file: string, code: string): Promise<RepoTag[]> {
  const lang = langForFile(file);
  const parser = lang ? ensureParser(lang) : null;
  if (parser) {
    try {
      const tree = parser.parse(code);
      const tags: RepoTag[] = [];
      collectTreeSitterNodes(tree.rootNode, code, tags);
      if (tags.length > 0) return tags;
    } catch {
      /* fall through to regex */
    }
  }
  return extractTagsRegex(code);
}

// ─── Per-file cache (mtime + hash) ──────────────────────────────────────────

interface CacheEntry {
  mtimeMs: number;
  size: number;
  hash: string;
  tags: RepoTag[];
}

const tagCache = new Map<string, CacheEntry>();

/** Invalidate the cached tags for one file; call on write events. */
export function invalidateRepoMapFile(absPath: string): void {
  tagCache.delete(absPath);
}

/** Invalidate the entire tag cache (e.g. on checkout/branch switch). */
export function invalidateRepoMapCache(): void {
  tagCache.clear();
}

async function loadTags(file: string): Promise<RepoTag[] | null> {
  try {
    const st = await stat(file);
    const cached = tagCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.tags;
    }
    const code = await readFile(file, 'utf-8');
    const hash = createHash('sha256').update(code).digest('hex');
    if (cached && cached.hash === hash) {
      // Content unchanged (touch) — refresh stat key only.
      cached.mtimeMs = st.mtimeMs;
      return cached.tags;
    }
    const tags = await extractFileTags(file, code);
    tagCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, hash, tags });
    return tags;
  } catch {
    return null;
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
  depth = 0,
): Promise<void> {
  if (out.length >= maxFiles || depth > 12) return;
  let entries: import('node:fs').Dirent[];
  try {
    const { readdir } = await import('node:fs/promises');
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await collectSourceFiles(`${dir}${sep}${entry.name}`, out, maxFiles, depth + 1);
    } else if (entry.isFile() && SOURCE_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push(`${dir}${sep}${entry.name}`);
    }
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
  options: { mentionedIdents?: Set<string>; chatRel?: Set<string> } = {},
): Promise<{ graph: FileGraph; defines: Map<string, Map<string, RepoTag[]>>; chatRel: Set<string> }> {
  const defines = new Map<string, Map<string, RepoTag[]>>(); // ident → file → tags
  const references = new Map<string, string[]>(); // ident → files
  const relOf = new Map<string, string>();

  for (const file of files) {
    const rel = relativeToRoot(file);
    relOf.set(file, rel);
    const tags = await loadTags(file);
    if (!tags) continue;
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
        let list = references.get(tag.name);
        if (!list) {
          list = [];
          references.set(tag.name, list);
        }
        list.push(rel);
      }
    }
  }

  // No references at all → treat every definition as a reference (Aider).
  if (references.size === 0) {
    for (const [ident, perFile] of defines) {
      references.set(ident, [...perFile.keys()]);
    }
  }

  const idents = [...defines.keys()].filter((ident) => references.has(ident));
  const edges: GraphEdge[] = [];
  const nodeSet = new Set<string>();

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

    const refCount = new Map<string, number>();
    for (const refFile of references.get(ident)!) {
      refCount.set(refFile, (refCount.get(refFile) ?? 0) + 1);
    }
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
      tokenizer = (mod.encodingForModel ?? mod.default?.encodingForModel)('gpt-4o');
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

let projectRootCache: string | null = null;

export function setRepoMapProjectRoot(root: string): void {
  projectRootCache = root;
}

function relativeToRoot(file: string): string {
  if (projectRootCache) {
    const rel = relative(projectRootCache, file);
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
  const budgetTokens = options.budgetTokens ?? 1_000;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  setRepoMapProjectRoot(projectRoot);

  const files: string[] = [];
  await collectSourceFiles(projectRoot, files, maxFiles + 1);
  if (files.length === 0 || files.length > maxFiles) return null;

  const seeds = new Set<string>();
  for (const seed of options.seedFiles ?? []) {
    seeds.add(relativeToRoot(seed));
  }

  const mentionedIdents = options.mentionedIdents;
  const chatRel = new Set<string>();
  for (const s of seeds) chatRel.add(s);
  const { graph, defines } = await buildFileGraph(files, {
    ...(mentionedIdents !== undefined ? { mentionedIdents } : {}),
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
  const nodeIndex = new Map<string, number>(graph.nodes.map((f, i) => [f, i]));
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
    files2.map((f) => `${relativeToRoot(f)}\n`).join('');

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
  return {
    map,
    filesConsidered: files.length,
    tagSource: repoMapTagSource(),
    tokens: getTokenCount(map),
  };
}
