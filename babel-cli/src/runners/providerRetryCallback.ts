import type { ProviderFailureStage, ProviderInvocationPhase } from './base.js'
import {
  providerRequestIdFromResponse,
  type ProviderFailureDetails,
} from './providerFailureReceipt.js'
import type { OpenRouterResponseMetadata } from './providerResponseMetadata.js'

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

type FinalizationFailure = Readonly<{
  step: 'settleRetry' | 'notifyPhase' | 'notifyCompleted'
  error: unknown
}>

/** Keep the control denial primary while retaining every secondary notification failure. */
export class ProviderRetryFinalizationError extends AggregateError {
  readonly finalizationFailures: readonly FinalizationFailure[]

  constructor(retryError: unknown, failures: readonly FinalizationFailure[]) {
    super(
      failures.map(failure => failure.error),
      retryError instanceof Error ? retryError.message : String(retryError),
      { cause: retryError },
    )
    this.name = 'ProviderRetryFinalizationError'
    this.finalizationFailures = Object.freeze(failures.map(failure => Object.freeze({ ...failure })))
  }
}

/** Finalize once; preserve the original stop, with secondary failures attached only when needed. */
export async function notifyProviderRetryOrFinalizeOnCallbackError(
  input: RetryFailureReceipt,
): Promise<void> {
  try {
    input.notifyRetry()
  } catch (retryError) {
    const failures: FinalizationFailure[] = []
    const attempt = (step: FinalizationFailure['step'], action: () => void): void => {
      try { action() } catch (error) { failures.push({ step, error }) }
    }
    const failure = input.failure
    attempt('settleRetry', () => input.settleRetry('failed'))
    attempt('notifyPhase', () => {
      input.notifyPhase(
        'provider_error',
        failure.kind === 'http' ? failure.response.status : undefined,
        failure.kind === 'http' ? 'http_error' : failure.transportPhase,
      )
    })
    attempt('notifyCompleted', () => {
      // Diagnostic body reads must never delay or replace an authoritative stop.
      const details: ProviderFailureDetails = failure.kind === 'transport'
        ? { message: failure.transportErrorMessage }
        : {
            status: failure.response.status,
            message: `HTTP ${failure.response.status} (error body unavailable: retry callback stopped dispatch)`,
            providerRequestId: providerRequestIdFromResponse(failure.response),
          }
      input.notifyCompleted('failed', null, '', null, null, null, input.outputBudget, {
        actualAttempt: input.actualAttempt,
        details,
        failureStage: failure.kind === 'http' ? 'response' : 'request',
      })
    })
    if (failures.length > 0) throw new ProviderRetryFinalizationError(retryError, failures)
    throw retryError
  }
}
