import {
  isSupportedDeepSeekModel,
  supportedDeepSeekModelsText,
} from '../services/deepSeekPricing.js';

export const LITE_PROVIDER_IDS = ['auto', 'deepseek', 'deepinfra', 'mock'] as const;
export type LiteProviderId = typeof LITE_PROVIDER_IDS[number];
export type ConcreteLiteProviderId = Exclude<LiteProviderId, 'auto'>;

export type LiteProviderKind = 'openai_compatible' | 'mock';
export type LiteSecretEnvKey = 'DEEPSEEK_API_KEY' | 'DEEPINFRA_TOKEN' | 'DEEPINFRA_API_KEY';

export const LITE_FAILURE_CODES = [
  'PROVIDER_KEY_MISSING',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_HTTP_ERROR',
  'PROVIDER_REQUEST_FAILED',
  'PROVIDER_EMPTY_RESPONSE',
  'PROMPT_BUDGET_EXCEEDED',
  'REPO_NOT_FOUND',
  'TASK_REQUIRED',
  'PROVIDER_UNKNOWN',
  'ARTIFACT_WRITE_FAILED',
  'PATCH_AUTO_APPLY_REFUSED',
] as const;
export type LiteErrorCode = typeof LITE_FAILURE_CODES[number];

export class LiteError extends Error {
  readonly code: LiteErrorCode;
  readonly providerId: string | null;
  readonly envKeyName: string | null;
  readonly envKeyNames: string[];
  readonly statusCode: number | null;

  constructor(
    code: LiteErrorCode,
    message: string,
    options: {
      providerId?: string | null;
      envKeyName?: string | null;
      envKeyNames?: string[];
      statusCode?: number | null;
    } = {},
  ) {
    super(message);
    this.name = 'LiteError';
    this.code = code;
    this.providerId = options.providerId ?? null;
    this.envKeyName = options.envKeyName ?? null;
    this.envKeyNames = options.envKeyNames ?? (options.envKeyName ? [options.envKeyName] : []);
    this.statusCode = options.statusCode ?? null;
  }
}

export interface LiteProviderConfig {
  id: ConcreteLiteProviderId;
  displayName: string;
  kind: LiteProviderKind;
  baseUrl: string;
  chatCompletionsPath: string;
  defaultModel: string;
  primaryEnvKeyName: LiteSecretEnvKey | null;
  fallbackEnvKeyNames: LiteSecretEnvKey[];
  envKeyNames: LiteSecretEnvKey[];
  activeEnvKeyName: LiteSecretEnvKey | null;
  configured: boolean;
  apiKey?: string;
}

export interface LiteRuntimeConfig {
  maxPromptTokens: number;
  maxResponseTokens: number;
  temperature: number;
  timeoutMs: number;
  providers: Record<ConcreteLiteProviderId, LiteProviderConfig>;
}

export interface LiteProviderStatus {
  id: ConcreteLiteProviderId;
  displayName: string;
  kind: LiteProviderKind;
  baseUrl: string;
  chatCompletionsPath: string;
  defaultModel: string;
  primaryEnvKeyName: LiteSecretEnvKey | null;
  fallbackEnvKeyNames: LiteSecretEnvKey[];
  envKeyNames: LiteSecretEnvKey[];
  activeEnvKeyName: LiteSecretEnvKey | null;
  configured: boolean;
}

const DEFAULT_MAX_PROMPT_TOKENS = 2500;
const DEFAULT_MAX_RESPONSE_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 45_000;

const PROVIDER_DEFINITIONS: Record<
  ConcreteLiteProviderId,
  Omit<LiteProviderConfig, 'configured' | 'apiKey' | 'envKeyNames' | 'activeEnvKeyName'>
> = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek direct',
    kind: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    chatCompletionsPath: '/chat/completions',
    defaultModel: 'deepseek-v4-flash',
    primaryEnvKeyName: 'DEEPSEEK_API_KEY',
    fallbackEnvKeyNames: [],
  },
  deepinfra: {
    id: 'deepinfra',
    displayName: 'DeepInfra OpenAI-compatible',
    kind: 'openai_compatible',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    chatCompletionsPath: '/chat/completions',
    defaultModel: 'deepseek-ai/DeepSeek-V3-0324',
    primaryEnvKeyName: 'DEEPINFRA_TOKEN',
    fallbackEnvKeyNames: ['DEEPINFRA_API_KEY'],
  },
  mock: {
    id: 'mock',
    displayName: 'Mock provider',
    kind: 'mock',
    baseUrl: 'mock://babel-lite',
    chatCompletionsPath: '/chat/completions',
    defaultModel: 'mock-lite-model',
    primaryEnvKeyName: null,
    fallbackEnvKeyNames: [],
  },
};

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function temperatureFromEnv(raw: string | undefined): number {
  const parsed = Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TEMPERATURE;
  }
  return Math.min(1, Math.max(0, parsed));
}

function modelOverrideForProvider(providerId: ConcreteLiteProviderId, env: NodeJS.ProcessEnv): string | null {
  if (providerId === 'deepseek') {
    return env['BABEL_LITE_DEEPSEEK_MODEL']?.trim() || null;
  }
  if (providerId === 'deepinfra') {
    return env['BABEL_LITE_DEEPINFRA_MODEL']?.trim() || null;
  }
  return null;
}

export function assertLiteProviderModel(providerId: ConcreteLiteProviderId, model: string): string {
  if (providerId === 'deepseek' && !isSupportedDeepSeekModel(model)) {
    throw new LiteError(
      'PROVIDER_UNKNOWN',
      `Unsupported DeepSeek model "${model}". Supported direct DeepSeek models: ${supportedDeepSeekModelsText()}.`,
      { providerId },
    );
  }
  return model;
}

function loadProviderConfig(
  providerId: ConcreteLiteProviderId,
  env: NodeJS.ProcessEnv,
): LiteProviderConfig {
  const definition = PROVIDER_DEFINITIONS[providerId];
  const envKeyNames = [
    ...(definition.primaryEnvKeyName ? [definition.primaryEnvKeyName] : []),
    ...definition.fallbackEnvKeyNames,
  ];
  const activeEnvKeyName = envKeyNames.find(envKeyName => Boolean(env[envKeyName]?.trim())) ?? null;
  const rawKey = activeEnvKeyName ? env[activeEnvKeyName]?.trim() : undefined;
  const modelOverride = modelOverrideForProvider(providerId, env);
  const defaultModel = assertLiteProviderModel(providerId, modelOverride ?? definition.defaultModel);

  return {
    ...definition,
    envKeyNames,
    activeEnvKeyName,
    defaultModel,
    configured: envKeyNames.length === 0 || Boolean(rawKey),
    ...(rawKey ? { apiKey: rawKey } : {}),
  };
}

export function loadLiteRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiteRuntimeConfig {
  return {
    maxPromptTokens: positiveIntFromEnv(env['BABEL_LITE_MAX_PROMPT_TOKENS'], DEFAULT_MAX_PROMPT_TOKENS),
    maxResponseTokens: positiveIntFromEnv(env['BABEL_LITE_MAX_RESPONSE_TOKENS'], DEFAULT_MAX_RESPONSE_TOKENS),
    temperature: temperatureFromEnv(env['BABEL_LITE_TEMPERATURE']),
    timeoutMs: positiveIntFromEnv(env['BABEL_LITE_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS),
    providers: {
      deepseek: loadProviderConfig('deepseek', env),
      deepinfra: loadProviderConfig('deepinfra', env),
      mock: loadProviderConfig('mock', env),
    },
  };
}

export function normalizeLiteProviderId(value: string | undefined): LiteProviderId {
  const normalized = String(value ?? 'auto').trim().toLowerCase();
  if ((LITE_PROVIDER_IDS as readonly string[]).includes(normalized)) {
    return normalized as LiteProviderId;
  }
  throw new LiteError(
    'PROVIDER_UNKNOWN',
    `Unknown Babel Lite provider "${value}". Valid values: ${LITE_PROVIDER_IDS.join(', ')}.`,
    { providerId: normalized },
  );
}

export function selectLiteProviderConfig(
  requestedProvider: LiteProviderId,
  config: LiteRuntimeConfig,
): LiteProviderConfig {
  if (requestedProvider !== 'auto') {
    const provider = config.providers[requestedProvider];
    if (!provider.configured) {
      const envKeys = provider.envKeyNames;
      throw new LiteError(
        'PROVIDER_KEY_MISSING',
        `${envKeys.join(' or ')} is not set. Set a supported key in the environment to use provider "${provider.id}".`,
        {
          providerId: provider.id,
          envKeyName: provider.primaryEnvKeyName,
          envKeyNames: envKeys,
        },
      );
    }
    return provider;
  }

  for (const providerId of ['deepseek', 'deepinfra'] as const) {
    const provider = config.providers[providerId];
    if (provider.configured) {
      return provider;
    }
  }

  throw new LiteError(
    'PROVIDER_KEY_MISSING',
    'No Babel Lite API provider is configured. Set DEEPSEEK_API_KEY, DEEPINFRA_TOKEN, or DEEPINFRA_API_KEY, or use --provider mock for offline tests.',
    { envKeyNames: ['DEEPSEEK_API_KEY', 'DEEPINFRA_TOKEN', 'DEEPINFRA_API_KEY'] },
  );
}

export function getLiteProviderStatuses(config: LiteRuntimeConfig): LiteProviderStatus[] {
  return (['deepseek', 'deepinfra', 'mock'] as const).map((providerId) => {
    const provider = config.providers[providerId];
    return {
      id: provider.id,
      displayName: provider.displayName,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      chatCompletionsPath: provider.chatCompletionsPath,
      defaultModel: provider.defaultModel,
      primaryEnvKeyName: provider.primaryEnvKeyName,
      fallbackEnvKeyNames: provider.fallbackEnvKeyNames,
      envKeyNames: provider.envKeyNames,
      activeEnvKeyName: provider.activeEnvKeyName,
      configured: provider.configured,
    };
  });
}
