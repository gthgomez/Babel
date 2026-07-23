// ─── Types ────────────────────────────────────────────────────────────────────

export type SectionType = 'system' | 'tools' | 'rules' | 'context' | 'conversation' | 'user';

export interface PromptSection {
  /** Semantic type of this section (determines ordering priority) */
  type: SectionType;
  /** The actual text content */
  content: string;
  /** Optional stable identifier for cross-session cache tracking */
  cacheKey?: string;
}

export interface OrderedPrompt {
  /** Ordered sections (cacheable first, dynamic last) */
  sections: PromptSection[];
  /** Estimated token count of the cacheable prefix (system + tools + rules + context) */
  cacheableTokens: number;
  /** Estimated token count of the dynamic suffix (conversation + user) */
  dynamicTokens: number;
  /** Total estimated token count */
  totalTokens: number;
  /** Estimated cache hit ratio (0-1) based on section ordering */
  estimatedCacheHitRatio: number;
}

// ─── Ordering priority ────────────────────────────────────────────────────────

/**
 * Priority order for prompt sections. Lower number = earlier in prompt = better caching.
 * Sections at the same priority are stable-sorted (preserving input order).
 */
const SECTION_PRIORITY: Record<SectionType, number> = {
  system: 0, // Almost never changes — ideal cache anchor
  tools: 1, // Rarely changes within a session
  rules: 2, // May change per-project, stable within session
  context: 3, // Project-specific files, stable per-session
  conversation: 4, // Changes with each turn
  user: 5, // Always new
};

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Rough token count estimation: ~4 chars per token for English text.
 * This is a fast approximation — not as accurate as a real tokenizer
 * but good enough for cache boundary decisions.
 */
function estimateTokens(text: string): number {
  // Average: 4 characters per token for English code/text
  // Add 10% overhead for code-heavy content
  return Math.ceil(text.length / 4);
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Order prompt sections to maximize DeepSeek KV cache hits.
 *
 * DeepSeek (and most LLMs) cache KV states for unchanged prompt prefixes.
 * By placing static content first and dynamic content last, the cacheable
 * prefix stays identical between turns in a conversation, achieving ~90%
 * token cost reduction on repeated prefixes.
 *
 * Usage:
 * ```typescript
 * const ordered = orderPromptForCache([
 *   { type: 'system', content: systemPrompt },
 *   { type: 'tools', content: toolDefinitions },
 *   { type: 'rules', content: projectRules },
 *   { type: 'conversation', content: historyText },
 *   { type: 'user', content: userMessage },
 * ]);
 * const finalPrompt = ordered.sections.map(s => s.content).join('\n\n');
 * ```
 */
export function orderPromptForCache(sections: PromptSection[]): OrderedPrompt {
  // Stable sort: sections at the same priority keep their original order
  const ordered = [...sections].sort((a, b) => {
    const pa = SECTION_PRIORITY[a.type] ?? 99;
    const pb = SECTION_PRIORITY[b.type] ?? 99;
    return pa - pb;
  });

  // Estimate tokens for cacheable vs dynamic sections
  let cacheableTokens = 0;
  let dynamicTokens = 0;

  for (const section of ordered) {
    const tokens = estimateTokens(section.content);
    if (SECTION_PRIORITY[section.type] <= SECTION_PRIORITY['context']) {
      cacheableTokens += tokens;
    } else {
      dynamicTokens += tokens;
    }
  }

  const totalTokens = cacheableTokens + dynamicTokens;

  // Estimated cache hit ratio: cacheable prefix / total
  // In practice, the conversation section is the largest, so this ratio
  // represents the approximate savings from prefix caching.
  const estimatedCacheHitRatio = totalTokens > 0 ? cacheableTokens / totalTokens : 0;

  return {
    sections: ordered,
    cacheableTokens,
    dynamicTokens,
    totalTokens,
    estimatedCacheHitRatio,
  };
}

/**
 * Build a prompt string from ordered sections.
 */
export function buildOrderedPrompt(sections: PromptSection[], separator = '\n\n'): string {
  const ordered = orderPromptForCache(sections);
  return ordered.sections.map((s) => s.content).join(separator);
}

/**
 * Compute a stable cache key from the cacheable sections.
 * This can be used to detect when the cacheable prefix has actually changed
 * (e.g., new tools, different rules) vs. just the conversation continuing.
 */
export function computeCachePrefixKey(sections: PromptSection[]): string {
  const ordered = orderPromptForCache(sections);
  const cacheable = ordered.sections.filter(
    (s) => SECTION_PRIORITY[s.type] <= SECTION_PRIORITY['context'],
  );
  // Use section type + content length as a fast fingerprint
  return cacheable.map((s) => `${s.type}:${s.content.length}`).join('|');
}

/**
 * Estimate the cost savings from cache-aware ordering.
 *
 * @param cacheHitRatio — ratio of cacheable tokens to total (from orderPromptForCache)
 * @param inputCostPer1k — cost per 1000 input tokens (e.g., DeepSeek = $0.14)
 * @returns Estimated savings as a fraction (0-1) of input cost
 */
export function estimateCacheSavings(
  cacheHitRatio: number,
  _inputCostPer1k?: number,
): { savingsRatio: number; description: string } {
  // DeepSeek caches hit for ~90% of the cacheable prefix in practice
  // (not 100% because the first turn always misses, and cache eviction happens)
  const effectiveCacheHitRate = cacheHitRatio * 0.9;

  return {
    savingsRatio: effectiveCacheHitRate,
    description:
      effectiveCacheHitRate > 0.3
        ? `Cache-aware ordering saves ~${Math.round(effectiveCacheHitRate * 100)}% of input token cost on repeated prefixes.`
        : effectiveCacheHitRate > 0.1
          ? `Cache-aware ordering provides modest savings (~${Math.round(effectiveCacheHitRate * 100)}%).`
          : 'Cache savings are minimal for this prompt structure.',
  };
}

// ─── Section builders ─────────────────────────────────────────────────────────

/**
 * Build a system prompt section.
 */
export function systemSection(content: string, cacheKey?: string): PromptSection {
  const section: PromptSection = { type: 'system', content };
  if (cacheKey !== undefined) section.cacheKey = cacheKey;
  return section;
}

/**
 * Build a tools definition section.
 */
export function toolsSection(content: string, cacheKey?: string): PromptSection {
  const section: PromptSection = { type: 'tools', content };
  if (cacheKey !== undefined) section.cacheKey = cacheKey;
  return section;
}

/**
 * Build a rules/policies section.
 */
export function rulesSection(content: string, cacheKey?: string): PromptSection {
  const section: PromptSection = { type: 'rules', content };
  if (cacheKey !== undefined) section.cacheKey = cacheKey;
  return section;
}

/**
 * Build a project context section (CLAUDE.md, repo context, etc.).
 */
export function contextSection(content: string, cacheKey?: string): PromptSection {
  const section: PromptSection = { type: 'context', content };
  if (cacheKey !== undefined) section.cacheKey = cacheKey;
  return section;
}

/**
 * Build a conversation history section.
 */
export function conversationSection(content: string): PromptSection {
  return { type: 'conversation', content };
}

/**
 * Build a user message section.
 */
export function userSection(content: string): PromptSection {
  return { type: 'user', content };
}
