import type { ResearchModelInvocationResult } from '../ports/researchModelPort.js'

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
