import type { ModelRouteStage } from '../agent/modelRouteReceipt.js'
import type { PreparedProviderRequest } from './preparedProviderRequest.js'
import type { RunControl } from '../runtime/run-control.js'
import { RunStoppedError } from '../runtime/run-control.js'
import { CampaignBudgetStore, CampaignBudgetStoreError } from '../eval/campaign-budget-store.js'
import {
  actualMicroUsdFromUsage,
  buildCampaignOperationId,
  isCampaignMeteredProvider,
  reservationUpperBoundMicroUsd,
} from '../eval/campaign-metering.js'
import type { ProviderInvocationCompleted } from './base.js'

export class CampaignBudgetDeniedError extends Error {
  readonly code = 'CAMPAIGN_BUDGET_DENIED' as const
  constructor(message = 'Campaign budget denied the provider dispatch.') {
    super(message)
    this.name = 'CampaignBudgetDeniedError'
  }
}

export class CampaignRouteUnsupportedError extends Error {
  readonly code = 'CAMPAIGN_ROUTE_UNSUPPORTED' as const
  constructor(message = 'Requested provider route is not campaign-metered.') {
    super(message)
    this.name = 'CampaignRouteUnsupportedError'
  }
}

export interface CampaignDispatchGateOptions {
  campaignId: string
  store: CampaignBudgetStore
  taskOwnerId: string
}

/** Host-owned campaign admission for native API transports. */
export class CampaignDispatchGate {
  private readonly campaignId: string
  private readonly store: CampaignBudgetStore
  private readonly taskOwnerId: string
  private ledgerPoisoned = false

  constructor(options: CampaignDispatchGateOptions) {
    if (!options.taskOwnerId.trim()) throw new CampaignBudgetDeniedError()
    this.campaignId = options.campaignId
    this.store = options.store
    this.taskOwnerId = options.taskOwnerId
  }

  assertRoutedProvider(provider: string): void {
    if (!isCampaignMeteredProvider(provider)) {
      throw new CampaignRouteUnsupportedError()
    }
  }

  isLedgerPoisoned(): boolean {
    return this.ledgerPoisoned
  }

  private assertLedgerHealthy(): void {
    if (this.ledgerPoisoned) {
      throw new CampaignBudgetDeniedError('Campaign budget gate is closed after a persistence failure.')
    }
  }

  private poisonLedger(message: string): never {
    this.ledgerPoisoned = true
    try {
      this.store.persistPoisonMarker()
    } catch {
      /* durable poison is best-effort; in-process gate remains closed */
    }
    throw new CampaignBudgetDeniedError(message)
  }

  async admitBeforeDispatch(input: {
    executionStage: ModelRouteStage
    preparedRequest: PreparedProviderRequest
    runControl?: RunControl | undefined
  }): Promise<{ operationId: string }> {
    this.assertLedgerHealthy()
    this.assertRoutedProvider(input.preparedRequest.provider)
    const operationId = buildCampaignOperationId({
      campaignId: this.campaignId,
      taskOwnerId: this.taskOwnerId,
      executionStage: input.executionStage,
      requestId: input.preparedRequest.request_id,
      attemptId: input.preparedRequest.attempt_id,
    })
    const upperBoundMicroUsd = reservationUpperBoundMicroUsd(input.preparedRequest)
    try {
      const admitted = await this.store.transactAsync((budget) => budget.reserve(operationId, upperBoundMicroUsd))
      if (!admitted) throw new CampaignBudgetDeniedError()
    } catch (error) {
      if (error instanceof CampaignBudgetStoreError) {
        this.poisonLedger('Campaign budget admission could not be persisted.')
      }
      if (error instanceof CampaignBudgetDeniedError) {
        throw error
      }
      throw error
    }
    if (input.runControl) {
      const stopped = input.runControl.stop()
      if (stopped) throw new RunStoppedError(stopped)
    }
    return { operationId }
  }

  settleFromCompleted(input: {
    executionStage: ModelRouteStage
    requestId: string
    attemptId: string
    completed: ProviderInvocationCompleted
  }): void {
    this.assertLedgerHealthy()
    const operationId = buildCampaignOperationId({
      campaignId: this.campaignId,
      taskOwnerId: this.taskOwnerId,
      executionStage: input.executionStage,
      requestId: input.requestId,
      attemptId: input.attemptId,
    })
    const usage = input.completed.usage_metadata
    const actual = actualMicroUsdFromUsage({
      provider: input.completed.provider,
      modelId: usage?.observed_model_id ?? usage?.sent_model_id ?? input.completed.model,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      providerReportedTotalChargeUsd: usage?.provider_reported_total_charge_usd ?? null,
      costPrecision: usage?.cost_precision ?? null,
    })
    try {
      this.store.transact((budget) => budget.settle(operationId, actual))
    } catch (error) {
      if (error instanceof CampaignBudgetStoreError) {
        this.poisonLedger('Campaign budget settlement could not be persisted.')
      }
      this.poisonLedger('Campaign budget settlement could not be persisted.')
    }
  }

  settleUnknownOnTransportFailure(input: {
    executionStage: ModelRouteStage
    requestId: string
    attemptId: string
  }): void {
    this.assertLedgerHealthy()
    const operationId = buildCampaignOperationId({
      campaignId: this.campaignId,
      taskOwnerId: this.taskOwnerId,
      executionStage: input.executionStage,
      requestId: input.requestId,
      attemptId: input.attemptId,
    })
    try {
      this.store.transact((budget) => budget.settle(operationId, 'unknown'))
    } catch (error) {
      if (error instanceof CampaignBudgetStoreError) {
        this.poisonLedger('Campaign budget unknown settlement could not be persisted.')
      }
      this.poisonLedger('Campaign budget unknown settlement could not be persisted.')
    }
  }

  repeatRunControlBeforeFetch(runControl?: RunControl): void {
    const stopped = runControl?.stop()
    if (stopped) throw new RunStoppedError(stopped)
  }
}
