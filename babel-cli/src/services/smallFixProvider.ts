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
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js';
import { DeepSeekApiRunner } from '../runners/deepSeekApi.js';
import { OpenRouterApiRunner } from '../runners/openRouterApi.js';
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

export function classifySmallFixProviderFailure(
  error: unknown,
  provider?: string,
): {
  failureCode: string;
  message: string;
  next: string[];
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/OPENROUTER_API_KEY is not set/i.test(message)) {
    return {
      failureCode: 'credential_missing',
      message:
        'OPENROUTER_API_KEY is not set. Direct GLM/OpenRouter requires OPENROUTER_API_KEY in environment or .env.',
      next: ['check OPENROUTER_API_KEY', 'babel undo'],
    };
  }
  if (
    /DEEPSEEK_API_KEY is not set/i.test(message) ||
    (/deepseek/i.test(message) && /API_KEY is not set/i.test(message))
  ) {
    return {
      failureCode: 'credential_missing',
      message:
        'DEEPSEEK_API_KEY is not set. Direct DeepSeek requires DEEPSEEK_API_KEY in environment or .env. Adjust key or run Full Babel (governed mode) to allow backup cascading.',
      next: ['check DEEPSEEK_API_KEY', 'babel undo'],
    };
  }
  if (
    /DEEPINFRA_API_KEY is not set/i.test(message) ||
    /API_KEY is not set/i.test(message) ||
    /\bcredential\b/i.test(message)
  ) {
    return {
      failureCode: 'credential_missing',
      message:
        'DEEPINFRA_API_KEY is not set. Live bl fix requires a DeepInfra API key.',
      next: ['check DEEPINFRA_API_KEY', 'babel undo'],
    };
  }
  if (
    /network error/i.test(message) ||
    /request timeout/i.test(message) ||
    /ECONNREFUSED|ENOTFOUND|fetch failed|ETIMEDOUT|socket hang up/i.test(
      message,
    )
  ) {
    const isDeepSeek =
      /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
    return {
      failureCode: 'provider_network_failed',
      message,
      next: [
        provider === 'openrouter'
          ? 'check OPENROUTER_API_KEY'
          : isDeepSeek
            ? 'check DEEPSEEK_API_KEY'
            : 'check DEEPINFRA_API_KEY',
        'babel undo',
      ],
    };
  }
  if (/timeout/i.test(message)) {
    const isDeepSeek =
      /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
    return {
      failureCode: 'provider_timeout',
      message,
      next: [
        provider === 'openrouter'
          ? 'check OPENROUTER_API_KEY'
          : isDeepSeek
            ? 'check DEEPSEEK_API_KEY'
            : 'check DEEPINFRA_API_KEY',
        'babel undo',
      ],
    };
  }
  if (/zod|schema|invalid json|parse/i.test(message)) {
    return {
      failureCode: 'provider_schema_invalid',
      message,
      next: ['Retry the fix with the same task', 'babel undo'],
    };
  }
  if (/waterfall failed/i.test(message) || /all \d+ runner/i.test(message)) {
    return {
      failureCode: 'provider_request_failed',
      message: `${message}. [Recovery Hint] Stage execution failed under 'primary_only' policy. Please ensure the primary provider API key is set, or run in Full Babel mode (governed mode) to allow backup cascades.`,
      next: ['check DEEPSEEK_API_KEY', 'check DEEPINFRA_API_KEY', 'babel undo'],
    };
  }
  const isDeepSeek =
    /\[deepSeekApi\]/i.test(message) || /DEEPSEEK_API_KEY/i.test(message);
  return {
    failureCode: 'provider_request_failed',
    message,
    next: [
      provider === 'openrouter'
        ? 'check OPENROUTER_API_KEY'
        : isDeepSeek
          ? 'check DEEPSEEK_API_KEY'
          : 'check DEEPINFRA_API_KEY',
      'babel undo',
    ],
  };
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
  const liveOnly = provider === 'live';
  const selectedModel = liveOnly
    ? resolveOpenRouterDeepSeekBackendKey(options.model ?? '') ??
      (options.model ?? 'deepseek-v4-flash-openrouter')
    : options.model;
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
    assertLiveProviderCredential(modelPolicy?.provider);
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
    modelPolicy?.provider === 'deepinfra' ||
    modelPolicy?.provider === 'deepseek' ||
    modelPolicy?.provider === 'openrouter'
  ) {
    const policyProvider = modelPolicy.provider;
    if (policyProvider === 'deepseek' && liveOnly) {
      throw new Error(
        '[LIVE_MODEL_POLICY] Direct DeepSeek live calls are disabled; use the OpenRouter DeepSeek control route.',
      );
    }
    const runner =
      policyProvider === 'deepseek'
        ? new DeepSeekApiRunner(modelPolicy.providerModelId)
        : policyProvider === 'openrouter'
          ? new OpenRouterApiRunner(modelPolicy.providerModelId)
          : new DeepInfraApiRunner(modelPolicy.providerModelId);
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
