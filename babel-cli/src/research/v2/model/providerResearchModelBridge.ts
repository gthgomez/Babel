import type {
  LlmRunner,
  RunnerCallbacks,
  RunnerInvocationMetadata,
} from '../../../runners/base.js'
import type { CostProvenance } from '../contracts/common.js'
import { modelOutputSchemaForKind, parseValidatedModelOutput } from '../contracts/modelOutputs.js'
import type {
  ModelRouteReceipt,
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
  UsageSettlement,
} from '../ports/researchModelPort.js'

export interface ProviderResearchModelBridgeOptions {
  runner: Pick<LlmRunner, 'execute'>
  backendKey: string
  provider: string
  providerModelId: string
  buildPrompt?: (request: ResearchModelInvocationRequest) => {
    prompt: string
    systemPrompt?: string
  }
}

function defaultBuildPrompt(request: ResearchModelInvocationRequest): {
  prompt: string
  systemPrompt: string
} {
  return {
    systemPrompt:
      'Respond with JSON only matching the requested research operation schema. No markdown fences.',
    prompt: JSON.stringify({
      operation_kind: request.kind,
      input: request.input,
    }),
  }
}

function costProvenanceFromMetadata(meta: RunnerInvocationMetadata | null | undefined): CostProvenance {
  if (!meta || meta.estimated_cost_usd == null) {
    return { status: 'unknown' }
  }
  if (meta.cost_precision === 'exact') {
    return { status: 'reported', amount_usd: meta.estimated_cost_usd, currency: 'USD' }
  }
  if (meta.cost_precision === 'conservative') {
    return {
      status: 'estimated',
      amount_usd: meta.estimated_cost_usd,
      method: 'conservative_pinned_rate',
      as_of: meta.pricing_verified_at ?? new Date().toISOString(),
    }
  }
  return {
    status: 'estimated',
    amount_usd: meta.estimated_cost_usd,
    method: 'provider_usage_estimate',
    as_of: meta.pricing_verified_at ?? new Date().toISOString(),
  }
}

function usageFromMetadata(attemptId: string, meta: RunnerInvocationMetadata | null | undefined): UsageSettlement {
  return {
    attempt_id: attemptId,
    ...(meta?.prompt_tokens != null ? { input_tokens: meta.prompt_tokens } : {}),
    ...(meta?.completion_tokens != null ? { output_tokens: meta.completion_tokens } : {}),
    cost: costProvenanceFromMetadata(meta),
  }
}

function routeReceiptFromMetadata(
  request: ResearchModelInvocationRequest,
  meta: RunnerInvocationMetadata | null | undefined,
  resolvedAt: string,
  configured: ProviderResearchModelBridgeOptions,
): ModelRouteReceipt {
  const provider = meta?.provider ?? configured.provider
  const providerModelId = meta
    ? (meta.observed_model_id ??
      meta.sent_model_id ??
      meta.normalized_model_id ??
      meta.provider_model_id ??
      configured.providerModelId)
    : configured.providerModelId
  return {
    operation_id: request.operationId,
    backend_key: configured.backendKey,
    provider,
    provider_model_id: providerModelId,
    resolved_at: resolvedAt,
    usage_settlement: usageFromMetadata(request.attemptId, meta),
  }
}

/**
 * Production {@link ResearchModelPort} — routes structured invokes through an injected {@link LlmRunner}
 * (typically {@link ProviderEngine}). Not a fixture; callers must gate live API use separately.
 */
export class ProviderResearchModelBridge implements ResearchModelPort {
  private readonly buildPrompt: ProviderResearchModelBridgeOptions['buildPrompt']

  constructor(private readonly options: ProviderResearchModelBridgeOptions) {
    this.buildPrompt = options.buildPrompt ?? defaultBuildPrompt
  }

  async invokeStructured(
    request: ResearchModelInvocationRequest,
  ): Promise<ResearchModelInvocationResult> {
    if (!request.attemptId) {
      return Promise.reject(new Error('ResearchModelInvocationRequest.attemptId is required'))
    }
    if (request.signal.aborted) {
      return {
        status: 'cancelled',
        operationId: request.operationId,
        usageSettlement: usageFromMetadata(request.attemptId, null),
      }
    }
    const schema = modelOutputSchemaForKind(request.kind)
    const built = (this.buildPrompt ?? defaultBuildPrompt)(request)
    const { prompt, systemPrompt } = built
    let invocationMeta: RunnerInvocationMetadata | null = null
    const callbacks: RunnerCallbacks = {
      onInvocationCompleted: (event) => {
        invocationMeta = event.usage_metadata ?? null
      },
    }
    try {
      const raw = await this.options.runner.execute(
        prompt,
        schema,
        callbacks,
        systemPrompt,
        request.signal,
      )
      if (request.signal.aborted) {
        return {
          status: 'cancelled',
          operationId: request.operationId,
          usageSettlement: usageFromMetadata(request.attemptId, invocationMeta),
        }
      }
      const output = parseValidatedModelOutput(request.kind, raw)
      if (request.signal.aborted) {
        return {
          status: 'cancelled',
          operationId: request.operationId,
          usageSettlement: usageFromMetadata(request.attemptId, invocationMeta),
        }
      }
      const meta = invocationMeta
      const resolvedAt = new Date().toISOString()
      return {
        status: 'ok',
        operationId: request.operationId,
        output,
        receipt: routeReceiptFromMetadata(request, meta, resolvedAt, this.options),
      }
    } catch (err: unknown) {
      if (request.signal.aborted) {
        return {
          status: 'cancelled',
          operationId: request.operationId,
          usageSettlement: usageFromMetadata(request.attemptId, invocationMeta),
        }
      }
      return {
        status: 'failed',
        operationId: request.operationId,
        failureCategory: 'provider_invoke_failed',
        message: err instanceof Error ? err.message : String(err),
        usageSettlement: usageFromMetadata(request.attemptId, invocationMeta),
      }
    }
  }
}
