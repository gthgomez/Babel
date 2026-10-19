import type { PreparedProviderRequest } from '../runners/preparedProviderRequest.js'

/** Immutable pressure from the complete failed request, including output reserve. */
export interface CompactionRecoveryPressure {
  readonly requestId: string
  readonly requestDigest: string
  readonly contextLimitTokens: number
  readonly inputTokens: number
  readonly reservedCompletionTokens: number
  readonly requiredReductionTokens: number
  /** Non-native requests flatten history into one user prompt. Never persisted. */
  readonly textRequest?: Readonly<{ body: string }>
}

/** Unknown or already admitted requests cannot establish a recovery deficit. */
export function deriveCompactionRecoveryPressure(
  request: PreparedProviderRequest,
): CompactionRecoveryPressure | null {
  const limit = request.context_limit_tokens
  const input = request.accounting.estimated_input_tokens
  const reserve = request.accounting.reserved_completion_tokens
  const total = request.accounting.estimated_total_tokens
  if (request.admission !== 'over_limit' || limit === null || input === null ||
      reserve === null || total === null || total <= limit) return null
  return Object.freeze({
    requestId: request.request_id,
    requestDigest: request.body_digest,
    contextLimitTokens: limit,
    inputTokens: input,
    reservedCompletionTokens: reserve,
    requiredReductionTokens: total - limit,
    ...(request.mode !== 'native' ? { textRequest: Object.freeze({ body: request.body }) } : {}),
  })
}

/** Preserve instructions, schemas, routing and sampling from the actual failed body. */
export function rebuildTextRecoveryRequest(
  pressure: CompactionRecoveryPressure,
  prompt: string,
): string | null {
  if (!pressure.textRequest) return null
  try {
    const body = JSON.parse(pressure.textRequest.body)
    if (!body || !Array.isArray(body.messages) || body.messages.length !== 2 ||
        body.messages[0]?.role !== 'system' || typeof body.messages[0].content !== 'string' ||
        body.messages[1]?.role !== 'user' || typeof body.messages[1].content !== 'string') return null
    body.messages[1] = { ...body.messages[1], content: prompt }
    return JSON.stringify(body)
  } catch { return null }
}
