/**
 * ollamaApi.ts — Ollama Local API Runner (OpenAI-compatible)
 *
 * Provides zero-cost local inference via Ollama's OpenAI-compatible endpoint.
 * Used as the primary runner in offline mode (--offline / BABEL_OFFLINE=1).
 *
 * Ollama serves an OpenAI-compatible chat completions API at:
 *   http://localhost:11434/v1/chat/completions
 *
 * No API key is required — the runner sets a dummy key to satisfy the
 * parent class constructor contract.
 *
 * Configuration (environment variables):
 *   BABEL_OLLAMA_BASE_URL          - Base URL. Default: http://localhost:11434/v1
 *   BABEL_OLLAMA_TOKENS            - max_tokens. Default: 4096
 *   BABEL_OLLAMA_REQUEST_TIMEOUT_MS - per-request timeout. Default: 300000
 *   BABEL_OLLAMA_REQUEST_MAX_RETRIES - retry attempts. Default: 1
 */

import type { RunnerInvocationMetadata } from './base.js';
import { DeepInfraApiRunner } from './deepInfraApi.js';

function resolveOllamaTokens(): number {
  const raw = Number(process.env['BABEL_OLLAMA_TOKENS'] ?? '4096');
  return Number.isFinite(raw) && raw > 0 ? raw : 4096;
}

export class OllamaApiRunner extends DeepInfraApiRunner {
  protected override get apiUrl(): string {
    const base = process.env['BABEL_OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1';
    return `${base.replace(/\/$/, '')}/chat/completions`;
  }

  constructor(model: string) {
    process.env['OLLAMA_API_KEY'] ??= 'ollama-no-auth';
    const saved = process.env['BABEL_DEEPINFRA_TOKENS'];
    process.env['BABEL_DEEPINFRA_TOKENS'] = String(resolveOllamaTokens());
    super(model, 'OLLAMA_API_KEY');
    if (saved !== undefined) {
      process.env['BABEL_DEEPINFRA_TOKENS'] = saved;
    } else {
      delete process.env['BABEL_DEEPINFRA_TOKENS'];
    }
  }

  override getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    const parent = super.getLastInvocationMetadata();
    if (!parent) return null;
    return {
      ...parent,
      provider: 'ollama',
      prompt_tokens: parent.prompt_tokens ?? null,
      completion_tokens: parent.completion_tokens ?? null,
      total_tokens: parent.total_tokens ?? null,
      estimated_cost_usd: 0,
    };
  }
}
