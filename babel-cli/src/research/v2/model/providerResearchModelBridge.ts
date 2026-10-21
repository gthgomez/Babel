import type { LlmRunner, RunnerInvocationMetadata } from '../../../runners/base.js'
import { modelOutputSchemaForKind, parseValidatedModelOutput } from '../contracts/modelOutputs.js'
import type {
  ResearchModelInvocationRequest,
  ResearchModelInvocationResult,
  ResearchModelPort,
  UsageSettlement,
} from '../ports/researchModelPort.js'

export interface ProviderResearchModelBridgeOptions {
  runner: Pick<LlmRunner, 'execute' | 'getLastInvocationMetadata'>
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

function usageFromMetadata(attemptId: string, meta: RunnerInvocationMetadata | null | undefined): UsageSettlement {
  const cost =
    meta?.estimated_cost_usd != null
      ? { status: 'reported' as const, amount_usd: meta.estimated_cost_usd, currency: 'USD' as const }
      : { status: 'unknown' as const }
  return {
    attempt_id: attemptId,
    ...(meta?.prompt_tokens != null ? { input_tokens: meta.prompt_tokens } : {}),
    ...(meta?.completion_tokens != null ? { output_tokens: meta.completion_tokens } : {}),
    cost,
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
    try {
      const raw = await this.options.runner.execute(
        prompt,
        schema,
        undefined,
        systemPrompt,
        request.signal,
      )
      const output = parseValidatedModelOutput(request.kind, raw)
      const meta = this.options.runner.getLastInvocationMetadata?.() ?? null
      const resolvedAt = new Date().toISOString()
      return {
        status: 'ok',
        operationId: request.operationId,
        output,
        receipt: {
          operation_id: request.operationId,
          backend_key: this.options.backendKey,
          provider: this.options.provider,
          provider_model_id: this.options.providerModelId,
          resolved_at: resolvedAt,
          usage_settlement: usageFromMetadata(request.attemptId, meta),
        },
      }
    } catch (err: unknown) {
      if (request.signal.aborted) {
        return {
          status: 'cancelled',
          operationId: request.operationId,
          usageSettlement: usageFromMetadata(
            request.attemptId,
            this.options.runner.getLastInvocationMetadata?.() ?? null,
          ),
        }
      }
      const meta = this.options.runner.getLastInvocationMetadata?.() ?? null
      return {
        status: 'failed',
        operationId: request.operationId,
        failureCategory: 'provider_invoke_failed',
        message: err instanceof Error ? err.message : String(err),
        usageSettlement: usageFromMetadata(request.attemptId, meta),
      }
    }
  }
}
