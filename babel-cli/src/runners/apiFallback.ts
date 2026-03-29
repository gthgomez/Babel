/**
 * apiFallback.ts — Anthropic API Fallback Runner
 *
 * Implements `LlmRunner` using the official `@anthropic-ai/sdk`. This runner
 * is the guaranteed completion path — it activates when the Claude CLI runner
 * is unavailable, rate-limited, or produces unparseable output.
 *
 * Configuration (environment variables):
 *   ANTHROPIC_API_KEY  - Required. Set in your local .env file.
 *   BABEL_API_MODEL    - Model ID. Default: "claude-sonnet-4-6"
 *   BABEL_API_TOKENS   - max_tokens for responses. Default: 8096
 *
 * JSON output strategy:
 *   A terse system prompt reinforces JSON-only output without conflicting with
 *   the domain-specific instructions already embedded in the compiled context.
 *   `extractJson` is still applied to tolerate any markdown fencing the model
 *   adds despite the system prompt instruction.
 *
 * Error policy:
 *   Any Anthropic SDK error (network, auth, quota) is re-thrown with a
 *   "[apiFallback]" prefix. If both CLI and API fail, `runWithFallback` lets
 *   the error propagate to the caller.
 */

import Anthropic       from '@anthropic-ai/sdk';
import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner } from './base.js';
import { extractJson }    from '../utils/extractJson.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const API_MODEL  = process.env['BABEL_API_MODEL']  ?? 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env['BABEL_API_TOKENS'] ?? '8096');

/**
 * Terse system prompt that reinforces JSON-only output without overriding
 * the domain-specific agent instructions in the compiled context. Kept
 * deliberately short so it does not crowd the instruction hierarchy.
 */
const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only — ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

// ─── Runner implementation ────────────────────────────────────────────────────

export class ApiFallbackRunner implements LlmRunner {
  private readonly client: Anthropic;

  constructor() {
    if (!process.env['ANTHROPIC_API_KEY']) {
      throw new Error(
        '[apiFallback] ANTHROPIC_API_KEY is not set. ' +
        'Add it to your .env file to enable the API fallback runner.',
      );
    }
    this.client = new Anthropic({
      apiKey: process.env['ANTHROPIC_API_KEY'],
    });
  }

  /**
   * Submits the compiled prompt to the Anthropic Messages API, extracts JSON
   * from the response, and validates it against the provided Zod schema.
   *
   * @throws {Error} On API errors, JSON extraction failure, or Zod validation
   *                 failure — all prefixed with "[apiFallback]".
   */
  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    let response: Anthropic.Message;

    try {
      response = await this.client.messages.create({
        model:      API_MODEL,
        max_tokens: MAX_TOKENS,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      throw new Error(
        `[apiFallback] Anthropic API call failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Collect all text blocks from the response content array.
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('');

    if (!text.trim()) {
      throw new Error('[apiFallback] API returned an empty response.');
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw new Error(
        `[apiFallback] invalid json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `[apiFallback] Zod validation failed:\n${result.error.toString()}`,
      );
    }

    return result.data;
  }
}
