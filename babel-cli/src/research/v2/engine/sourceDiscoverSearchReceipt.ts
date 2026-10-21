import type { ExternalOperationCompletion, ExternalOperationIntent } from '../contracts/operations.js'
import {
  SourceSearchProviderReceiptSchema,
  type SourceSearchProviderReceipt,
} from '../contracts/sourceSearchProviderReceipt.js'
import type { UsageSettlement } from '../ports/researchModelPort.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'
import type { SourceSearchProviderReceipt as PortSearchReceipt } from '../ports/sourceAccessPort.js'

export function sanitizeSourceSearchProviderReceipt(
  receipt: PortSearchReceipt,
): SourceSearchProviderReceipt {
  return SourceSearchProviderReceiptSchema.parse(receipt)
}

export function mergeDiscoverSearchReceipts(
  primary?: PortSearchReceipt,
  fallback?: PortSearchReceipt,
): SourceSearchProviderReceipt | undefined {
  if (primary) {
    return sanitizeSourceSearchProviderReceipt(primary)
  }
  if (fallback) {
    return sanitizeSourceSearchProviderReceipt(fallback)
  }
  return undefined
}

/** Uses top-level `estimated_cost_dollars` only (never sums `estimated_cost_detail` to avoid double-count). */
export function exaLiteProviderEstimatedCostUsd(
  exaLite: SourceSearchProviderReceipt['exa_lite'],
): number | null {
  if (!exaLite) return null
  const dollars = exaLite.estimated_cost_dollars
  if (dollars === null || dollars === undefined) return null
  if (typeof dollars === 'number' && Number.isFinite(dollars) && dollars >= 0) {
    return dollars
  }
  return null
}

/** Provider-estimated search cost only; never treated as invoiced model spend. */
export function usageSettlementFromSearchProviderReceipt(
  receipt: SourceSearchProviderReceipt | undefined,
  attemptId: string,
  asOf: string,
): UsageSettlement | undefined {
  const amount = exaLiteProviderEstimatedCostUsd(receipt?.exa_lite)
  if (amount === null) {
    return undefined
  }
  return {
    attempt_id: attemptId,
    cost: {
      status: 'estimated',
      amount_usd: amount,
      method: 'exa_lite_estimated_cost_dollars',
      as_of: asOf,
    },
  }
}

export function reportLimitationsFromSearchProviderReceipt(
  receipt: SourceSearchProviderReceipt,
): string[] {
  const limitations: string[] = [
    `search_provider_configured:${receipt.configured_provider_id}`,
    `search_provider_effective:${receipt.effective_provider_id}`,
  ]
  if (receipt.exa_participation) {
    limitations.push(`exa_participation:${receipt.exa_participation}`)
  }
  if (receipt.degradation) {
    limitations.push(
      `search_provider_degraded:${receipt.degradation.from_provider_id}->${receipt.degradation.to_provider_id}:${receipt.degradation.reason}`,
    )
  }
  if (receipt.exa_lite) {
    const requestId = receipt.exa_lite.request_id ?? 'unknown'
    limitations.push(`exa_lite_request_id:${requestId}`)
    const estimated = exaLiteProviderEstimatedCostUsd(receipt.exa_lite)
    limitations.push(
      estimated === null
        ? 'exa_lite_provider_estimated_cost_usd:unknown'
        : `exa_lite_provider_estimated_cost_usd:${estimated}`,
    )
    limitations.push('exa_lite_highlights_discovery_only:not_admitted_passages')
  }
  return limitations
}

function intentFromEvent(event: ResearchStoreEvent): ExternalOperationIntent | undefined {
  if (event.kind !== 'external_operation_intent') return undefined
  return (event.payload as { intent: ExternalOperationIntent }).intent
}

function completionFromEvent(event: ResearchStoreEvent): ExternalOperationCompletion | undefined {
  if (event.kind !== 'external_operation_completed') return undefined
  return (event.payload as { completion: ExternalOperationCompletion }).completion
}

/** Aggregate sanitized search receipts from durable store events for terminal report propagation. */
export function deriveSearchProviderReportLimitations(
  events: readonly ResearchStoreEvent[],
): string[] {
  const searchOperationIds = new Set<string>()
  for (const event of events) {
    const intent = intentFromEvent(event)
    if (intent?.operation_kind === 'source_search') {
      searchOperationIds.add(intent.operation_id)
    }
  }
  const limitations: string[] = []
  for (const event of events) {
    const completion = completionFromEvent(event)
    if (!completion?.search_provider_receipt) continue
    if (!searchOperationIds.has(completion.operation_id)) continue
    limitations.push(...reportLimitationsFromSearchProviderReceipt(completion.search_provider_receipt))
  }
  return limitations
}

export function sourceSearchCompletionOutcome(params: {
  discoverReceipt?: SourceSearchProviderReceipt
  searchAttemptId: string
  completedAt: string
}): {
  usage_settlement?: UsageSettlement
  search_provider_receipt?: SourceSearchProviderReceipt
} {
  const receipt = params.discoverReceipt
  if (!receipt) {
    return {}
  }
  const usage_settlement = usageSettlementFromSearchProviderReceipt(
    receipt,
    params.searchAttemptId,
    params.completedAt,
  )
  return {
    search_provider_receipt: receipt,
    ...(usage_settlement ? { usage_settlement } : {}),
  }
}
