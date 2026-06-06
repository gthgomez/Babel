import type {
  LiteProviderConfig,
  LiteProviderId,
} from './config.js';
import {
  LiteError,
} from './config.js';
import { redactSecrets } from '../utils/redaction.js';

export interface LiteProviderRequest {
  mode: 'ask' | 'patch';
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  onChunk?: (chunk: string) => void;
}

export interface LiteProviderUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface LiteProviderResponse {
  providerId: string;
  providerModelId: string;
  content: string;
  latencyMs: number;
  usage: LiteProviderUsage | null;
  rawResponse: unknown;
}

export interface LiteProvider {
  id: LiteProviderId;
  displayName: string;
  configured: boolean;
  complete(input: LiteProviderRequest): Promise<LiteProviderResponse>;
}

export type LiteFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ChatChoice {
  message?: {
    content?: string | null;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function normalizeToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usageFromResponse(response: ChatResponse): LiteProviderUsage | null {
  if (!response.usage) {
    return null;
  }
  const promptTokens = normalizeToken(response.usage.prompt_tokens);
  const completionTokens = normalizeToken(response.usage.completion_tokens);
  const totalTokens = normalizeToken(response.usage.total_tokens)
    ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function parseChatResponse(value: unknown): ChatResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as ChatResponse;
}

function mockContentForMode(mode: LiteProviderRequest['mode']): string {
  if (mode === 'patch') {
    return [
      'MOCK PATCH PROPOSAL',
      '--- a/example.txt',
      '+++ b/example.txt',
      '@@',
      '-old',
      '+new',
      '',
      'This is a mock patch proposal. It was not applied.',
    ].join('\n');
  }

  return [
    'MOCK ASK RESPONSE',
    'Babel Lite mock provider received the compact task contract and returned an offline response.',
  ].join('\n');
}

class MockLiteProvider implements LiteProvider {
  readonly id = 'mock';
  readonly displayName = 'Mock provider';
  readonly configured = true;

  async complete(input: LiteProviderRequest): Promise<LiteProviderResponse> {
    return {
      providerId: this.id,
      providerModelId: input.model ?? 'mock-lite-model',
      content: mockContentForMode(input.mode),
      latencyMs: 0,
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
      rawResponse: {
        mode: input.mode,
        mock: true,
      },
    };
  }
}

class OpenAiCompatibleLiteProvider implements LiteProvider {
  readonly id: LiteProviderId;
  readonly displayName: string;
  readonly configured: boolean;

  private readonly config: LiteProviderConfig;
  private readonly fetchImpl: LiteFetch;

  constructor(config: LiteProviderConfig, fetchImpl: LiteFetch) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.config = config;
    this.configured = config.configured;
    this.fetchImpl = fetchImpl;
  }

  async complete(input: LiteProviderRequest): Promise<LiteProviderResponse> {
    if (!this.config.apiKey) {
      const envKeys = this.config.envKeyNames;
      throw new LiteError(
        'PROVIDER_KEY_MISSING',
        `${envKeys.join(' or ')} is not set. Set a supported key in the environment to use provider "${this.config.id}".`,
        {
          providerId: this.config.id,
          envKeyName: this.config.primaryEnvKeyName,
          envKeyNames: envKeys,
        },
      );
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.config.baseUrl, this.config.chatCompletionsPath), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model ?? this.config.defaultModel,
          max_tokens: input.maxTokens,
          temperature: input.temperature,
          stream: !!input.onChunk,
          messages: [
            { role: 'system', content: input.systemPrompt },
            { role: 'user', content: input.userPrompt },
          ],
        }),
      });
    } catch (error: unknown) {
      const aborted = controller.signal.aborted;
      throw new LiteError(
        'PROVIDER_REQUEST_FAILED',
        aborted
          ? `Provider "${this.config.id}" timed out after ${input.timeoutMs}ms.`
          : `Provider "${this.config.id}" request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        { providerId: this.config.id },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 429) {
        throw new LiteError(
          'PROVIDER_RATE_LIMITED',
          `Provider "${this.config.id}" was rate limited: ${redactSecrets(body).slice(0, 200)}`,
          { providerId: this.config.id, statusCode: response.status },
        );
      }
      throw new LiteError(
        'PROVIDER_HTTP_ERROR',
        `Provider "${this.config.id}" returned HTTP ${response.status}: ${redactSecrets(body).slice(0, 200)}`,
        { providerId: this.config.id, statusCode: response.status },
      );
    }

    if (input.onChunk && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6).trim();
            if (data === '[DONE]') {
              continue;
            }
            try {
              const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = json.choices?.[0]?.delta?.content || '';
              if (delta) {
                text += delta;
                input.onChunk(delta);
              }
            } catch {
              // Ignore
            }
          }
        }
      }

      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data !== '[DONE]') {
          try {
            const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            const delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              text += delta;
              input.onChunk(delta);
            }
          } catch {
            // Ignore
          }
        }
      }

      if (!text.trim()) {
        throw new LiteError(
          'PROVIDER_EMPTY_RESPONSE',
          `Provider "${this.config.id}" returned an empty response.`,
          { providerId: this.config.id },
        );
      }

      return {
        providerId: this.config.id,
        providerModelId: input.model ?? this.config.defaultModel,
        content: text,
        latencyMs: Date.now() - startedAt,
        usage: null,
        rawResponse: null,
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error: unknown) {
      throw new LiteError(
        'PROVIDER_REQUEST_FAILED',
        `Provider "${this.config.id}" returned invalid JSON: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        { providerId: this.config.id },
      );
    }

    const chat = parseChatResponse(raw);
    const content = chat.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) {
      throw new LiteError(
        'PROVIDER_EMPTY_RESPONSE',
        `Provider "${this.config.id}" returned an empty response.`,
        { providerId: this.config.id },
      );
    }

    return {
      providerId: this.config.id,
      providerModelId: input.model ?? this.config.defaultModel,
      content,
      latencyMs: Date.now() - startedAt,
      usage: usageFromResponse(chat),
      rawResponse: raw,
    };
  }
}

export function createLiteProvider(
  config: LiteProviderConfig,
  fetchImpl: LiteFetch = fetch,
): LiteProvider {
  if (config.kind === 'mock') {
    return new MockLiteProvider();
  }
  return new OpenAiCompatibleLiteProvider(config, fetchImpl);
}
