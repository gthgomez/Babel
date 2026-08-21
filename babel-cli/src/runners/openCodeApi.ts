/**
 * openCodeApi.ts — OpenCode Zen API Runner (OpenAI-compatible).
 *
 * OpenCode Zen (https://opencode.ai/docs/zen/) is a model gateway operated by
 * the OpenCode team. Its chat-completions endpoint is OpenAI-compatible, so we
 * reuse the full DeepInfraApiRunner implementation and only override the API
 * URL and API-key source.
 *
 * Usage:
 *   OPENCODE_API_KEY=...  // in babel-cli/.env or the host environment
 *
 * Configuration (environment variables):
 *   BABEL_OPENCODE_BASE_URL - Base URL. Default: https://opencode.ai/zen/v1
 *   BABEL_OPENCODE_MODEL    - Default model ID when none is passed explicitly.
 *                             Default: "x-preview-f-free" (Ox Alpha Free).
 */

import { DeepInfraApiRunner } from './deepInfraApi.js';
import type { RunnerInvocationMetadata } from './base.js';

export const OPENCODE_DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
export const OPENCODE_DEFAULT_MODEL = 'x-preview-f-free';

function resolveOpenCodeBaseUrl(): string {
  const override = process.env['BABEL_OPENCODE_BASE_URL']?.trim();
  return (override || OPENCODE_DEFAULT_BASE_URL).replace(/\/$/, '');
}

export class OpenCodeApiRunner extends DeepInfraApiRunner {
  protected override get apiUrl(): string {
    return `${resolveOpenCodeBaseUrl()}/chat/completions`;
  }

  constructor(
    model: string,
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      apiKeyEnvVar?: string;
      explicitCredential?: string;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    super(model, credential.apiKeyEnvVar ?? 'OPENCODE_API_KEY', sampling, {
      provider: 'opencode',
      ...(credential.explicitCredential
        ? { explicitCredential: credential.explicitCredential }
        : {}),
      ...(credential.env ? { env: credential.env } : {}),
    });
  }

  override getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    const metadata = super.getLastInvocationMetadata();
    return metadata ? { ...metadata, provider: 'opencode' } : null;
  }
}
