import type { ProviderFailureStage, ProviderInvocationPhase } from './base.js'
import {
  providerRequestIdFromResponse,
  type ProviderFailureDetails,
} from './providerFailureReceipt.js'
import type { OpenRouterResponseMetadata } from './providerResponseMetadata.js'
import { readErrorBody } from './providerResponseStream.js'

type RetrySettleOutcome = 'succeeded' | 'failed' | 'cancelled'

type RetryFailureReceipt = {
  notifyRetry: () => void
  settleRetry: (outcome: RetrySettleOutcome) => void
  notifyPhase: (phase: ProviderInvocationPhase, statusCode?: number, detail?: string) => void
  notifyCompleted: (
    status: 'delivered' | 'failed',
    observedModelId: string | null,
    outputText: string,
    upstreamProvider?: string | null,
    routerMetadata?: OpenRouterResponseMetadata | null,
    finishReason?: string | null,
    configuredOutputBudget?: number | null,
    options?: {
      actualAttempt?: number
      details?: ProviderFailureDetails
      failureStage?: ProviderFailureStage
    },
  ) => void
  actualAttempt: number
  outputBudget: number | null
  failure:
    | { kind: 'transport'; transportErrorMessage: string; transportPhase: 'timeout' | 'transport' }
    | { kind: 'http'; response: Response }
}

/** Finalize the active attempt when an onRetry callback throws; rethrow that callback error. */
export async function notifyProviderRetryOrFinalizeOnCallbackError(
  input: RetryFailureReceipt,
): Promise<void> {
  try {
    input.notifyRetry()
  } catch (retryErr) {
    input.settleRetry('failed')
    if (input.failure.kind === 'transport') {
      input.notifyPhase('provider_error', undefined, input.failure.transportPhase)
      input.notifyCompleted('failed', null, '', null, null, null, input.outputBudget, {
        actualAttempt: input.actualAttempt,
        details: { message: input.failure.transportErrorMessage },
        failureStage: 'request',
      })
    } else {
      const body = await readErrorBody(input.failure.response)
      input.notifyPhase('provider_error', input.failure.response.status, 'http_error')
      input.notifyCompleted('failed', null, body, null, null, null, input.outputBudget, {
        actualAttempt: input.actualAttempt,
        details: {
          status: input.failure.response.status,
          message: body,
          providerRequestId: providerRequestIdFromResponse(input.failure.response),
        },
        failureStage: 'response',
      })
    }
    throw retryErr
  }
}
