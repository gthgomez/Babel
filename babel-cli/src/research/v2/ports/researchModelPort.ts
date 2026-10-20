import type { ModelRouteReceiptSchema } from '../contracts/common.js'
import type { z } from 'zod'

export type ModelRouteReceipt = z.infer<typeof ModelRouteReceiptSchema>

export type ResearchModelOperationKind =
  | 'plan_questions'
  | 'extract_findings'
  | 'semantic_support_review'
  | 'synthesize_report'

export interface ResearchModelInvocationRequest {
  operationId: string
  kind: ResearchModelOperationKind
  /** JSON-serializable payload; must not contain secrets or raw source policy escalation. */
  input: Record<string, unknown>
  signal: AbortSignal
}

export interface ResearchModelInvocationResult<T = Record<string, unknown>> {
  operationId: string
  output: T
  receipt: ModelRouteReceipt
}

/**
 * Async structured model operations delegated to ProviderEngine / OpenRouter admission.
 * Implementations must validate outputs before returning.
 */
export interface ResearchModelPort {
  invokeStructured<T extends Record<string, unknown>>(
    request: ResearchModelInvocationRequest,
  ): Promise<ResearchModelInvocationResult<T>>
}
