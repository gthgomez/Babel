/**
 * Compact repository map injected into the chat system prompt (R4 / L17).
 * Pure helper so unit tests can cover the preamble without spinning ChatEngine.
 *
 * Primary path (packet B1): tree-sitter + personalized PageRank repo map under
 * a token budget (services/repoMap/graph.ts, algorithm ported from Aider,
 * Apache-2.0). The legacy directory-listing preamble remains the fallback
 * when the graph pipeline fails (no parseable files, repo over the size cap).
 */
import { buildRepoMapGraphDetailed, type RepoMapGraphOutcome, type RepoMapLimitReason } from '../services/repoMap/graph.js';
import { estimateTokens, type ChatMessage } from './chatCompaction.js';
import { computePreambleBudget } from './preambleBudget.js';

export { buildLegacyRepoMapPreamble } from '../services/repoMap/legacy.js';

/** Diagnostic metadata never includes project content or paths. */
export type RepoMapGraphDiagnostic =
  | { status: 'ok' | 'empty' }
  | { status: 'limited'; reason: RepoMapLimitReason }
  | { status: 'cancelled'; reason: 'aborted' | 'deadline' }
  | { status: 'failed'; reason: 'worker_failure' | 'io_failure' };

function graphDiagnostic(outcome: RepoMapGraphOutcome): RepoMapGraphDiagnostic {
  switch (outcome.status) {
    case 'ok': case 'empty': return { status: outcome.status };
    case 'limited': return { status: 'limited', reason: outcome.reason };
    case 'cancelled': return { status: 'cancelled', reason: outcome.reason };
    case 'failed': return { status: 'failed', reason: outcome.reason };
  }
}

export interface RepoMapPreambleOptions {
  /** Token budget for the rendered map (default 1_000; expanded when no seeds). */
  budgetTokens?: number;
  /** Absolute paths of files currently in chat context (PageRank seeds). */
  seedFiles?: string[];
  /** Identifiers mentioned in chat that boost matching symbols. */
  mentionedIdents?: Set<string>;
  /** Cancel the owned index worker before returning a fallback. */
  signal?: AbortSignal;
  /** Wall-clock limit for discovery, parsing, graphing, rendering, and fallback. */
  maxDurationMs?: number;
  /** Receives the reason for an empty, limited, cancelled, or failed graph. */
  onGraphOutcome?: (outcome: RepoMapGraphDiagnostic) => void;
}

/** Repos with more source files than this use the legacy preamble. */
const REPO_MAP_FILE_CAP = 4_000;

const SEED_PATH_PATTERN = /[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go)\b/g;

/**
 * Collect source-file paths referenced in the chat conversation so far —
 * these seed the personalized PageRank (Aider "files in chat" behavior).
 */
export function collectChatSeedFiles(
  conversation: ReadonlyArray<{ content: unknown }>,
  _projectRoot: string,
): string[] {
  const seeds = new Set<string>();
  let remainingChars = 256_000;
  let candidates = 0;
  // Seed collection runs on the calling thread, so bound it and avoid any
  // synchronous filesystem probes before the interruptible worker starts.
  for (let i = conversation.length - 1; i >= Math.max(0, conversation.length - 64) && remainingChars > 0; i--) {
    const message = conversation[i];
    const text = typeof message?.content === 'string' ? message.content : '';
    const content = text.slice(-Math.min(16_384, remainingChars));
    remainingChars -= content.length;
    if (!content) continue;
    for (const match of content.matchAll(SEED_PATH_PATTERN)) {
      if (seeds.size >= 64 || ++candidates > 256) return [...seeds];
      const candidate = match[0].replace(/\\/g, '/');
      // Only repo-relative paths count; strip a leading ./ or project prefix.
      const normalized = candidate.replace(/^\.\//, '');
      if (normalized.length > 4_096 || normalized.startsWith('/') ||
          /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) continue;
      seeds.add(normalized);
    }
  }
  return [...seeds].slice(0, 64);
}

export async function buildRepoMapPreamble(
  projectRoot: string,
  options: RepoMapPreambleOptions = {},
): Promise<string> {
  // Primary: tree-sitter + PageRank map under a token budget. When no files
  // are seeded from chat, expand the budget (Aider behavior) so the map still
  // orients the model.
  const seedCount = options.seedFiles?.length ?? 0;
  const budget =
    options.budgetTokens ?? (seedCount > 0 ? 1_000 : 2_000);
  try {
    const outcome = await buildRepoMapGraphDetailed(projectRoot, {
      budgetTokens: budget,
      maxFiles: REPO_MAP_FILE_CAP,
      includeLegacyFallback: true,
      ...(options.seedFiles ? { seedFiles: options.seedFiles } : {}),
      ...(options.mentionedIdents ? { mentionedIdents: options.mentionedIdents } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.maxDurationMs !== undefined ? { maxDurationMs: options.maxDurationMs } : {}),
    });
    try { options.onGraphOutcome?.(graphDiagnostic(outcome)); } catch { /* Diagnostics must not change the map. */ }
    if (outcome.status === 'ok' && outcome.result.map.trim().length > 0) {
      return outcome.result.map.trimEnd();
    }
    if ('fallback' in outcome && outcome.fallback) return outcome.fallback;
  } catch {
    // Failed or timed-out workers must never leave a partial graph behind.
  }
  return '## Repository Map';
}

/** Packet B5 repo-map preamble sized from resident conversation history. */
export async function buildChatEngineRepoMapPreamble(
  projectRoot: string,
  conversation: ReadonlyArray<{ role: string; content: string }>,
  contextWindowTokens: number,
  userInput?: string,
  options: Pick<RepoMapPreambleOptions, 'signal' | 'maxDurationMs' | 'onGraphOutcome'> = {},
): Promise<string> {
  if (options.signal?.aborted) {
    try { options.onGraphOutcome?.({ status: 'cancelled', reason: 'aborted' }); } catch { /* Best effort. */ }
    return '## Repository Map';
  }
  const seedFiles = collectChatSeedFiles(
    userInput
      ? [...conversation, { role: 'user', content: userInput }]
      : conversation,
    projectRoot,
  );
  try {
    const mapBudget = computePreambleBudget({
      historyTokens: estimateTokens(conversation as ChatMessage[]),
      contextWindowTokens,
    });
    return await buildRepoMapPreamble(projectRoot, {
      seedFiles,
      budgetTokens: mapBudget.maxMapTokens,
      ...options,
    });
  } catch {
    return '';
  }
}
