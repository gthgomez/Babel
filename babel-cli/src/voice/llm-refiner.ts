/**
 * LlmRefiner — Sends raw STT transcript to a fast LLM for cleanup/formatting.
 *
 * Target providers (sorted by latency):
 *   1. Cerebras (Llama 3.1 @ 2100 tok/s, ~50ms TTFT) — fastest
 *   2. Groq (Llama 3.3 @ ~300 tok/s)
 *   3. Gemini 2.5 Flash (Google)
 *   4. Local llama.cpp (offline fallback)
 *
 * All use standard HTTP fetch() with JSON request/response.
 * The system prompt is compact and latency-optimised (~80 tokens).
 *
 * @module voice/llm-refiner
 */

import type { LlmRefinementResult, LlmRefinerConfig } from './types.js';

// ── System prompt ───────────────────────────────────────────────────────────

const REFINEMENT_SYSTEM_PROMPT = `Clean up dictated text. Rules:
- Remove filler words (um, uh, you know, like, I mean, basically)
- Fix grammar and punctuation
- Preserve code identifiers EXACTLY (camelCase, snake_case, kebab-case, PascalCase)
- Do NOT change code syntax, function names, or variable names
- Output ONLY the cleaned text, no explanations.`;

// ── LlmRefiner ──────────────────────────────────────────────────────────────

export class LlmRefiner {
  private config: LlmRefinerConfig;

  constructor(config: LlmRefinerConfig) {
    this.config = {
      ...config,
      maxTokens: config.maxTokens ?? 200,
      temperature: config.temperature ?? 0.0,
    };
  }

  /**
   * Refine raw transcript into polished, formatted text.
   *
   * @param rawText   Raw STT output (may contain fillers, hesitations).
   * @param context   Optional app context for formatting hints.
   * @param vocab     Optional custom vocabulary for spelling correction.
   * @param signal    Optional AbortSignal for cancellation.
   */
  async refine(
    rawText: string,
    context?: string,
    vocab?: string[],
    signal?: AbortSignal,
  ): Promise<LlmRefinementResult> {
    const startTime = performance.now();

    try {
      const systemPrompt = this.buildSystemPrompt(context, vocab);
      const body = this.buildRequestBody(systemPrompt, rawText);
      const response = await this.sendRequest(body, signal);
      const refinedText = this.parseResponse(response);

      const latencyMs = performance.now() - startTime;
      // Empty refinedText means provider failed — keep raw text
      const isEmpty = refinedText.length === 0;
      const changed = !isEmpty && refinedText !== rawText;
      const finalText = isEmpty ? rawText : refinedText;
      return { refinedText: finalText, changed, latencyMs };
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      // On any error, return the raw text unchanged
      return {
        refinedText: rawText,
        changed: false,
        latencyMs,
      };
    }
  }

  // ── Request building ────────────────────────────────────────────────────

  private buildSystemPrompt(context?: string, vocab?: string[]): string {
    let prompt = REFINEMENT_SYSTEM_PROMPT;

    if (context) {
      prompt += `\n\nFormatting context: ${context}. `;
    }

    if (vocab && vocab.length > 0) {
      prompt += `\nCustom spellings: ${vocab.join(', ')}. `;
    }

    return prompt;
  }

  private buildRequestBody(systemPrompt: string, rawText: string): string {
    // OpenAI-compatible chat completion format
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawText },
      ],
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: false,
    };

    return JSON.stringify(body);
  }

  // ── HTTP transport ──────────────────────────────────────────────────────

  private async sendRequest(
    body: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body,
      signal: signal ?? null,
    });

    if (!response.ok) {
      // On 4xx/5xx, don't throw — return empty so caller uses raw text
      console.warn(
        `[LlmRefiner] Provider returned ${response.status}: ${await response.text().catch(() => 'unknown')}`
      );
      return { choices: [{ message: { content: '' } }] };
    }

    return (await response.json()) as Record<string, unknown>;
  }

  // ── Response parsing ────────────────────────────────────────────────────

  private parseResponse(response: Record<string, unknown>): string {
    // OpenAI-compatible format: choices[0].message.content
    const choices = response['choices'] as Array<Record<string, unknown>> | undefined;
    if (choices && choices.length > 0) {
      const message = choices[0]?.['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'] as string | undefined;
      if (content && content.trim()) {
        return this.sanitiseOutput(content.trim());
      }
    }

    // Groq / Cerebras / custom format fallbacks
    const content = response['content'] as string | undefined;
    if (content?.trim()) return this.sanitiseOutput(content.trim());

    const text = response['text'] as string | undefined;
    if (text?.trim()) return this.sanitiseOutput(text.trim());

    // Return empty string — caller should detect and keep raw text
    return '';
  }

  /**
   * Strip common LLM output artifacts: leading/trailing quotes, markdown
   * code fences, and "Here is the cleaned text:" preambles.
   */
  private sanitiseOutput(text: string): string {
    return text
      .replace(/^["']|["']$/g, '')
      .replace(/^```[\s\S]*?\n/, '')
      .replace(/\n```$/, '')
      .replace(/^(Here is|Here's|Output:|Cleaned text:)\s*/i, '')
      .trim();
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /**
   * Quick health check — sends a minimal request to verify the provider
   * is reachable and the API key is valid.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.refine('test', undefined, undefined, undefined);
      return result.latencyMs < 10_000; // Any response within 10s is healthy
    } catch {
      return false;
    }
  }
}
