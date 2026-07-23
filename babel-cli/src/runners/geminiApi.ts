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

import type { ZodType } from 'zod';
import { type LlmRunner, type RunnerCallbacks, buildStructuredOutputError } from './base.js';
import { extractJson } from '../utils/extractJson.js';
import { parseRateLimitHeaders } from '../ui/rateLimitWidget.js';

// ─── Configuration ─────────────────────────────────────────────────────────

const GEMINI_MODEL = process.env['BABEL_GEMINI_MODEL'] ?? 'gemini-2.5-flash-lite';
const _rawGeminiTokens = Number(process.env['BABEL_GEMINI_TOKENS'] ?? '8192');
const MAX_TOKENS =
  Number.isFinite(_rawGeminiTokens) && _rawGeminiTokens > 0 ? _rawGeminiTokens : 8192;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

  async execute<T>(
    prompt: string,
    schema: ZodType<T, unknown>,
    callbacks?: RunnerCallbacks,
  ): Promise<T> {
    const url = `${API_BASE}/${GEMINI_MODEL}:generateContent`;

    let res: Response;
    let rawJsonText = '';
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: MAX_TOKENS,
          },
          systemInstruction: {
            parts: [
              {
                text:
                  'You are executing a Babel pipeline agent. ' +
                  'Follow all instructions in the user message exactly. ' +
                  'Your response MUST be a single valid JSON object only — ' +
                  'no markdown, no explanation, no code fences. ' +
                  'Output only raw JSON.',
              },
            ],
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
      throw new Error(`[geminiApi] HTTP ${String(res.status)}: ${body.slice(0, 200)}`);
    }
    parseRateLimitHeaders(res.headers, 'gemini');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      rawJsonText = await res.text();
      json = JSON.parse(rawJsonText);
    } catch (err) {
      throw buildStructuredOutputError({
        failure_kind: 'failed_to_parse_api_json',
        provider: 'gemini',
        model: GEMINI_MODEL,
        message: `[geminiApi] Failed to parse API response as JSON: ${err instanceof Error ? err.message : String(err)}`,
        raw_output: rawJsonText,
        cause: err instanceof Error ? err : undefined,
      });
    }

    const text: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text.trim()) {
      throw buildStructuredOutputError({
        failure_kind: 'empty_response',
        provider: 'gemini',
        model: GEMINI_MODEL,
        message: '[geminiApi] Gemini API returned an empty response.',
        raw_output: rawJsonText,
      });
    }

    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw buildStructuredOutputError({
        failure_kind: 'invalid_json',
        provider: 'gemini',
        model: GEMINI_MODEL,
        message: `[geminiApi] invalid json: ${err instanceof Error ? err.message : String(err)}`,
        raw_output: text,
        cause: err instanceof Error ? err : undefined,
      });
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw buildStructuredOutputError({
        failure_kind: 'zod_validation_failed',
        provider: 'gemini',
        model: GEMINI_MODEL,
        message: `[geminiApi] Zod validation failed:\n${result.error.toString()}`,
        raw_output: text,
        parsed_json: parsed,
        zod_issues: result.error,
      });
    }

    return result.data;
  }
}
