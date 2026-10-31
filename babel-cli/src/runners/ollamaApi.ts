/**
 * ollamaApi.ts — Ollama Local API Runner (OpenAI-compatible)
 *
 * Provides Ollama inference (price is unknown unless established by usage metadata) via Ollama's OpenAI-compatible endpoint.
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
import type { NativeRunnerOptions } from './protocol/native-messages.js';
import { OpenAiCompatibleRunner } from './protocol/openai-chat-completions.js';

function resolveOllamaTokens(): number {
  const raw = Number(process.env['BABEL_OLLAMA_TOKENS'] ?? '4096');
  return Number.isFinite(raw) && raw > 0 ? raw : 4096;
}

export class OllamaApiRunner extends OpenAiCompatibleRunner {
  protected override get apiUrl(): string {
    const base = process.env['BABEL_DESKTOP_PROVIDER']
      ? 'http://127.0.0.1:11434/v1'
      : process.env['BABEL_OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1';
    return `${base.replace(/\/$/, '')}/chat/completions`;
  }

  constructor(model: string, options: NativeRunnerOptions = {}) {
    super(
      model,
      'OLLAMA_API_KEY',
      { maxTokens: options.maxTokens ?? resolveOllamaTokens(), temperature: options.temperature ?? 0 },
      { provider: 'ollama', explicitCredential: 'ollama-no-auth', ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}) },
    );
  }

  protected override getAuthenticationHeaders(): Record<string, string> { return {} }

  protected override getRequestTimeoutMs(): number {
    const value = Number(process.env['BABEL_OLLAMA_REQUEST_TIMEOUT_MS'] ?? process.env['BABEL_PROVIDER_REQUEST_TIMEOUT_MS'] ?? '300000')
    return Number.isFinite(value) && value > 0 ? value : 300000
  }

  protected override getRequestMaxRetries(): number {
    const value = Number(process.env['BABEL_OLLAMA_REQUEST_MAX_RETRIES'] ?? process.env['BABEL_PROVIDER_REQUEST_MAX_RETRIES'] ?? '1')
    return Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 10) : 1
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
      estimated_cost_usd: parent.estimated_cost_usd ?? null,
    };
  }
}
