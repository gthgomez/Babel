import { z } from 'zod';
import { type PlanHandoff } from '../agent/planHandoff.js';
import { BABEL_ROOT } from '../cli/constants.js';
import type { EvidenceBundle } from '../evidence.js';
import { runWithPrimaryOnlyFallback } from '../execute.js';
import {
  resolveFamilyModelPolicy,
  resolveModelByKey,
  resolveModelPolicyBackendKey,
  resolveOpenRouterDeepSeekBackendKey,
  type ResolvedModelPolicy,
} from '../modelPolicy.js';
import type { RunnerInvocationMetadata } from '../runners/base.js';
import { createProviderRunner } from '../runners/providerEngine.js';
import { selectedConnectionModel } from './connectionSettings.js';
import { assertFiniteBudgetSupported } from '../config/laneBudget.js';
import { isProviderId } from '../runners/providerRegistry.js';
import { globalCostTracker } from './costTracker.js';
import type { SparkSynthesis } from './babelFull.js';
import type { LiteFixProgressReporter } from '../ui/liteFixProgress.js';
import type { LiteToolStreamSink } from '../ui/liteToolStream.js';
import { tryOfflineDemoAnswer } from './smallFixFixtures.js';

const SmallFixAnswerSchema = z.object({
  schema_version: z.literal(1).catch(1),
  summary: z.string().min(1),
  replacement_content: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});


export type SmallFixAnswer = z.infer<typeof SmallFixAnswerSchema>;

export type SmallFixProvider = 'live' | 'mock';

export type SmallFixExecutionMode = 'live' | 'offline_demo';

export interface SmallFixOptions {
  task: string;
  projectRoot?: string;
  /**
   * VCS: Write anchor path (absolute). Used to resolve relative tool paths
   * inside the fix session without mutating process.cwd().
   */
  anchorPath?: string;
  project?: string;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  /** `mock` enables offline demo fix (lite-trust-demo fixture scope only). */
  provider?: SmallFixProvider;
  /** When true, verifier failure auto-restores the pre-mutation checkpoint. */
  rollbackOnFail?: boolean;
  /** Read-only Spark synthesis metadata from parallel review (no reviewer mutations). */
  sparkSynthesis?: SparkSynthesis;
  /** Optional live progress reporter for human terminal output. */
  progress?: LiteFixProgressReporter;
  /** Optional live tool stream sink for discovery/read-only tool cards. */
  toolStream?: LiteToolStreamSink;
  /** Override bounded verify→repair attempts (default from env or 3). */
  maxRepairAttempts?: number;
  /** Optional approved plan run id or handoff loaded from task text. */
  planRunId?: string;
  planHandoff?: PlanHandoff | null;
  /** Internal: force a single-file scope for dual-file sequential fixes. */
  forcedTargetFile?: string;
}

export function resolveSmallFixProvider(
  options: Pick<SmallFixOptions, 'provider'>,
  env: NodeJS.ProcessEnv = process.env,
): SmallFixProvider {
  if (options.provider === 'live') {
    return 'live';
  }
  if (options.provider === 'mock') {
    return 'mock';
  }
  if (
    env['BABEL_LITE_OFFLINE'] === '1' ||
    env['BABEL_SMALL_FIX_PROVIDER'] === 'mock'
  ) {
    return 'mock';
  }
  return 'live';
}


export function liveProviderEnvKey(
  provider?: string,
): 'DEEPSEEK_API_KEY' | 'OPENROUTER_API_KEY' {
  return provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY';
}

function assertLiveProviderCredential(
  provider?: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (provider !== 'openrouter') {
    throw new Error(
      `[LIVE_MODEL_POLICY] live small fix requires an OpenRouter DeepSeek/GLM route; received ${provider ?? 'no provider'}.`,
    );
  }
  const envKey = liveProviderEnvKey(provider);
  if (!env[envKey]?.trim()) {
    throw new Error(
      `[smallFix] ${envKey} is not set. Add it to your .env file or environment for live fix.`,
    );
  }
}

export function classifySmallFixProviderFailure(error: unknown, provider?: string): { failureCode: string; message: string; next: string[] } {
  const message = error instanceof Error ? error.message : String(error);
  const route = provider ?? 'selected provider';
  if (/SETUP_REQUIRED|API_KEY.*(?:not set|missing)|credential/i.test(message)) return { failureCode: 'credential_missing', message: `${route} setup is incomplete. Inspect its credential reference with babel-agent provider status.`, next: ['babel-agent setup', 'babel-agent provider status'] };
  if (/HTTP (401|403)|auth_fatal/i.test(message)) return { failureCode: 'provider_authentication_failed', message: `${route} authentication was rejected. Update the selected credential and restart Babel.`, next: ['babel-agent provider status'] };
  if (/HTTP 402|quota|insufficient.*credit/i.test(message)) return { failureCode: 'provider_quota_exhausted', message: `${route} quota or credit is exhausted.`, next: ['Review quota with the selected provider', 'Select another connection explicitly if needed'] };
  if (/HTTP 429|rate.?limit/i.test(message)) return { failureCode: 'provider_rate_limited', message: `${route} rate limit reached.`, next: ['Wait for the provider retry window', 'Retry the same connection'] };
  if (/timeout|ETIMEDOUT/i.test(message)) return { failureCode: 'provider_timeout', message, next: ['babel-agent provider status', 'Retry the same connection'] };
  if (/network|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up/i.test(message)) return { failureCode: 'provider_network_failed', message, next: ['Check connectivity to the selected endpoint', 'babel-agent provider status'] };
  if (/zod|schema|invalid json|parse/i.test(message)) return { failureCode: 'provider_schema_invalid', message, next: ['Retry the same connection with the requested output format'] };
  return { failureCode: 'provider_request_failed', message, next: ['babel-agent provider status', 'Inspect the run evidence'] };
}

function failureCodeForError(error: unknown): string {
  return classifySmallFixProviderFailure(error).failureCode;
}

function appendDirectSmallFixTelemetry(input: {
  evidence: EvidenceBundle;
  metadata: RunnerInvocationMetadata | null;
  succeeded: boolean;
  errorSummary: string | null;
  provider: string;
  attempt: number;
}): void {
  const runnerName = `small-fix-direct-${input.provider}`;
  input.evidence.appendWaterfallLog({
    stage: 'small_fix',
    tier_succeeded: input.succeeded ? runnerName : null,
    tier_index: 0,
    attempts: input.attempt,
    tiers_skipped: [],
    cascade_reason: input.succeeded ? 'none' : 'failed',
    ts: new Date().toISOString(),
    attempts_detail: [
      {
        tier_name: runnerName,
        tier_index: 0,
        attempt: input.attempt,
        succeeded: input.succeeded,
        error_summary: input.errorSummary,
        provider: input.metadata?.provider ?? input.provider,
        provider_model_id: input.metadata?.provider_model_id ?? null,
        latency_ms: input.metadata?.latency_ms ?? null,
        prompt_tokens: input.metadata?.prompt_tokens ?? null,
        completion_tokens: input.metadata?.completion_tokens ?? null,
        total_tokens: input.metadata?.total_tokens ?? null,
        prompt_cache_hit_tokens:
          input.metadata?.prompt_cache_hit_tokens ?? null,
        prompt_cache_miss_tokens:
          input.metadata?.prompt_cache_miss_tokens ?? null,
        estimated_cost_usd: input.metadata?.estimated_cost_usd ?? null,
        cost_precision: input.metadata?.cost_precision ?? null,
        pricing_source_url: input.metadata?.pricing_source_url ?? null,
        pricing_verified_at: input.metadata?.pricing_verified_at ?? null,
        input_cost_per_1m: input.metadata?.input_cost_per_1m ?? null,
        output_cost_per_1m: input.metadata?.output_cost_per_1m ?? null,
        input_cache_hit_cost_per_1m:
          input.metadata?.input_cache_hit_cost_per_1m ?? null,
        input_cache_miss_cost_per_1m:
          input.metadata?.input_cache_miss_cost_per_1m ?? null,
        ttft_ms: input.metadata?.ttft_ms ?? null,
        generation_ms: input.metadata?.generation_ms ?? null,
        validation_ms: input.metadata?.validation_ms ?? null,
      },
    ],
    total_latency_ms: input.metadata?.latency_ms ?? null,
    total_prompt_tokens: input.metadata?.prompt_tokens ?? null,
    total_completion_tokens: input.metadata?.completion_tokens ?? null,
    total_tokens: input.metadata?.total_tokens ?? null,
    total_estimated_cost_usd: input.metadata?.estimated_cost_usd ?? null,
  });
}


export async function runSmallFixModel(
  prompt: string,
  evidence: EvidenceBundle,
  options: SmallFixOptions,
  detected: { targetFile: string },
  attempt = 1,
): Promise<{
  answer: SmallFixAnswer;
  modelPolicy?: ResolvedModelPolicy;
  executionMode?: SmallFixExecutionMode;
}> {
  const provider = resolveSmallFixProvider(options);
  if (provider !== 'mock') assertFiniteBudgetSupported('Small-fix compatibility lane', options.projectRoot);
  const liveOnly = provider === 'live';
  const explicitConnection = selectedConnectionModel(options.model ? { model: options.model } : {}, options.projectRoot);
  const selectedModel = options.model?.startsWith('connection/') ? options.model : explicitConnection ?? (liveOnly
    ? resolveOpenRouterDeepSeekBackendKey(options.model ?? '') ?? options.model
    : options.model);
  if (liveOnly && !selectedModel) throw new Error('SETUP_REQUIRED: Select a provider connection and exact model with babel-agent setup.');
  const selectedBackendKey = selectedModel
    ? resolveModelPolicyBackendKey(selectedModel, BABEL_ROOT)
    : undefined;
  const modelPolicy =
    selectedModel || liveOnly
      ? selectedBackendKey
        ? resolveModelByKey({
            key: selectedBackendKey,
            ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
            liveOnly,
            babelRoot: BABEL_ROOT,
          })
        : resolveFamilyModelPolicy({
          family: selectedModel ?? 'DeepSeek',
          ...(options.modelTier !== undefined
            ? { requestedTier: options.modelTier }
            : {}),
          ...(options.allowExpensive === true ? { allowExpensive: true } : {}),
          liveOnly,
          babelRoot: BABEL_ROOT,
        })
      : undefined;

  if (provider === 'live') {
    if (!selectedModel?.startsWith('connection/')) assertLiveProviderCredential(modelPolicy?.provider);
  }
  if (provider === 'mock') {
    const offlineAnswer = tryOfflineDemoAnswer(options, detected);
    if (!offlineAnswer) {
      throw new Error(
        'Offline demo fix (--provider mock / BABEL_LITE_OFFLINE=1) is only supported for lite-trust-demo and parity-corpus fixture tasks.',
      );
    }
    appendDirectSmallFixTelemetry({
      evidence,
      metadata: null,
      succeeded: true,
      errorSummary: null,
      provider: 'mock',
      attempt,
    });
    return { answer: offlineAnswer, executionMode: 'offline_demo' };
  }

  if (
    selectedModel?.startsWith('connection/') ||
    modelPolicy?.provider === 'deepinfra' ||
    modelPolicy?.provider === 'deepseek' ||
    modelPolicy?.provider === 'openrouter'
  ) {
    if (!modelPolicy) throw new Error('Selected model policy is unavailable.');
    const policyProvider = modelPolicy.provider;
    if (!isProviderId(policyProvider)) throw new Error('Unsupported selected provider; refusing substitution.');
    if (policyProvider === 'deepseek' && liveOnly && !selectedModel?.startsWith('connection/')) {
      throw new Error(
        '[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.',
      );
    }
    const runner = createProviderRunner({ provider: policyProvider, modelId: modelPolicy.providerModelId,
      ...(modelPolicy.apiKeyEnvVar ? { apiKeyEnvVar: modelPolicy.apiKeyEnvVar } : {}),
      ...(modelPolicy.baseUrl ? { baseUrl: modelPolicy.baseUrl } : {}),
      ...(modelPolicy.authentication ? { authentication: modelPolicy.authentication } : {}),
      ...(modelPolicy.contextWindow ? { contextWindowTokens: modelPolicy.contextWindow } : {}),
      ...(modelPolicy.requestedOutputTokens ? { sampling: { maxTokens: modelPolicy.requestedOutputTokens } } : {}),
    });
    try {
      const answer = await runner.execute(prompt, SmallFixAnswerSchema);
      const metadata = runner.getLastInvocationMetadata?.() ?? null;
      if (
        metadata?.provider_model_id &&
        metadata.prompt_tokens !== null &&
        metadata.completion_tokens !== null
      ) {
        globalCostTracker.trackUsage(
          metadata.provider_model_id,
          metadata.prompt_tokens,
          metadata.completion_tokens,
          metadata.prompt_cache_hit_tokens,
          metadata.prompt_cache_miss_tokens,
          undefined, true, metadata.provider, metadata.provider_reported_total_charge_usd,
        );
      }
      appendDirectSmallFixTelemetry({
        evidence,
        metadata,
        succeeded: true,
        errorSummary: null,
        provider: policyProvider,
        attempt,
      });
      return { answer, modelPolicy, executionMode: 'live' };
    } catch (error: unknown) {
      appendDirectSmallFixTelemetry({
        evidence,
        metadata: runner.getLastInvocationMetadata?.() ?? null,
        succeeded: false,
        errorSummary: error instanceof Error ? error.message : String(error),
        provider: policyProvider,
        attempt,
      });
      throw error;
    }
  }

  const answer = await runWithPrimaryOnlyFallback(
    prompt,
    SmallFixAnswerSchema,
    {
      evidence,
      stage: 'executor',
      schemaName: 'SmallFixAnswerSchema',
      maxCliAttempts: 1,
    },
  );
  return {
    answer,
    ...(modelPolicy !== undefined ? { modelPolicy } : {}),
    executionMode: 'live',
  };
}
