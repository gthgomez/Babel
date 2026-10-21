import type {
  LlmRunner,
  ProviderInvocationCompleted,
  RunnerCallbacks,
  RunnerInvocationMetadata,
} from '../../../runners/base.js'
import { isStructuredOutputError } from '../../../runners/base.js'
import { ZodError } from 'zod'
import type { CostProvenance } from '../contracts/common.js'
import { modelOutputSchemaForKind, parseValidatedModelOutput } from '../contracts/modelOutputs.js'
import { buildResearchV2StructuredModelPrompt } from './researchV2ProviderModelPrompt.js'
import type { ProviderInvokeDiagnostics } from '../contracts/providerInvokeDiagnostics.js'
import type {
  ModelRouteReceipt,
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
  UsageSettlement,
} from '../ports/researchModelPort.js'
import { providerInvokeDiagnosticsFromCompletion } from './providerInvokeDiagnosticsFromCompletion.js'

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
  return buildResearchV2StructuredModelPrompt(request)
}

function modelInvokeFailureCategory(err: unknown): string {
  if (err instanceof ZodError) {
    return 'structured_output_validation_failed'
  }
  if (isStructuredOutputError(err) && err.failure_kind === 'zod_validation_failed') {
    return 'structured_output_validation_failed'
  }
  return 'provider_invoke_failed'
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
    ...(meta?.actual_reasoning_tokens != null
      ? { reasoning_tokens: meta.actual_reasoning_tokens }
      : {}),
    cost: costProvenanceFromMetadata(meta),
  }
}

function diagnosticsForRequest(
  completion: ProviderInvocationCompleted | null,
): ProviderInvokeDiagnostics | undefined {
  if (!completion) {
    return undefined
  }
  return providerInvokeDiagnosticsFromCompletion(completion)
}

function routeReceiptFromMetadata(
  request: ResearchModelInvocationRequest,
  meta: RunnerInvocationMetadata | null | undefined,
  resolvedAt: string,
  configured: ProviderResearchModelBridgeOptions,
  completion: ProviderInvocationCompleted | null,
): ModelRouteReceipt {
  const provider = meta?.provider ?? configured.provider
  const providerModelId = meta
    ? (meta.observed_model_id ??
      meta.sent_model_id ??
      meta.normalized_model_id ??
      meta.provider_model_id ??
      configured.providerModelId)
    : configured.providerModelId
  const providerInvokeDiagnostics = diagnosticsForRequest(completion)
  return {
    operation_id: request.operationId,
    backend_key: configured.backendKey,
    provider,
    provider_model_id: providerModelId,
    resolved_at: resolvedAt,
    usage_settlement: usageFromMetadata(request.attemptId, meta),
    ...(providerInvokeDiagnostics ? { provider_invoke_diagnostics: providerInvokeDiagnostics } : {}),
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
    let invocationCompletion: ProviderInvocationCompleted | null = null
    const callbacks: RunnerCallbacks = {
      onInvocationCompleted: (event) => {
        invocationCompletion = event
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
          ...(() => {
            const d = diagnosticsForRequest(invocationCompletion)
            return d ? { providerInvokeDiagnostics: d } : {}
          })(),
        }
      }
      const output = parseValidatedModelOutput(request.kind, raw)
      if (request.signal.aborted) {
        return {
          status: 'cancelled',
          operationId: request.operationId,
          usageSettlement: usageFromMetadata(request.attemptId, invocationMeta),
          ...(() => {
            const d = diagnosticsForRequest(invocationCompletion)
            return d ? { providerInvokeDiagnostics: d } : {}
          })(),
        }
      }
      const meta = invocationMeta
      const resolvedAt = new Date().toISOString()
      const providerInvokeDiagnostics = diagnosticsForRequest(invocationCompletion)
      return {
        status: 'ok',
        operationId: request.operationId,
        output,
        receipt: routeReceiptFromMetadata(
          request,
          meta,
          resolvedAt,
          this.options,
          invocationCompletion,
        ),
        ...(providerInvokeDiagnostics ? { providerInvokeDiagnostics } : {}),
      }
    } catch (err: unknown) {
      if (request.signal.aborted) {
        return {
          status: 'cancelled',
          operationId: request.operationId,
          usageSettlement: usageFromMetadata(request.attemptId, invocationMeta),
          ...(() => {
            const d = diagnosticsForRequest(invocationCompletion)
            return d ? { providerInvokeDiagnostics: d } : {}
          })(),
        }
      }
      const failureCategory = modelInvokeFailureCategory(err)
      const failureDiagnostics = diagnosticsForRequest(invocationCompletion)
      return {
        status: 'failed',
        operationId: request.operationId,
        failureCategory,
        message: err instanceof Error ? err.message : String(err),
        usageSettlement: usageFromMetadata(request.attemptId, invocationMeta),
        ...(failureDiagnostics ? { providerInvokeDiagnostics: failureDiagnostics } : {}),
      }
    }
  }
}
