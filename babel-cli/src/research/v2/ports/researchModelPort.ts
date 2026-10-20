import type { ModelRouteReceiptSchema, UsageSettlementSchema } from '../contracts/common.js'
import type { ResearchModelOperationKind } from '../contracts/modelOutputs.js'
import type { z } from 'zod'

export type { ResearchModelOperationKind } from '../contracts/modelOutputs.js'
export type ModelRouteReceipt = z.infer<typeof ModelRouteReceiptSchema>
export type UsageSettlement = z.infer<typeof UsageSettlementSchema>

export interface ResearchModelInvocationRequest {
  operationId: string
  kind: ResearchModelOperationKind
  input: Record<string, unknown>
  signal: AbortSignal
}

export type ResearchModelInvocationResult =
  | {
      status: 'ok'
      operationId: string
      output: Record<string, unknown>
      receipt: ModelRouteReceipt
    }
  | {
      status: 'failed'
      operationId: string
      failureCategory: string
      message: string
      usageSettlement: UsageSettlement
    }
  | {
      status: 'cancelled'
      operationId: string
      usageSettlement: UsageSettlement
    }
  | {
      status: 'uncertain'
      operationId: string
      message: string
      usageSettlement: UsageSettlement
    }

export interface ResearchModelPort {
  invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult>
}
