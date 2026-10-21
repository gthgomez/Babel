import type { ModelRouteReceiptSchema, UsageSettlementSchema } from '../contracts/common.js'
import type { ProviderInvokeDiagnostics } from '../contracts/providerInvokeDiagnostics.js'
import type { ResearchModelOperationKind } from '../contracts/modelOutputs.js'
import type { z } from 'zod'

export type { ResearchModelOperationKind } from '../contracts/modelOutputs.js'
export type ModelRouteReceipt = z.infer<typeof ModelRouteReceiptSchema>
export type UsageSettlement = z.infer<typeof UsageSettlementSchema>

export interface ResearchModelInvocationRequest {
  operationId: string
  /** Admitted attempt identity from dispatch — must not be invented by the port. */
  attemptId: string
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
      providerInvokeDiagnostics?: ProviderInvokeDiagnostics
    }
  | {
      status: 'failed'
      operationId: string
      failureCategory: string
      message: string
      usageSettlement: UsageSettlement
      providerInvokeDiagnostics?: ProviderInvokeDiagnostics
    }
  | {
      status: 'cancelled'
      operationId: string
      usageSettlement: UsageSettlement
      providerInvokeDiagnostics?: ProviderInvokeDiagnostics
    }
  | {
      status: 'uncertain'
      operationId: string
      message: string
      usageSettlement: UsageSettlement
      providerInvokeDiagnostics?: ProviderInvokeDiagnostics
    }

export interface ResearchModelPort {
  invokeStructured(request: ResearchModelInvocationRequest): Promise<ResearchModelInvocationResult>
}
