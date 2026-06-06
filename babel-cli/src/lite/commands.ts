import {
  getLiteProviderStatuses,
  LITE_FAILURE_CODES,
  LiteError,
  assertLiteProviderModel,
  loadLiteRuntimeConfig,
  normalizeLiteProviderId,
  selectLiteProviderConfig,
  type ConcreteLiteProviderId,
  type LiteProviderStatus,
  type LiteRuntimeConfig,
} from './config.js';
import {
  buildLiteProviderPrompt,
  buildLiteTaskContract,
  formatLiteContractText,
  type LiteTaskContract,
} from './contract.js';
import {
  createLiteArtifactRun,
  writeLiteJsonArtifact,
  writeLiteTextArtifact,
  type LiteArtifactRun,
} from './artifacts.js';
import {
  createLiteProvider,
  type LiteFetch,
  type LiteProviderResponse,
} from './provider.js';
import { buildCostLedger, buildSingleCallCostLedger } from '../services/costLedger.js';
import { redactSecrets } from '../utils/redaction.js';

export type LitePrivacyMode = 'redacted' | 'full';

export interface LiteProvidersResult {
  schema_version: 1;
  command: 'providers';
  status: 'ok';
  providers: LiteProviderStatus[];
  selection_order: string[];
  secret_policy: string;
  failure_codes: typeof LITE_FAILURE_CODES;
}

export interface LitePlanResult {
  schema_version: 1;
  command: 'plan';
  status: 'ok';
  warnings: string[];
  contract: LiteTaskContract;
}

export interface LiteArtifactSummary {
  run_id: string;
  run_dir: string;
  files: Record<string, string>;
}

export interface LiteProviderSummary {
  id: ConcreteLiteProviderId;
  model: string;
  privacy: LitePrivacyMode;
  latency_ms: number;
  usage: LiteProviderResponse['usage'];
}

export interface LiteAskResult {
  schema_version: 1;
  status: 'ok';
  command: 'ask';
  provider: LiteProviderSummary;
  response: string;
  artifacts: LiteArtifactSummary;
}

export interface LitePatchResult {
  schema_version: 1;
  status: 'ok';
  command: 'patch';
  provider: LiteProviderSummary;
  patch: string;
  auto_apply: false;
  artifacts: LiteArtifactSummary;
}

export interface LiteProviderCallOptions {
  repoPath: string;
  task: string;
  provider?: string;
  model?: string;
  privacy?: LitePrivacyMode;
  artifactRoot?: string;
  autoApply?: boolean;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: LiteFetch;
  onChunk?: (chunk: string) => void;
}

function artifactSummary(artifacts: LiteArtifactRun): LiteArtifactSummary {
  return {
    run_id: artifacts.runId,
    run_dir: artifacts.runDir,
    files: artifacts.files,
  };
}

function providerSummary(response: LiteProviderResponse, privacy: LitePrivacyMode): LiteProviderSummary {
  return {
    id: assertConcreteProvider(response.providerId),
    model: response.providerModelId,
    privacy,
    latency_ms: response.latencyMs,
    usage: response.usage,
  };
}

function buildSystemPrompt(command: 'ask' | 'patch'): string {
  if (command === 'patch') {
    return [
      'You are Babel Lite patch proposal mode.',
      'Return a patch proposal or unified diff for review.',
      'Do not claim files were edited.',
      'Do not include secrets.',
    ].join(' ');
  }

  return [
    'You are Babel Lite ask mode.',
    'Answer using the compact governance contract.',
    'Do not edit files or claim file changes.',
    'State uncertainty when evidence is missing.',
  ].join(' ');
}

function assertConcreteProvider(providerId: string): ConcreteLiteProviderId {
  if (providerId === 'deepseek' || providerId === 'deepinfra' || providerId === 'mock') {
    return providerId;
  }
  throw new LiteError('PROVIDER_UNKNOWN', `Provider "${providerId}" did not resolve to a concrete provider.`);
}

function normalizePrivacyMode(value: LitePrivacyMode | undefined): LitePrivacyMode {
  if (value === undefined || value === 'redacted') {
    return 'redacted';
  }
  if (value === 'full') {
    return 'full';
  }
  throw new LiteError(
    'PROVIDER_REQUEST_FAILED',
    `Unknown Babel Lite privacy mode "${String(value)}". Valid values: redacted, full.`,
  );
}

function applyProviderPrivacy(prompt: string, privacy: LitePrivacyMode): string {
  return privacy === 'redacted' ? redactSecrets(prompt) : prompt;
}

function prepareProviderCall(
  command: 'ask' | 'patch',
  options: LiteProviderCallOptions,
): {
  config: LiteRuntimeConfig;
  providerConfig: ReturnType<typeof selectLiteProviderConfig>;
  contract: LiteTaskContract;
  prompt: string;
  model: string;
  privacy: LitePrivacyMode;
  artifacts: LiteArtifactRun;
} {
  const config = loadLiteRuntimeConfig(options.env ?? process.env);
  const requestedProvider = normalizeLiteProviderId(options.provider);
  const providerConfig = selectLiteProviderConfig(requestedProvider, config);
  const privacy = normalizePrivacyMode(options.privacy);
  const contract = buildLiteTaskContract({
    repoPath: options.repoPath,
    task: options.task,
    maxPromptTokens: config.maxPromptTokens,
    ...(options.now ? { now: options.now } : {}),
  });
  const prompt = buildLiteProviderPrompt(contract, command);
  const model = assertLiteProviderModel(
    providerConfig.id,
    options.model?.trim() || providerConfig.defaultModel,
  );
  const artifacts = createLiteArtifactRun({
    command,
    repoPath: options.repoPath,
    ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  writeLiteJsonArtifact(artifacts, 'contract.json', prompt.contract);
  writeLiteTextArtifact(artifacts, 'prompt.md', prompt.prompt);
  writeLiteJsonArtifact(artifacts, 'provider.json', {
    schema_version: 1,
    command,
    provider: providerConfig.id,
    model,
    base_url: providerConfig.baseUrl,
    chat_completions_path: providerConfig.chatCompletionsPath,
    active_env_key: providerConfig.activeEnvKeyName,
    supported_env_keys: providerConfig.envKeyNames,
    privacy,
    max_prompt_tokens: config.maxPromptTokens,
    estimated_prompt_tokens: prompt.estimatedPromptTokens,
    max_response_tokens: config.maxResponseTokens,
    temperature: config.temperature,
    timeout_ms: config.timeoutMs,
  });

  return {
    config,
    providerConfig,
    contract: prompt.contract,
    prompt: applyProviderPrivacy(prompt.prompt, privacy),
    model,
    privacy,
    artifacts,
  };
}

export function runLiteProviders(env: NodeJS.ProcessEnv = process.env): LiteProvidersResult {
  const config = loadLiteRuntimeConfig(env);
  return {
    schema_version: 1,
    command: 'providers',
    status: 'ok',
    providers: getLiteProviderStatuses(config),
    selection_order: ['deepseek', 'deepinfra'],
    secret_policy: 'Presence is reported, values are never printed.',
    failure_codes: LITE_FAILURE_CODES,
  };
}

export function runLitePlan(options: {
  repoPath: string;
  task: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): LitePlanResult {
  const config = loadLiteRuntimeConfig(options.env ?? process.env);
  const contract = buildLiteTaskContract({
    repoPath: options.repoPath,
    task: options.task,
    maxPromptTokens: config.maxPromptTokens,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    schema_version: 1,
    command: 'plan',
    status: 'ok',
    warnings: contract.warnings,
    contract,
  };
}

export async function runLiteAsk(options: LiteProviderCallOptions): Promise<LiteAskResult> {
  const prepared = prepareProviderCall('ask', options);
  const provider = createLiteProvider(prepared.providerConfig, options.fetchImpl);

  try {
    const response = await provider.complete({
      mode: 'ask',
      systemPrompt: buildSystemPrompt('ask'),
      userPrompt: prepared.prompt,
      model: prepared.model,
      maxTokens: prepared.config.maxResponseTokens,
      temperature: prepared.config.temperature,
      timeoutMs: prepared.config.timeoutMs,
      ...(options.onChunk ? { onChunk: options.onChunk } : {}),
    });
    const safeContent = redactSecrets(response.content);

    writeLiteTextArtifact(prepared.artifacts, 'response.md', safeContent);
    writeLiteJsonArtifact(prepared.artifacts, 'provider.json', {
      schema_version: 1,
      command: 'ask',
      provider: response.providerId,
      model: response.providerModelId,
      privacy: prepared.privacy,
      latency_ms: response.latencyMs,
      usage: response.usage,
      base_url: prepared.providerConfig.baseUrl,
      chat_completions_path: prepared.providerConfig.chatCompletionsPath,
      active_env_key: prepared.providerConfig.activeEnvKeyName,
      supported_env_keys: prepared.providerConfig.envKeyNames,
      artifacts: prepared.artifacts.files,
    });
    writeLiteJsonArtifact(prepared.artifacts, 'cost_ledger.json', buildSingleCallCostLedger({
      runId: prepared.artifacts.runId,
      task: prepared.contract.task,
      lane: 'lite_ask',
      stage: 'ask',
      provider: response.providerId,
      modelId: response.providerModelId,
      latencyMs: response.latencyMs,
      promptTokens: response.usage?.promptTokens ?? null,
      completionTokens: response.usage?.completionTokens ?? null,
      totalTokens: response.usage?.totalTokens ?? null,
    }));

    return {
      schema_version: 1,
      status: 'ok',
      command: 'ask',
      provider: providerSummary(response, prepared.privacy),
      response: safeContent,
      artifacts: artifactSummary(prepared.artifacts),
    };
  } catch (error: unknown) {
    writeLiteTextArtifact(prepared.artifacts, 'response.md', `Babel Lite ask failed: ${error instanceof Error ? error.message : String(error)}`);
    writeLiteJsonArtifact(prepared.artifacts, 'cost_ledger.json', buildCostLedger({
      runId: prepared.artifacts.runId,
      task: prepared.contract.task,
      lane: 'lite_ask',
      waterfallEntries: [],
    }));
    writeLiteJsonArtifact(prepared.artifacts, 'error.json', {
      command: 'ask',
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof LiteError ? error.code : 'PROVIDER_REQUEST_FAILED',
    });
    throw error;
  }
}

export async function runLitePatch(options: LiteProviderCallOptions): Promise<LitePatchResult> {
  if (options.autoApply === true) {
    throw new LiteError(
      'PATCH_AUTO_APPLY_REFUSED',
      'Babel Lite patch mode never applies changes automatically.',
    );
  }
  const prepared = prepareProviderCall('patch', options);
  const provider = createLiteProvider(prepared.providerConfig, options.fetchImpl);

  try {
    const response = await provider.complete({
      mode: 'patch',
      systemPrompt: buildSystemPrompt('patch'),
      userPrompt: prepared.prompt,
      model: prepared.model,
      maxTokens: prepared.config.maxResponseTokens,
      temperature: prepared.config.temperature,
      timeoutMs: prepared.config.timeoutMs,
    });
    const safeContent = redactSecrets(response.content);

    writeLiteTextArtifact(prepared.artifacts, 'response.md', safeContent);
    writeLiteTextArtifact(prepared.artifacts, 'patch.diff', safeContent);
    writeLiteJsonArtifact(prepared.artifacts, 'provider.json', {
      schema_version: 1,
      command: 'patch',
      provider: response.providerId,
      model: response.providerModelId,
      privacy: prepared.privacy,
      latency_ms: response.latencyMs,
      usage: response.usage,
      base_url: prepared.providerConfig.baseUrl,
      chat_completions_path: prepared.providerConfig.chatCompletionsPath,
      active_env_key: prepared.providerConfig.activeEnvKeyName,
      supported_env_keys: prepared.providerConfig.envKeyNames,
      auto_apply: false,
      artifacts: prepared.artifacts.files,
    });
    writeLiteJsonArtifact(prepared.artifacts, 'cost_ledger.json', buildSingleCallCostLedger({
      runId: prepared.artifacts.runId,
      task: prepared.contract.task,
      lane: 'lite_patch',
      stage: 'patch',
      provider: response.providerId,
      modelId: response.providerModelId,
      latencyMs: response.latencyMs,
      promptTokens: response.usage?.promptTokens ?? null,
      completionTokens: response.usage?.completionTokens ?? null,
      totalTokens: response.usage?.totalTokens ?? null,
    }));

    return {
      schema_version: 1,
      status: 'ok',
      command: 'patch',
      provider: providerSummary(response, prepared.privacy),
      patch: safeContent,
      auto_apply: false,
      artifacts: artifactSummary(prepared.artifacts),
    };
  } catch (error: unknown) {
    writeLiteTextArtifact(prepared.artifacts, 'response.md', `Babel Lite patch failed: ${error instanceof Error ? error.message : String(error)}`);
    writeLiteJsonArtifact(prepared.artifacts, 'cost_ledger.json', buildCostLedger({
      runId: prepared.artifacts.runId,
      task: prepared.contract.task,
      lane: 'lite_patch',
      waterfallEntries: [],
    }));
    writeLiteJsonArtifact(prepared.artifacts, 'error.json', {
      command: 'patch',
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof LiteError ? error.code : 'PROVIDER_REQUEST_FAILED',
      auto_apply: false,
    });
    throw error;
  }
}

export function formatLiteProvidersText(result: LiteProvidersResult): string {
  return [
    'Babel Lite providers',
    ...result.providers.map(provider =>
      `  ${provider.id.padEnd(9)} ${provider.configured ? 'configured' : 'missing key'} ` +
      `${provider.defaultModel} (${provider.envKeyNames.length > 0 ? provider.envKeyNames.join(' or ') : 'no key'})`,
    ),
    `Selection order: ${result.selection_order.join(' -> ')}`,
    result.secret_policy,
  ].join('\n');
}

export function formatLitePlanText(result: LitePlanResult): string {
  return [
    'Babel Lite local plan contract',
    'Mode: local/no-API',
    '',
    formatLiteContractText(result.contract),
  ].join('\n');
}

export function formatLiteAskText(result: LiteAskResult): string {
  return [
    `Babel Lite ask: ${result.provider.id} (${result.provider.model})`,
    `Artifacts: ${result.artifacts.run_dir}`,
    '',
    result.response.trimEnd(),
  ].join('\n');
}

export function formatLitePatchText(result: LitePatchResult): string {
  return [
    `Babel Lite patch proposal: ${result.provider.id} (${result.provider.model})`,
    'Auto-apply: false',
    `Artifacts: ${result.artifacts.run_dir}`,
    '',
    result.patch.trimEnd(),
  ].join('\n');
}
