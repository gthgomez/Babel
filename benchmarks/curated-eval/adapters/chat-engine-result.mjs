import { normalizeAttempt } from '../runner.mjs'

function uniqueModel(receipts, field) {
  const values = [...new Set(receipts.map((receipt) => receipt[field]).filter((value) => typeof value === 'string' && value.length > 0))]
  return values.length === 1 ? values[0] : null
}

function engineTerminal(result) {
  if (result.status === 'cancelled' || result.outcome === 'CANCELLED') return 'cancelled'
  if (result.status === 'budget_exhausted' || result.outcome === 'BUDGET_EXHAUSTED') return 'limit_reached'
  if (result.outcome === 'INFRA_FAILURE') return 'infra_failed'
  if (['BLOCKED_EXTERNAL', 'BLOCKED_POLICY', 'INVALID_TASK', 'NEEDS_HUMAN_DECISION'].includes(result.outcome)) return 'blocked'
  if (result.outcome === 'AGENT_FAILURE') return 'failed'
  if (['completed', 'failed', 'blocked'].includes(result.status)) return result.status
  return 'unknown'
}

/**
 * Convert an already completed Babel ChatEngine result to the curated report
 * contract. This adapter is intentionally pure: it does not construct a
 * provider, run ChatEngine, or start a task. Live execution must be supplied by
 * the separately reviewed task container and narrowly brokered provider path.
 */
export function adaptChatEngineResult(input) {
  const result = input.result ?? {}
  const receipts = Array.isArray(result.turnRouting) ? result.turnRouting : []
  const routingTurns = receipts.map((receipt) => ({
    turn: Number.isInteger(receipt.turn) ? receipt.turn : null,
    requested_model: receipt.requested_model_id ?? null,
    sent_model: receipt.sent_model_id ?? null,
    observed_model: receipt.observed_model_id ?? null,
    input_tokens: Number.isFinite(receipt.input_tokens) ? receipt.input_tokens : null,
    output_tokens: Number.isFinite(receipt.output_tokens) ? receipt.output_tokens : null,
    cost_usd: Number.isFinite(receipt.cost_usd) ? receipt.cost_usd : null,
  }))
  const requestedByTurn = uniqueModel(receipts, 'requested_model_id')
  const sentModel = uniqueModel(receipts, 'sent_model_id')
  const observedModel = uniqueModel(receipts, 'observed_model_id')
  const completionClaimed = input.completionClaimed === true
  const usage = result.usage ?? {}
  const costUsd = Object.hasOwn(usage, 'completeCostUSD')
    ? usage.completeCostUSD
    : usage.costComplete === false || (Number.isFinite(usage.unknownChargeCount) && usage.unknownChargeCount > 0)
      ? null
      : usage.totalCostUSD

  return normalizeAttempt({
    task_id: input.taskId,
    attempt_id: input.attemptId,
    harness_build: input.harnessBuild,
    adapter: 'babel_source_chat_engine_result',
    task_image: input.taskImage,
    task_revision: input.taskRevision,
    requested_model: input.requestedModel ?? requestedByTurn,
    sent_model: sentModel,
    observed_model: observedModel,
    model_routing: {
      requested: input.requestedModel ?? requestedByTurn,
      sent: sentModel,
      observed: observedModel,
      turns: routingTurns,
    },
    terminal_status: engineTerminal(result),
    engine_terminal_outcome: result.outcome ?? null,
    error_class: result.outcome === 'INFRA_FAILURE' ? 'engine_infrastructure_failure' : input.errorClass ?? null,
    errors: Array.isArray(input.errors) ? input.errors : [],
    completion_claimed: completionClaimed,
    completion_claim_evidence: input.completionClaimEvidence ?? (completionClaimed ? result.answer ?? null : null),
    verifier: input.verifier ?? { status: 'not_run', assertions: null, errors: [] },
    diff: input.diff ?? { added: [], modified: [], deleted: [] },
    exposure: input.exposure ?? { oracle_visible: false, reference_visible: false, unexpected_reads: [] },
    usage: {
      input_tokens: result.usage?.totalInputTokens,
      output_tokens: result.usage?.totalOutputTokens,
      cost_usd: costUsd,
      duration_ms: input.durationMs,
      retries: input.retries,
    },
    started_at: input.startedAt,
    completed_at: input.completedAt,
    scripted_provider: input.scriptedProvider === true,
    model_performance_claim: input.modelPerformanceClaim === true,
  })
}
