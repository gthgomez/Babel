/**
 * openAiApi.ts — OpenAI API Runner (Structural Backup — Tier 2)
 *
 * Calls the OpenAI Chat Completions API using Node.js native `fetch` (≥ 20).
 * No extra npm package required.
 *
 * This is the backup runner for the structural waterfall, activated when the
 * primary Groq API fails or is unavailable. Designed for pure JSON-output
 * tasks (Orchestrator, QA Reviewer, Executor turns) where a reasoning model
 * that strictly follows schemas is more valuable than raw throughput.
 *
 * Configuration (environment variables):
 *   OPENAI_API_KEY        — Required. Set in your local .env file.
 *   BABEL_OPENAI_MODEL    — Model ID. Default: "o3-mini"
 *   BABEL_OPENAI_TOKENS   — max_completion_tokens for the response. Default: 8096
 *
 * Error policy:
 *   HTTP 429 is re-thrown with a "rate limit:" prefix so the waterfall
 *   cascade detects it and skips to the next tier immediately (no retry).
 *   All other errors are thrown with an "[openAiApi]" prefix.
 */

import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner } from './base.js';
import { extractJson }    from '../utils/extractJson.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const OPENAI_MODEL = process.env['BABEL_OPENAI_MODEL']  ?? 'o3-mini';
const MAX_TOKENS   = Number(process.env['BABEL_OPENAI_TOKENS'] ?? '8096');
const API_URL      = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only — ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

// ─── OpenAI response shape (minimal, just what we need) ─────────────────────

interface OpenAiChoice {
  message?: { content?: string | null };
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
}

// ─── Runner implementation ────────────────────────────────────────────────────

export class OpenAiApiRunner implements LlmRunner {
  private readonly apiKey: string;

  constructor() {
    const key = process.env['OPENAI_API_KEY'];
    if (!key) {
      throw new Error(
        '[openAiApi] OPENAI_API_KEY is not set. ' +
        'Add it to your .env file to enable the OpenAI API runner.',
      );
    }
    this.apiKey = key;
  }

  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    // ── HTTP request ─────────────────────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model:                 OPENAI_MODEL,
          max_completion_tokens: MAX_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: prompt },
          ],
        }),
      });
    } catch (err) {
      throw new Error(
        `[openAiApi] Network error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Prefix with "rate limit:" so isImmediateCascade() in execute.ts detects it.
      if (response.status === 429) {
        throw new Error(`rate limit: [openAiApi] HTTP 429 — ${body.slice(0, 200)}`);
      }
      throw new Error(`[openAiApi] HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    // ── Extract text content ─────────────────────────────────────────────────
    let data: OpenAiResponse;
    try {
      data = (await response.json()) as OpenAiResponse;
    } catch (err) {
      throw new Error(
        `[openAiApi] Failed to parse API response as JSON: ${String(err)}`,
      );
    }

    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      throw new Error('[openAiApi] OpenAI API returned an empty response.');
    }

    // ── JSON extraction + Zod validation ─────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw new Error(
        `[openAiApi] invalid json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `[openAiApi] Zod validation failed:\n${result.error.toString()}`,
      );
    }

    return result.data;
  }
}
