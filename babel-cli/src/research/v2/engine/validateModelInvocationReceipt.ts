import type {
  ResearchModelInvocationResult,
  UsageSettlement,
} from '../ports/researchModelPort.js'
import { unknownUsageSettlement } from './settleExternalOperation.js'

export class ModelReceiptBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelReceiptBindingError'
  }
}

export function assertModelInvocationReceiptBound(
  operationId: string,
  attemptId: string,
  result: ResearchModelInvocationResult & { status: 'ok' },
): void {
  if (result.operationId !== operationId) {
    throw new ModelReceiptBindingError(
      `model result operationId ${result.operationId} does not match admitted ${operationId}`,
    )
  }
  if (result.receipt.operation_id !== operationId) {
    throw new ModelReceiptBindingError(
      `model receipt operation_id ${result.receipt.operation_id} does not match admitted ${operationId}`,
    )
  }
  if (result.receipt.usage_settlement.attempt_id !== attemptId) {
    throw new ModelReceiptBindingError(
      `usage settlement attempt_id ${result.receipt.usage_settlement.attempt_id} does not match admitted ${attemptId}`,
    )
  }
}

/** Usage for cancellation-after-return: bound ok receipts only; foreign bindings stay unknown. */
export function usageSettlementWhenAbortedAfterInvoke(
  operationId: string,
  attemptId: string,
  result: ResearchModelInvocationResult,
): UsageSettlement {
  if (
    result.status === 'failed' ||
    result.status === 'cancelled' ||
    result.status === 'uncertain'
  ) {
    return result.usageSettlement
  }
  if (result.status !== 'ok') {
    return unknownUsageSettlement(attemptId)
  }
  try {
    assertModelInvocationReceiptBound(operationId, attemptId, result)
    return result.receipt.usage_settlement
  } catch {
    return unknownUsageSettlement(attemptId)
  }
}
