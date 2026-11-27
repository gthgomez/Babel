/** Validated configuration shared by compatible transports; contains no dispatch. */
import { resolveProviderCredential } from '../credentialHub.js';
import type { ProviderId } from '../providerRegistry.js';
import type { ResolvedExecutionEnvelope } from '../../intelligence/types.js';

const defaultMaxTokens = 32_000;

function positiveTokenLimit(value: number | undefined): number | null {
  if (value === undefined) return null;
  const tokens = Math.floor(value);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

export class CompatibleConfiguration {
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly providerId: ProviderId;
  protected readonly contextWindowTokens: number | undefined;
  protected readonly executionEnvelope: ResolvedExecutionEnvelope | undefined;
  protected readonly maxTokens: number | null;
  protected readonly requestedOutputBudget: number | null;
  protected readonly temperature: number;
  /** Explicit caller environment; process-wide offline authority still applies. */
  protected readonly transportEnvironment: NodeJS.ProcessEnv | undefined;

  /** Override in subclasses for alternate OpenAI-compatible providers. */
  protected get apiUrl(): string {
    throw new Error('A compatible provider adapter must supply an endpoint.');
  }

  /**
   * @param model           Model ID.
   * @param apiKeyEnvVar    Declared credential environment variable name.
   */
  constructor(
    model: string,
    apiKeyEnvVar = '',
    sampling: { maxTokens?: number; temperature?: number } = {},
    credential: {
      provider?: ProviderId;
      contextWindowTokens?: number;
      explicitCredential?: string;
      env?: NodeJS.ProcessEnv;
      executionEnvelope?: ResolvedExecutionEnvelope;
    } = {},
  ) {
    const provider = credential.provider;
    if (!provider) throw new Error('A compatible provider adapter must declare its provider.');
    this.providerId = provider;
    this.executionEnvelope = credential.executionEnvelope;
    this.contextWindowTokens = credential.contextWindowTokens;
    this.transportEnvironment = credential.env;
    if (this.executionEnvelope && this.executionEnvelope.provider.gateway !== provider) {
      throw new Error(
        `[${this.providerId}] execution envelope gateway ${this.executionEnvelope.provider.gateway} does not match ${provider}.`,
      );
    }
    if (this.executionEnvelope && this.executionEnvelope.model.resolved !== model) {
      throw new Error(
        `[${this.providerId}] execution envelope model ${this.executionEnvelope.model.resolved} does not match ${model}.`,
      );
    }
    this.apiKey = credential.explicitCredential ?? resolveProviderCredential(provider, {
      envVarOverride: apiKeyEnvVar,
      ...(credential.env ? { env: credential.env } : {}),
    }) ?? '';
    this.model = model;
    const env = credential.env ?? process.env;
    this.requestedOutputBudget = this.executionEnvelope
      ? this.executionEnvelope.output.requested ?? null
      : positiveTokenLimit(sampling.maxTokens)
        ?? positiveTokenLimit(Number(env['BABEL_PROVIDER_TOKENS'] ?? env['BABEL_DEEPINFRA_TOKENS']));
    this.maxTokens = this.executionEnvelope
      ? this.executionEnvelope.output.effective ?? null
      : this.requestedOutputBudget ?? defaultMaxTokens;
    this.temperature =
      typeof sampling.temperature === 'number' && Number.isFinite(sampling.temperature)
        ? sampling.temperature
        : 0;
  }

}
