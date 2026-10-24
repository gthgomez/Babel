/**
 * Command Code Provider API runner — Chat Completions wire protocol.
 *
 * Command Code (https://api.commandcode.ai/provider/v1) serves an
 * OpenAI-compatible chat-completions endpoint for most selected models. The
 * credential is fixed to CMD_API_KEY and the origin to the Command Code
 * Provider API base; catalog metadata can never change either. Anthropic
 * Messages routes (e.g. claude-haiku-5-5) are handled by the separate
 * anthropicMessages transport, selected by the resolved route — never by
 * model-name inference here.
 *
 * Usage:
 *   CMD_API_KEY=...  // operator-provided runtime environment
 */

import { DeepInfraApiRunner } from './deepInfraApi.js';
import type { RunnerInvocationMetadata } from './base.js';
import type { ResolvedExecutionEnvelope } from '../intelligence/types.js';

export const COMMANDCODE_API_BASE = 'https://api.commandcode.ai/provider/v1' as const;
export const COMMANDCODE_CREDENTIAL_ENV_VAR = 'CMD_API_KEY' as const;

export class CommandCodeApiRunner extends DeepInfraApiRunner {
  protected override get apiUrl(): string {
    return `${COMMANDCODE_API_BASE}/chat/completions`;
  }

  constructor(
    model: string,
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      apiKeyEnvVar?: string;
      explicitCredential?: string;
      env?: NodeJS.ProcessEnv;
      executionEnvelope?: ResolvedExecutionEnvelope;
    } = {},
  ) {
    super(model, credential.apiKeyEnvVar ?? COMMANDCODE_CREDENTIAL_ENV_VAR, sampling, {
      provider: 'commandcode',
      ...(credential.explicitCredential ? { explicitCredential: credential.explicitCredential } : {}),
      ...(credential.env ? { env: credential.env } : {}),
      ...(credential.executionEnvelope ? { executionEnvelope: credential.executionEnvelope } : {}),
    });
  }

  override getLastInvocationMetadata(): RunnerInvocationMetadata | null {
    const metadata = super.getLastInvocationMetadata();
    return metadata ? { ...metadata, provider: 'commandcode' } : null;
  }

  protected override validateObservedModelId(observedModelId: string | null): void {
    if (this.executionEnvelope?.mode === 'benchmark_strict') {
      if (observedModelId === null) {
        throw new Error('[LIVE_MODEL_POLICY] Strict Command Code execution omitted observed model identity.')
      }
      if (observedModelId !== this.executionEnvelope.model.resolved) {
        throw new Error(
          `[LIVE_MODEL_POLICY] Strict Command Code execution observed model "${observedModelId}" ` +
            `but expected "${this.executionEnvelope.model.resolved}".`,
        )
      }
      return
    }
    // Command Code is a curated multi-family gateway; the response identity
    // must match the exact requested model for every selected route.
    if (observedModelId === null) {
      throw new Error(
        '[LIVE_MODEL_POLICY] Command Code response omitted observed model identity; ' +
          'refusing to certify an unidentifiable provider response.',
      );
    }
    if (observedModelId !== this.model) {
      throw new Error(
        `[LIVE_MODEL_POLICY] Command Code observed model "${observedModelId}" ` +
          `but the selected route sent "${this.model}"; refusing model substitution.`,
      );
    }
  }
}
