/**
 * geminiApi.ts — Gemini API Runner (repair loop / background tasks)
 *
 * Thin fetch-based wrapper around the Gemini generateContent REST endpoint.
 * Intended as the first-choice repair runner in structuredRunner.ts because
 * gemini-2.5-flash-lite has a very large context window and near-zero cost,
 * making it ideal for extracting JSON from large EVIDENCE_REQUEST logs without
 * risking Groq context-window overflows.
 *
 * Configuration (environment variables):
 *   GEMINI_API_KEY        - Required. Google AI Studio key.
 *   BABEL_GEMINI_MODEL    - Model ID. Default: "gemini-2.5-flash-lite"
 *   BABEL_GEMINI_TOKENS   - maxOutputTokens. Default: 8192
 */

import type { ZodType, ZodTypeDef } from 'zod';
import type { LlmRunner } from './base.js';
import { extractJson }    from '../utils/extractJson.js';

// ─── Configuration ─────────────────────────────────────────────────────────

const GEMINI_MODEL  = process.env['BABEL_GEMINI_MODEL']  ?? 'gemini-2.5-flash-lite';
const _rawGeminiTokens = Number(process.env['BABEL_GEMINI_TOKENS'] ?? '8192');
const MAX_TOKENS    = Number.isFinite(_rawGeminiTokens) && _rawGeminiTokens > 0 ? _rawGeminiTokens : 8192;
const API_BASE      = 'https://generativelanguage.googleapis.com/v1beta/models';

// ─── Runner implementation ──────────────────────────────────────────────────

export class GeminiApiRunner implements LlmRunner {
  private readonly apiKey: string;

  constructor() {
    const key = process.env['GEMINI_API_KEY'];
    if (!key) {
      throw new Error(
        '[geminiApi] GEMINI_API_KEY is not set. ' +
        'Add it to your .env file to enable the Gemini API runner.',
      );
    }
    this.apiKey = key;
  }

  async execute<T>(prompt: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    const url = `${API_BASE}/${GEMINI_MODEL}:generateContent`;

    let res: Response;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type':    'application/json',
          'x-goog-api-key':  this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature:      0,
            maxOutputTokens:  MAX_TOKENS,
          },
          systemInstruction: {
            parts: [{
              text:
                'You are executing a Babel pipeline agent. ' +
                'Follow all instructions in the user message exactly. ' +
                'Your response MUST be a single valid JSON object only — ' +
                'no markdown, no explanation, no code fences. ' +
                'Output only raw JSON.',
            }],
          },
        }),
      });
    } catch (err) {
      throw new Error(
        `[geminiApi] fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (res.status === 429) {
      throw new Error(`rate limit: geminiApi quota exceeded (HTTP 429)`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `[geminiApi] HTTP ${String(res.status)}: ${body.slice(0, 200)}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = await res.json();
    } catch (err) {
      throw new Error(
        `[geminiApi] failed to parse API response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text.trim()) {
      throw new Error('[geminiApi] Gemini API returned an empty response.');
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw new Error(
        `[geminiApi] invalid json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `[geminiApi] Zod validation failed:\n${result.error.toString()}`,
      );
    }

    return result.data;
  }
}
