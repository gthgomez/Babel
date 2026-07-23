/**
 * chatCompaction.ts — LLM-based conversation compaction for the ChatEngine.
 *
 * Replaces heuristic truncation with intelligent summarization that preserves
 * key context while reducing token usage. Provides pluggable strategies through
 * a CompactionStrategy interface, with LLM summarization as the primary strategy
 * and heuristic truncation as the fallback.
 *
 * Architecture:
 *
 *   CompactionManager (orchestrator)
 *     ├── LLMSummarizeCompaction (primary — calls a cheap LLM)
 *     └── HeuristicTruncationStrategy (fallback — drops oldest messages)
 *
 * Prompt flow:
 *   1. Identify messages eligible for compaction (old messages before the
 *      "working set" of recent messages)
 *   2. Build a summary prompt from those messages
 *   3. Call the compaction LLM (cheap model, e.g. Haiku or Qwen3)
 *   4. Replace compacted messages with a single system message containing
 *      the structured summary
 *   5. Preserve the working set (most recent messages) intact
 *
 * Invariants:
 *   - Never loses the system prompt or initial instructions
 *   - Never compacts mid-turn (only between turns)
 *   - Tool call/result pairs stay together
 *   - Compaction failure falls back to heuristic truncation
 */

import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Lightweight message shape for compaction. Mirrors the ChatMessage type
 * from chatToolDefinitions.ts without the import dependency to keep the
 * compaction module self-contained.
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  name?: string;
}

export interface CompactionOptions {
  /** Model ID to use for summarization (e.g. 'Qwen/Qwen3-32B-Instruct') */
  model: string;
  /** Maximum tokens for the compacted context */
  maxTokens: number;
  /** Target tokens for the summary message itself */
  targetTokens?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface CompactionStrategy {
  /** Human-readable strategy name for logging and debugging */
  name: string;
  /** Whether this strategy can be applied to the given messages */
  canApply(messages: ChatMessage[], estimatedTokens: number, maxTokens: number): boolean;
  /** Apply compaction and return the compacted message list */
  compact(messages: ChatMessage[], options: CompactionOptions): Promise<ChatMessage[]>;
}

// ─── Default Configuration ──────────────────────────────────────────────────

export const DEFAULT_COMPACTION_CONFIG = {
  /** Max tokens before compaction is triggered */
  triggerTokens: 100_000,
  /** Reserve this many tokens for the model's response */
  reserveTokens: 8_000,
  /** Keep at least this many recent messages intact */
  keepRecentMessages: 4,
  /** Max tokens for the summary message itself */
  maxSummaryTokens: 4_000,
  /** Use a smaller/faster model for compaction */
  compactionModel: 'Qwen/Qwen3-32B-Instruct',
  /** Enable LLM compaction (can be disabled by env var) */
  enabled: true,
};

// ─── Token Estimation Utilities ─────────────────────────────────────────────

/**
 * Roughly estimate the token count of a message list.
 *
 * Uses a simple heuristic: ~4 characters per token for general text, plus
 * ~4 tokens overhead per message for role markers and structure. This is
 * intentionally conservative (overestimates) to avoid exceeding context limits.
 *
 * For more accurate counts, pass the messages through a tokenizer; this
 * heuristic is sufficient for compaction decisions.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Approximately 1 token per 4 characters for general text
    total += Math.ceil(msg.content.length / 4);
    // Per-message structural overhead (role, metadata)
    total += 4;
  }
  return total;
}

/**
 * Determine whether compaction is needed based on estimated token usage.
 *
 * @param messages       The full conversation history
 * @param maxTokens      Maximum allowed tokens for the context
 * @param reserveTokens  Tokens to reserve for the model's response
 * @returns              true if compaction should be triggered
 */
export function shouldCompact(
  messages: ChatMessage[],
  maxTokens: number,
  reserveTokens: number,
): boolean {
  const estimated = estimateTokens(messages);
  const budget = maxTokens - reserveTokens;
  return estimated > budget;
}

/**
 * Calculate the target token budget for a summary message.
 *
 * Given the oldest index to compact from, computes how many tokens the
 * summary should target, accounting for the tokens consumed by the
 * working set of recent messages.
 *
 * @param oldestIndex  Index of the first message to compact
 * @param messages     Full conversation
 * @param maxTokens    Maximum allowed context tokens
 * @returns            Target token count for the summary (clamped [500, maxSummaryTokens])
 */
export function compactionTarget(
  oldestIndex: number,
  messages: ChatMessage[],
  maxTokens: number,
): number {
  const recentMessages = messages.slice(oldestIndex);
  const recentTokens = estimateTokens(recentMessages);
  const buffer = 1_000; // safety margin
  const target = maxTokens - recentTokens - buffer;
  return Math.max(500, Math.min(target, DEFAULT_COMPACTION_CONFIG.maxSummaryTokens));
}

// ─── Compaction Prompt ──────────────────────────────────────────────────────

/**
 * Build the summary prompt for the compaction LLM.
 *
 * Constructs a prompt that asks the model to compress the given conversation
 * history into a structured summary preserving key context.
 *
 * @param messages  The messages to summarize
 * @param maxTokens Target maximum tokens for the summary
 * @returns         The formatted prompt string
 */
export function buildCompactionPrompt(messages: ChatMessage[], maxTokens: number): string {
  const conversationText = messages
    .map((m) => {
      const role = m.role.toUpperCase();
      let label = role;
      if (m.name) label += ` (${m.name})`;
      return `<${label}>\n${m.content}\n</${label}>`;
    })
    .join('\n\n');

  return `You are a conversation summarizer. Compress the following conversation history into a concise structured summary. Preserve key decisions, code changes, file paths, and unresolved questions. Drop redundant exchanges, pleasantries, and off-topic digressions.

## Output format
Provide your summary using these sections (omit any section that has no content):

KEY_DECISIONS:
- <decision 1>
- <decision 2>

CODE_CHANGES:
- <file path: description of change>
- <file path: description of change>

TOOLS_USED:
- <tool name: key result>

UNRESOLVED:
- <open question or ongoing work>

CONTEXT:
<2-3 sentence paragraph describing the current state>

## Constraints
- Stay under ${maxTokens} tokens
- Be specific — include function names, variable names, error messages, and paths
- Omit meta-commentary about the summary itself

## Conversation to summarize:

${conversationText}`;
}

// ─── Heuristic Truncation Strategy (Fallback) ──────────────────────────────

/**
 * HeuristicTruncationStrategy — drops oldest messages when compaction is needed.
 *
 * This is the current behavior of ChatEngine.compactConversation(), extracted
 * into its own strategy. It preserves the system prompt and tool_use/tool_result
 * pairs while dropping the oldest messages from the conversation window.
 *
 * Used as a fallback when:
 *   - LLM compaction fails (API error, timeout)
 *   - The user has disabled LLM compaction via BABEL_COMPACTION=off
 *   - No API key is configured for the LLM summarizer
 */
export class HeuristicTruncationStrategy implements CompactionStrategy {
  readonly name = 'heuristic-truncation';

  private readonly keepRecentMessages: number;

  constructor(keepRecentMessages?: number) {
    this.keepRecentMessages = keepRecentMessages ?? DEFAULT_COMPACTION_CONFIG.keepRecentMessages;
  }

  canApply(_messages: ChatMessage[], estimatedTokens: number, maxTokens: number): boolean {
    return estimatedTokens > maxTokens;
  }

  async compact(messages: ChatMessage[], _options: CompactionOptions): Promise<ChatMessage[]> {
    const keepCount = Math.max(this.keepRecentMessages, 2);

    // Find and preserve the system message
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    const systemMsg = systemIdx >= 0 ? messages[systemIdx]! : undefined;

    // Calculate the trim point
    let startIdx = messages.length - keepCount;
    if (startIdx <= (systemMsg ? systemIdx + 1 : 0)) {
      // Can't drop below the system message — return as-is
      return messages;
    }

    // Preserve tool_use/tool_result pairs: if the first kept message is a
    // tool result, extend backward to include its parent assistant message.
    const firstKept = messages[startIdx];
    if (firstKept && firstKept.role === 'tool') {
      for (let i = startIdx - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant' && m.name === 'tool_calls') {
          startIdx = i;
          break;
        }
      }
    }

    const result = systemMsg
      ? [systemMsg, ...messages.slice(startIdx)]
      : messages.slice(startIdx);

    return result;
  }
}

// ─── LLM Summarize Compaction (Primary) ─────────────────────────────────────

/**
 * Provider configuration for LLM-based compaction.
 */
export interface LlmCompactionProvider {
  /** Base URL for the chat completions API */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Default model ID if none is specified in options */
  defaultModel: string;
}

/**
 * Result from calling the compaction LLM.
 */
interface CompactionApiResult {
  summary: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * LLMSummarizeCompaction — uses a cheap LLM to summarize old conversation
 * history into a concise structured summary.
 *
 * Strategy:
 *   1. Identify messages to compact (everything before the working set, minus
 *      the system prompt)
 *   2. Build a summary prompt from those messages
 *   3. Call the compaction LLM (cheap model to keep costs low)
 *   4. Replace compacted messages with a single system message containing
 *      the structured summary
 *   5. Preserve the working set (most recent messages) intact
 *
 * Error handling:
 *   - If the API call fails, the strategy returns null via canApply() on the
 *     next call (after consecutive failures)
 *   - If the API returns an empty summary, falls back to a simple annotation
 */
export class LLMSummarizeCompaction implements CompactionStrategy {
  readonly name = 'llm-summarize';

  private readonly keepRecentMessages: number;
  private readonly maxSummaryTokens: number;
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;

  constructor(options?: {
    keepRecentMessages?: number;
    maxSummaryTokens?: number;
  }) {
    this.keepRecentMessages = options?.keepRecentMessages ?? DEFAULT_COMPACTION_CONFIG.keepRecentMessages;
    this.maxSummaryTokens = options?.maxSummaryTokens ?? DEFAULT_COMPACTION_CONFIG.maxSummaryTokens;
  }

  canApply(_messages: ChatMessage[], estimatedTokens: number, maxTokens: number): boolean {
    // Check env var override
    if (process.env['BABEL_COMPACTION'] === 'off') return false;

    // Check that we have an API key available
    if (!this.resolveApiKey()) return false;

    // Circuit breaker: skip after too many consecutive failures
    if (this.consecutiveFailures >= LLMSummarizeCompaction.MAX_CONSECUTIVE_FAILURES) {
      return false;
    }

    // Only apply when we actually need compaction
    return estimatedTokens > maxTokens;
  }

  async compact(messages: ChatMessage[], options: CompactionOptions): Promise<ChatMessage[]> {
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    const systemMsg = systemIdx >= 0 ? messages[systemIdx]! : undefined;

    // Determine the compact boundary: keep the last N messages as the working set
    const workingSetSize = Math.max(this.keepRecentMessages, 2);
    let compactBoundary = messages.length - workingSetSize;

    // Don't compact if there's nothing to compact, or if the boundary
    // is within or before the system message
    if (compactBoundary <= (systemMsg ? systemIdx + 1 : 0)) {
      return messages;
    }

    // Preserve tool_use/tool_result pairs at the boundary
    const boundaryMsg = messages[compactBoundary];
    if (boundaryMsg && boundaryMsg.role === 'tool') {
      for (let i = compactBoundary - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant' && m.name === 'tool_calls') {
          compactBoundary = i;
          break;
        }
      }
    }

    // Messages to compact: everything between system prompt and working set
    const compactStart = systemMsg ? systemIdx + 1 : 0;
    const toCompact = messages.slice(compactStart, compactBoundary);
    const workingSet = messages.slice(compactBoundary);

    // If nothing to compact, return unchanged
    if (toCompact.length === 0) {
      return messages;
    }

    try {
      // Call the LLM to produce a summary
      const targetTokens = options.targetTokens ?? this.maxSummaryTokens;
      const summaryResult = await this.callCompactionApi(toCompact, targetTokens, options);

      // Build the compacted result: system prompt + summary message + working set
      const summaryMessage: ChatMessage = {
        role: 'system',
        content: `[Compacted conversation summary — ${summaryResult.inputTokens} input → ${summaryResult.outputTokens} output tokens]\n\n${summaryResult.summary}`,
        name: 'compaction_summary',
      };

      this.consecutiveFailures = 0;
      return systemMsg
        ? [systemMsg, summaryMessage, ...workingSet]
        : [summaryMessage, ...workingSet];
    } catch (err) {
      this.consecutiveFailures++;
      // Fall back to a simple annotation
      const annotation: ChatMessage = {
        role: 'system',
        content: `[Compacted ${toCompact.length} messages — LLM summarization failed: ${err instanceof Error ? err.message : String(err)}]`,
        name: 'compaction_fallback',
      };
      return systemMsg
        ? [systemMsg, annotation, ...workingSet]
        : [annotation, ...workingSet];
    }
  }

  /** Reset the consecutive failure counter (useful for testing). */
  resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
  }

  /** Get the current consecutive failure count. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Resolve the API key for the compaction LLM.
   * Checks environment variables in order: BABEL_COMPACTION_API_KEY,
   * DEEPINFRA_API_KEY, ANTHROPIC_API_KEY.
   *
   * Uses || (not ??) so that empty string "" is treated as unset,
   * matching the convention in every other API runner in the codebase
   * (deepInfraApi, openAiApi, geminiApi, deepSeekApi).
   */
  private resolveApiKey(): string | undefined {
    return (
      process.env['BABEL_COMPACTION_API_KEY'] ||
      process.env['DEEPINFRA_API_KEY'] ||
      process.env['ANTHROPIC_API_KEY']
    );
  }

  /**
   * Resolve the compaction config from a single env snapshot so apiKey and
   * baseUrl are always derived from the same set of environment variables.
   */
  private resolveCompactionConfig(): { apiKey: string | undefined; baseUrl: string } {
    const apiKey =
      process.env['BABEL_COMPACTION_API_KEY'] ||
      process.env['DEEPINFRA_API_KEY'] ||
      process.env['ANTHROPIC_API_KEY'];

    let baseUrl = process.env['BABEL_COMPACTION_API_BASE'];
    if (!baseUrl) {
      const hasAnthropicKey =
        process.env['BABEL_COMPACTION_API_KEY'] ||
        process.env['ANTHROPIC_API_KEY'];
      baseUrl =
        hasAnthropicKey && !process.env['DEEPINFRA_API_KEY']
          ? 'https://api.anthropic.com'
          : 'https://api.deepinfra.com/v1/openai/chat/completions';
    }
    return { apiKey, baseUrl };
  }

  /**
   * Resolve the API base URL from environment or provider type.
   */
  private resolveApiBaseUrl(): string {
    return this.resolveCompactionConfig().baseUrl;
  }

  /**
   * Resolve the effective model ID.
   * Priority: options.model > BABEL_COMPACTION_MODEL > DEFAULT
   */
  private resolveModel(options: CompactionOptions): string {
    return (
      options.model ??
      process.env['BABEL_COMPACTION_MODEL'] ??
      DEFAULT_COMPACTION_CONFIG.compactionModel
    );
  }

  /**
   * Call the compaction LLM API.
   *
   * Supports:
   *   - OpenAI-compatible APIs (DeepInfra, etc.) via chat/completions
   *   - Anthropic Messages API
   *
   * Detects the API type from the base URL and formats the request accordingly.
   */
  private async callCompactionApi(
    toCompact: ChatMessage[],
    targetTokens: number,
    options: CompactionOptions,
  ): Promise<CompactionApiResult> {
    const apiKey = this.resolveApiKey()!;
    const baseUrl = this.resolveApiBaseUrl();
    const model = this.resolveModel(options);
    const isAnthropic = baseUrl.includes('anthropic.com');
    const signal = options.signal;

    const prompt = buildCompactionPrompt(toCompact, targetTokens);

    if (isAnthropic) {
      return this.callAnthropicApi(prompt, model, apiKey, signal);
    }
    return this.callOpenAiCompatibleApi(prompt, model, apiKey, baseUrl, signal);
  }

  /**
   * Call an OpenAI-compatible chat completions API (e.g. DeepInfra).
   */
  private async callOpenAiCompatibleApi(
    prompt: string,
    model: string,
    apiKey: string,
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<CompactionApiResult> {
    const timeoutMs = 30_000; // compaction should be fast
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let onExternalAbort: (() => void) | undefined;
    if (signal) {
      onExternalAbort = () => controller.abort();
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: this.maxSummaryTokens,
          temperature: 0.3, // low but non-zero for creative summarization
          messages: [
            {
              role: 'system',
              content: 'You are a precise conversation summarizer. Output only the structured summary with no additional commentary.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Compaction API error (${response.status}): ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const summary = data?.choices?.[0]?.message?.content ?? '';
      if (!summary.trim()) {
        throw new Error('Compaction API returned empty summary');
      }

      return {
        summary: summary.trim(),
        inputTokens: data?.usage?.prompt_tokens ?? 0,
        outputTokens: data?.usage?.completion_tokens ?? 0,
      };
    } finally {
      clearTimeout(timeout);
      if (signal && onExternalAbort) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * Call the Anthropic Messages API.
   */
  private async callAnthropicApi(
    prompt: string,
    model: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<CompactionApiResult> {
    const timeoutMs = 30_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let onExternalAbort: (() => void) | undefined;
    if (signal) {
      onExternalAbort = () => controller.abort();
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: this.maxSummaryTokens,
          temperature: 0.3,
          system: 'You are a precise conversation summarizer. Output only the structured summary with no additional commentary.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Compaction Anthropic API error (${response.status}): ${body.slice(0, 200)}`);
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const summary =
        data?.content
          ?.filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n') ?? '';

      if (!summary.trim()) {
        throw new Error('Compaction Anthropic API returned empty summary');
      }

      return {
        summary: summary.trim(),
        inputTokens: data?.usage?.input_tokens ?? 0,
        outputTokens: data?.usage?.output_tokens ?? 0,
      };
    } finally {
      clearTimeout(timeout);
      if (signal && onExternalAbort) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }
}

// ─── Compaction Manager ─────────────────────────────────────────────────────

/**
 * CompactionManager — orchestrates compaction by trying strategies in order.
 *
 * Strategies are tried in registration order. The first strategy whose
 * canApply() returns true is used. If compact() fails (throws), the next
 * strategy is tried as a fallback.
 *
 * Default strategy order:
 *   1. LLMSummarizeCompaction — intelligent LLM-based summarization
 *   2. HeuristicTruncationStrategy — safe fallback (drop oldest messages)
 */
export class CompactionManager {
  private strategies: CompactionStrategy[];

  constructor(strategies?: CompactionStrategy[]) {
    this.strategies = strategies ?? [
      new LLMSummarizeCompaction(),
      new HeuristicTruncationStrategy(),
    ];
  }

  /**
   * Auto-select and apply the best compaction strategy.
   *
   * Tries each registered strategy in order:
   *   1. Checks canApply() — if false, skips to next strategy
   *   2. Calls compact() — if it throws, tries the next strategy
   *   3. Returns the compacted message list from the first successful strategy
   *
   * If ALL strategies fail, returns the original messages unchanged (safe
   * no-op rather than breaking the conversation).
   *
   * @param messages  The full conversation history
   * @param options   Compaction options (model, maxTokens, etc.)
   * @returns         The compacted message list
   */
  async compact(messages: ChatMessage[], options: CompactionOptions): Promise<ChatMessage[]> {
    const estimatedTokens = estimateTokens(messages);
    const errors: string[] = [];

    for (const strategy of this.strategies) {
      if (!strategy.canApply(messages, estimatedTokens, options.maxTokens)) {
        continue;
      }

      try {
        const result = await strategy.compact(messages, options);
        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`[${strategy.name}] ${errMsg}`);
        // Continue to next strategy
      }
    }

    // If all strategies failed, log and return original messages
    if (errors.length > 0) {
      console.warn(`[CompactionManager] All strategies failed:\n  ${errors.join('\n  ')}`);
    }
    return messages;
  }

  /**
   * Register a custom strategy. Added strategies are tried before existing
   * ones (prepended to the front of the list).
   */
  register(strategy: CompactionStrategy): void {
    this.strategies.unshift(strategy);
  }

  /** Get the list of registered strategies (for inspection). */
  getStrategies(): readonly CompactionStrategy[] {
    return [...this.strategies];
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the index of the first message that should be preserved after compaction.
 *
 * Scans backward from the end of the message list to determine how many
 * recent messages constitute the "working set" that should never be compacted.
 * Accounts for tool_use/tool_result pairing at the boundary.
 *
 * @param messages           The full conversation
 * @param keepRecentMessages Number of recent messages to preserve
 * @returns                  Index of the first message in the working set
 */
export function findCompactBoundary(
  messages: ChatMessage[],
  keepRecentMessages: number = DEFAULT_COMPACTION_CONFIG.keepRecentMessages,
): number {
  const systemIdx = messages.findIndex((m) => m.role === 'system');
  const workingSetSize = Math.max(keepRecentMessages, 2);
  let boundary = messages.length - workingSetSize;

  // Don't compact past the system message
  const minBoundary = systemIdx >= 0 ? systemIdx + 1 : 0;
  if (boundary <= minBoundary) {
    return messages.length; // nothing to compact
  }

  // Preserve tool pairs at the boundary
  const boundaryMsg = messages[boundary];
  if (boundaryMsg && boundaryMsg.role === 'tool') {
    for (let i = boundary - 1; i >= minBoundary; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant' && m.name === 'tool_calls') {
        boundary = i;
        break;
      }
    }
  }

  return boundary;
}
