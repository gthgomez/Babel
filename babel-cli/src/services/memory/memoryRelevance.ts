/**
 * memoryRelevance.ts — Relevance Selection for Project Memory
 *
 * Fast, keyword-based relevance search for memory files. Uses substring matching
 * against title, description, and body content, scoring by match location:
 *   title match > description match > body match
 *
 * Intentionally lightweight — no LLM calls, no vector embeddings, no external
 * dependencies. For a project with 5-50 memory files, keyword search is fast,
 * deterministic, and debuggable.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';

import {
  type MemoryFile,
  type MemoryIndex,
  type MemoryRelevanceScore,
  MEMORY_INDEX_NAME,
  DEFAULT_MAX_RELEVANT_MEMORIES,
} from './memoryTypes.js';
import { readIndex } from './memoryIndex.js';
import { scanMemoryDirectory, parseMemoryFrontmatter } from './memoryStore.js';

// ─── Tokenization ──────────────────────────────────────────────────────────

/**
 * Split text into lowercase tokens for matching.
 * Strips punctuation and splits on whitespace.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Extract meaningful keywords from a task description.
 * Removes common stop words that don't carry semantic weight.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'you',
  'your', 'they', 'them', 'their', 'i', 'me', 'my', 'he', 'she', 'him',
  'her', 'his', 'not', 'no', 'nor', 'if', 'then', 'else', 'when',
  'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'whose',
  'about', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further',
  'once', 'here', 'there', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'because', 'but', 'also', 'like', 'make',
  'want', 'look', 'see', 'use', 'get', 'find', 'tell', 'ask', 'try',
  'leave', 'call', 'give', 'take', 'put', 'set', 'let', 'run', 'go',
]);

function extractKeywords(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// ─── Relevance Scoring ─────────────────────────────────────────────────────

/**
 * Score a single memory file against a set of keywords.
 * Returns a score between 0 (no match) and 100 (strong match).
 */
function scoreMemory(memory: MemoryFile, keywords: string[]): { score: number; reason: string } {
  if (keywords.length === 0) return { score: 0, reason: 'no keywords' };

  const nameLower = memory.frontmatter.name.toLowerCase();
  const descriptionLower = memory.frontmatter.description.toLowerCase();
  const bodyLower = memory.body.toLowerCase();
  const typeLower = memory.frontmatter.metadata.type.toLowerCase();

  let totalScore = 0;
  const matchedTerms: string[] = [];

  for (const keyword of keywords) {
    let termScore = 0;

    // Title match (highest weight)
    if (nameLower.includes(keyword)) {
      termScore = 15;
    }

    // Description match (medium-high weight)
    if (descriptionLower.includes(keyword)) {
      termScore = Math.max(termScore, 10);
    }

    // Memory type match (boost if keyword matches the type)
    if (typeLower.includes(keyword)) {
      termScore = Math.max(termScore, 5);
    }

    // Body match (lower weight — body can be long and noisy)
    if (bodyLower.includes(keyword)) {
      termScore = Math.max(termScore, 3);
    }

    // Exact phrase bonus: check if the full keyword sequence appears in
    // name or description (handles key concepts like "test command" as a unit)
    if (nameLower.includes(keyword.replace(/\s+/g, '-'))) {
      termScore = Math.max(termScore, 12);
    }

    if (termScore > 0) {
      totalScore += termScore;
      matchedTerms.push(keyword);
    }
  }

  // Normalize to 0-100
  const normalizedScore = Math.min(100, totalScore);

  if (normalizedScore === 0) {
    return { score: 0, reason: 'no relevant keywords matched' };
  }

  return {
    score: normalizedScore,
    reason: `matched: ${matchedTerms.join(', ')}`,
  };
}

// ─── Search Functions ──────────────────────────────────────────────────

/**
 * Find relevant memories for a task description using fast keyword/substring matching.
 *
 * @param memoryRoot - Absolute path to the memory directory
 * @param taskDescription - Natural language description of the current task
 * @param options - Optional configuration
 * @param options.maxMemories - Maximum number of memories to return (default 5)
 * @returns Array of relevant memory files sorted by relevance score (descending)
 */
export function findRelevantMemories(
  memoryRoot: string,
  taskDescription: string,
  options?: { maxMemories?: number },
): MemoryRelevanceScore[] {
  const maxMemories = options?.maxMemories ?? DEFAULT_MAX_RELEVANT_MEMORIES;

  // Early return for empty memory directory
  const allMemories = scanMemoryDirectory(memoryRoot);
  if (allMemories.length === 0) return [];

  const keywords = extractKeywords(taskDescription);
  if (keywords.length === 0) return [];

  // Score each memory
  const scored: MemoryRelevanceScore[] = [];
  for (const memory of allMemories) {
    const { score, reason } = scoreMemory(memory, keywords);
    if (score > 0) {
      scored.push({ memory, score, matchReason: reason });
    }
  }

  // Sort by score descending, return top N
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMemories);
}

/**
 * Build a searchable index from memory descriptions for fast scanning.
 * Returns a flat list of { name, description, file } objects.
 */
export function buildSearchableIndex(memoryRoot: string): MemoryIndex {
  return readIndex(join(memoryRoot, MEMORY_INDEX_NAME));
}

/**
 * Quick check: does any memory description match the given keywords?
 * Used as a fast gate before loading full memory files.
 */
export function hasRelevantMemories(memoryRoot: string, taskDescription: string): boolean {
  const index = buildSearchableIndex(memoryRoot);
  if (index.entries.length === 0) return false;

  const keywords = extractKeywords(taskDescription);
  if (keywords.length === 0) return false;

  for (const entry of index.entries) {
    const descLower = entry.description.toLowerCase();
    const nameLower = entry.name.toLowerCase();
    for (const kw of keywords) {
      if (descLower.includes(kw) || nameLower.includes(kw)) return true;
    }
  }

  return false;
}

// ─── Formatting ────────────────────────────────────────────────────────

/**
 * Format relevant memories as a markdown section for system prompt injection.
 * Returns null when no relevant memories are found.
 */
export function formatRelevantMemoriesSection(
  relevant: MemoryRelevanceScore[],
): string | null {
  if (relevant.length === 0) return null;

  const lines: string[] = ['## Project Memory', ''];
  for (const item of relevant) {
    const { memory, score, matchReason } = item;
    lines.push(
      `### ${memory.frontmatter.name} ([${memory.frontmatter.metadata.type}] - score: ${score})`,
    );
    lines.push('');
    lines.push(`> ${memory.frontmatter.description}`);
    lines.push('');
    lines.push(memory.body.trim());
    lines.push('');
  }
  lines.push(
    '---',
    '',
    `_${relevant.length} memory(s) retrieved. Match reasoning: ${relevant.map((r) => r.matchReason).join('; ')}_`,
    '',
  );

  return lines.join('\n');
}

/**
 * Cross-link references with [[name]] syntax rendered as markdown links.
 * Scans a block of text and converts [[memory-name]] references to markdown links.
 */
export function renderCrossLinks(text: string, memoryRoot: string): string {
  const crossLinkRe = /\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g;
  return text.replace(crossLinkRe, (_match, name: string) => {
    const memory = findByNameSimple(memoryRoot, name);
    if (memory) {
      return `[${memory.frontmatter.description}](${memory.path})`;
    }
    // If memory not found, render as plain text with the slug
    return `\`${name}\``;
  });
}

/**
 * Simple findByName that returns null on error (no dependency on memoryStore).
 */
function findByNameSimple(memoryRoot: string, name: string): MemoryFile | null {
  const filePath = join(memoryRoot, `${name}.md`);
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parseMemoryFrontmatter(raw);
    if (!parsed) return null;
    const st = statSync(filePath);
    return {
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      path: `${name}.md`,
      mtime: st.mtime,
    };
  } catch {
    return null;
  }
}
