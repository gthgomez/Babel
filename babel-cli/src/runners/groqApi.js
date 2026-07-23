/**
 * groqApi.ts — Groq API Runner (Tier 1 structural — ultra-fast, low-cost)
 *
 * Implements `LlmRunner` using the official `groq-sdk`. Groq's inference
 * hardware runs Llama 3.3 70B at extremely high throughput and low cost,
 * making it the ideal Tier 1 structural runner for JSON generation stages.
 *
 * Model notes (as of March 2026):
 *   Production stable: "llama-3.3-70b-versatile"  (280 tok/s, 128K ctx)
 *   Production stable: "llama-3.1-8b-instant"      (560 tok/s, 128K ctx)
 *   Preview only:      "meta-llama/llama-4-scout-17b-16e-instruct" (750 tok/s)
 *   Preview models may be discontinued without notice — not for production.
 *
 * Configuration (environment variables):
 *   GROQ_API_KEY      - Required. Set in your local .env file.
 *   BABEL_GROQ_MODEL  - Model ID. Default: "llama-3.3-70b-versatile"
 *   BABEL_GROQ_TOKENS - max_tokens for responses. Default: 8096
 *
 * Error policy:
 *   Any Groq SDK error (network, auth, quota) is re-thrown with a
 *   "[groqApi]" prefix so the waterfall cascade can detect it and
 *   escalate to the next tier.
 */
import Groq from 'groq-sdk';
import { extractJson } from '../utils/extractJson.js';
// ─── Configuration ────────────────────────────────────────────────────────────
const GROQ_MODEL = process.env['BABEL_GROQ_MODEL'] ?? 'llama-3.3-70b-versatile';
const _rawGroqTokens = Number(process.env['BABEL_GROQ_TOKENS'] ?? '8096');
const MAX_TOKENS = Number.isFinite(_rawGroqTokens) && _rawGroqTokens > 0 ? _rawGroqTokens : 8096;
const SYSTEM_PROMPT =
  'You are executing a Babel pipeline agent. ' +
  'Follow all instructions in the user message exactly. ' +
  'Your response MUST be a single valid JSON object only — ' +
  'no markdown, no explanation, no code fences. ' +
  'Output only raw JSON.';
// ─── Runner implementation ────────────────────────────────────────────────────
export class GroqApiRunner {
  client;
  constructor() {
    if (!process.env['GROQ_API_KEY']) {
      throw new Error(
        '[groqApi] GROQ_API_KEY is not set. ' +
          'Add it to your .env file to enable the Groq API runner.',
      );
    }
    this.client = new Groq({ apiKey: process.env['GROQ_API_KEY'] });
  }
  async execute(prompt, schema) {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: GROQ_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
    } catch (err) {
      throw new Error(
        `[groqApi] Groq API call failed: ` + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = completion.choices[0]?.message?.content ?? '';
    if (!text.trim()) {
      throw new Error('[groqApi] Groq API returned an empty response.');
    }
    let parsed;
    try {
      parsed = extractJson(text);
    } catch (err) {
      throw new Error(
        `[groqApi] invalid json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`[groqApi] Zod validation failed:\n${result.error.toString()}`);
    }
    return result.data;
  }
}
//# sourceMappingURL=groqApi.js.map
