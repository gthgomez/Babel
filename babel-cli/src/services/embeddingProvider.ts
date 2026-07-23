/**
 * Embedding provider for semantic search (R2.5).
 *
 * Supplies a text→Float32Array function that `VectorIndex.indexEmbeddings()`
 * and `SemanticIndexer.search()` consume. Currently implements the OpenAI
 * embeddings API (`text-embedding-3-small`, 384-dim).
 *
 * ## Graceful no-op
 *
 * When `OPENAI_API_KEY` is unset or `BABEL_EMBEDDING_DISABLE=1`, the factory
 * returns `null` and the embedding path is silently skipped. FTS5 full-text
 * search remains the fallback (see `SemanticIndexer.search()`).
 *
 * ## Configuration
 *
 * All configuration is via environment variables (no config file changes needed):
 *
 *   OPENAI_API_KEY           — required; embedding disabled when unset
 *   BABEL_EMBEDDING_DISABLE   — set to "1" to skip embedding entirely
 *   BABEL_EMBEDDING_MODEL     — model name (default: text-embedding-3-small)
 *   BABEL_EMBEDDING_BASE_URL  — API base URL (default: https://api.openai.com/v1)
 *   BABEL_EMBEDDING_DIMENSIONS — must match vec0 table FLOAT[N] (default: 384)
 *   BABEL_EMBEDDING_API_KEY   — overrides OPENAI_API_KEY when set
 *
 * ## Retry policy
 *
 * HTTP 429 (rate limit) and 5xx (server error) are retried up to 3 times
 * with exponential backoff (1s / 2s / 4s). Other errors fail immediately.
 *
 * @module embeddingProvider
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /**
   * Generate embeddings for one or more texts.
   *
   * Returns an array of Float32Arrays, one per input text, in the same order.
   * The dimension of each vector matches the configured embedding model
   * (default 384 for text-embedding-3-small).
   *
   * Throws on network errors after retry exhaustion. Callers should wrap in
   * try/catch and fall back to FTS5.
   */
  embedTexts(texts: string[]): Promise<Float32Array[]>;
}

interface OpenAiEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveApiKey(): string | null {
  if (process.env['BABEL_EMBEDDING_API_KEY']?.trim()) {
    return process.env['BABEL_EMBEDDING_API_KEY'].trim();
  }
  if (process.env['OPENAI_API_KEY']?.trim()) {
    return process.env['OPENAI_API_KEY'].trim();
  }
  return null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Provider Implementation ──────────────────────────────────────────────────

class OpenAiEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model ?? (process.env['BABEL_EMBEDDING_MODEL']?.trim() || DEFAULT_MODEL);
    this.baseUrl = baseUrl ?? (process.env['BABEL_EMBEDDING_BASE_URL']?.trim() || DEFAULT_BASE_URL);
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const url = `${this.baseUrl.replace(/\/$/, '')}/embeddings`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
            dimensions: DEFAULT_DIMENSIONS,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        if (response.ok) {
          const body = (await response.json()) as OpenAiEmbeddingResponse;
          // Sort by index to preserve input order, then extract embeddings
          const sorted = [...body.data].sort((a, b) => a.index - b.index);
          return sorted.map((item) => new Float32Array(item.embedding));
        }

        // Retryable errors
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(
            `OpenAI embedding API returned ${response.status}: ${await response.text().catch(() => '(no body)')}`,
          );
          if (attempt < MAX_RETRIES) {
            await sleep(RETRY_DELAYS_MS[attempt]!);
            continue;
          }
          throw lastError;
        }

        // Non-retryable errors
        throw new Error(
          `OpenAI embedding API returned ${response.status}: ${await response.text().catch(() => '(no body)')}`,
        );
      } catch (err) {
        if (attempt < MAX_RETRIES && err instanceof Error && !err.message.startsWith('OpenAI embedding API returned 4')) {
          lastError = err instanceof Error ? err : new Error(String(err));
          await sleep(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw err;
      }
    }

    // Should not be reachable, but satisfy TypeScript
    throw lastError ?? new Error('OpenAI embedding API: unknown error');
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create an embedding provider from environment configuration.
 *
 * Returns `null` when:
 * - `OPENAI_API_KEY` and `BABEL_EMBEDDING_API_KEY` are both unset/empty
 * - `BABEL_EMBEDDING_DISABLE` is set to "1" or "true"
 *
 * Callers should treat `null` as "embeddings unavailable — skip the vector path."
 */
export function createEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env['BABEL_EMBEDDING_DISABLE'] === '1' || process.env['BABEL_EMBEDDING_DISABLE'] === 'true') {
    return null;
  }

  const apiKey = resolveApiKey();
  if (!apiKey) return null;

  // Key check: must not be the placeholder value from .env
  if (apiKey === 'replace_with_your_openai_key') return null;

  return new OpenAiEmbeddingProvider(apiKey);
}
