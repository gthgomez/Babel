/**
 * deepInfraApi.ts — DeepInfra API Runner (OpenAI-compatible)
 *
 * Provides low-cost access to large open-weight models via DeepInfra's
 * OpenAI-compatible endpoint. Used in the per-stage waterfalls for:
 *
 *   Nemotron 3 Super 120B   — strong validator/fallback across all stages
 *   Qwen3-32B               — ultra-cheap structured JSON for executor turns
 *
 * Configuration (environment variables):
 *   DEEPINFRA_API_KEY          - Required. Get from https://deepinfra.com/dashboard
 *   BABEL_DEEPINFRA_TOKENS     - max_tokens for responses. Default: 8096
 *
 * The model is passed at construction time so a single runner class serves
 * multiple model IDs without extra env vars.
 *
 * Error policy:
 *   HTTP 429 is re-thrown with a "rate limit:" prefix so the waterfall
 *   cascade detects it and skips to the next tier immediately (no retry).
 *   All other errors are thrown with a "[deepInfraApi]" prefix.
 */

import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner } from './base.js';
import { extractJson }    from '../utils/extractJson.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const _rawTokens = Number(process.env['BABEL_DEEPINFRA_TOKENS'] ?? '8096');
const MAX_TOKENS = Number.isFinite(_rawTokens) && _rawTokens > 0 ? _rawTokens : 8096;
const API_URL    = 'https://api.deepinfra.com/v1/openai/chat/completions';

const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only — ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';

// ─── Response shape (OpenAI-compatible subset) ────────────────────────────────

interface ChatChoice {
  message?: { content?: string | null };
}

interface ChatResponse {
  choices?: ChatChoice[];
}

// ─── Runner implementation ────────────────────────────────────────────────────

export class DeepInfraApiRunner implements LlmRunner {
  private readonly apiKey: string;
  private readonly model: string;

  /**
   * @param model  DeepInfra model ID, e.g.
   *               "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B"
   *               "Qwen/Qwen3-32B-Instruct"
   */
  constructor(model: string) {
    const key = process.env['DEEPINFRA_API_KEY'];
    if (!key) {
      throw new Error(
        '[deepInfraApi] DEEPINFRA_API_KEY is not set. ' +
        'Add it to your .env file to enable the DeepInfra runner.',
      );
    }
    this.apiKey = key;
    this.model  = model;
  }

  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    // ── HTTP request ──────────────────────────────────────────────────────────
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model:       this.model,
          max_tokens:  MAX_TOKENS,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: prompt },
          ],
        }),
      });
    } catch (err) {
      throw new Error(
        `[deepInfraApi] Network error (${this.model}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 429) {
        throw new Error(`rate limit: [deepInfraApi] HTTP 429 — ${body.slice(0, 200)}`);
      }
      throw new Error(
        `[deepInfraApi] HTTP ${response.status} (${this.model}): ${body.slice(0, 200)}`,
      );
    }

    // ── Extract text content ──────────────────────────────────────────────────
    let data: ChatResponse;
    try {
      data = (await response.json()) as ChatResponse;
    } catch (err) {
      throw new Error(
        `[deepInfraApi] Failed to parse API response as JSON: ${String(err)}`,
      );
    }

    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      throw new Error(`[deepInfraApi] Empty response from model "${this.model}".`);
    }

    // ── JSON extraction + Zod validation ─────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw new Error(
        `[deepInfraApi] invalid json (${this.model}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `[deepInfraApi] Zod validation failed (${this.model}):\n${result.error.toString()}`,
      );
    }

    return result.data;
  }
}
