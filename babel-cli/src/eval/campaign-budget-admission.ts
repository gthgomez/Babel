import type { CampaignBudget, CampaignBudgetSettleResult } from './campaign-budget.js'

export type CampaignBudgetAdmissionResult<T> =
  | { admitted: false }
  | { admitted: true; result: T; settlement: CampaignBudgetSettleResult }

/**
 * Reserve campaign budget before dispatch; settle from measured usage afterward.
 * Callers must not invoke `dispatch` when `admitted` is false.
 */
export async function runCampaignBudgetAdmitted<T>(input: {
  budget: CampaignBudget
  operationId: string
  upperBoundMicroUsd: number
  dispatch: () => Promise<T>
  measureUsage: (result: T) => number | 'unknown'
}): Promise<CampaignBudgetAdmissionResult<T>> {
  if (!input.budget.reserve(input.operationId, input.upperBoundMicroUsd)) {
    return { admitted: false }
  }
  const result = await input.dispatch()
  const settlement = input.budget.settle(input.operationId, input.measureUsage(result))
  return { admitted: true, result, settlement }
}
