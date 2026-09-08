import { parseBabelReviewAdjudication, type BabelReviewAdjudicationRecord } from './babelReviewAdjudication.js'

type Row = Record<string, unknown>
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isRow = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value)

/** Summaries are observations plus operator labels, never approval or billing evidence. */
export function summarizeBabelReviews(artifacts: Row[], adjudications: unknown[] = []) {
  const reviews = artifacts.filter(a => isRow(a) && a['harness'] === 'babel' && a['mode'] === 'chat')
  const models: Record<string, { runs: number; completed: number; pending: number; unknown_status: number; failed: number; approvals: number; blocks: number; calls: number; failed_calls: number; transient_retries: number; input_tokens_observed: number; output_tokens_observed: number; calls_with_unknown_usage: number; model_ms: number; calls_with_unknown_latency: number; format_repairs: number; estimated_cost_usd_observed: number; estimated_cost_usd_total: number | null; calls_with_unknown_cost: number }> = {}
  const failures: Record<string, number> = {}
  const executions = new Set<string>()
  for (const artifact of reviews) {
    if (typeof artifact['execution_id'] === 'string') executions.add(artifact['execution_id'])
    const model = String(artifact['model'] ?? 'unknown')
    const item = models[model] ??= { runs: 0, completed: 0, pending: 0, unknown_status: 0, failed: 0, approvals: 0, blocks: 0, calls: 0, failed_calls: 0, transient_retries: 0, input_tokens_observed: 0, output_tokens_observed: 0, calls_with_unknown_usage: 0, model_ms: 0, calls_with_unknown_latency: 0, format_repairs: 0, estimated_cost_usd_observed: 0, estimated_cost_usd_total: null, calls_with_unknown_cost: 0 }
    item.runs++
    const status = String(artifact['status'] ?? 'unknown')
    const verdict = artifact['verdict'] as Row | undefined
    if (status === 'review_completed' || status === 'repair_proposal_completed') {
      item.completed++
      if (verdict?.['verdict'] === 'APPROVE') item.approvals++
      if (verdict?.['verdict'] === 'BLOCK') item.blocks++
    } else if (['started', 'running', 'cli_completed'].includes(status)) item.pending++
    else if (['review_failed', 'repair_failed', 'failed'].includes(status)) {
      item.failed++
      const failure = String(artifact['failure_code'] ?? status)
      failures[failure] = (failures[failure] ?? 0) + 1
    } else item.unknown_status++
    item.format_repairs += Math.max(0, Array.isArray(artifact['attempts']) ? artifact['attempts'].length - 1 : 0)
    for (const raw of Array.isArray(artifact['calls']) ? artifact['calls'] as unknown[] : []) {
      const call = isRow(raw) ? raw : {}
      item.calls++
      if (call['status'] === 'failed') item.failed_calls++
      if (call['retry_reason'] === 'transient_before_output') item.transient_retries++
      const usage = call['metadata'] as Row | null
      const input = usage?.['prompt_tokens']; const output = usage?.['completion_tokens']
      if (nonnegative(input)) item.input_tokens_observed += input
      if (nonnegative(output)) item.output_tokens_observed += output
      if (!nonnegative(input) || !nonnegative(output)) item.calls_with_unknown_usage++
      if (nonnegative(call['elapsed_ms'])) item.model_ms += call['elapsed_ms']
      else item.calls_with_unknown_latency++
      if (nonnegative(usage?.['estimated_cost_usd'])) item.estimated_cost_usd_observed += usage['estimated_cost_usd']
      else item.calls_with_unknown_cost++
    }
  }
  for (const item of Object.values(models)) item.estimated_cost_usd_total = item.calls > 0 && item.calls_with_unknown_cost === 0 ? item.estimated_cost_usd_observed : null

  let invalidAdjudications = 0
  const labels: BabelReviewAdjudicationRecord[] = []
  for (const value of adjudications) {
    try { labels.push(parseBabelReviewAdjudication(value)) } catch { invalidAdjudications++ }
  }
  const latest = new Map<string, BabelReviewAdjudicationRecord>()
  // Corrections append new records; latest timestamp/id wins only within the
  // same execution, exact candidate and subject. Raw earlier labels remain.
  for (const label of labels.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id))) {
    const key = JSON.stringify([label.execution_id, label.candidate.repository, label.candidate.pr_number, label.candidate.base_sha, label.candidate.head_sha, label.subject.kind, label.subject.id])
    latest.set(key, label)
  }
  const outcomes = { confirmed: 0, false_positive: 0, missed_defect: 0, inconclusive: 0 }
  const lifecycle = { with_repair_link: 0, with_test_links: 0, with_rereview_links: 0, with_merge_link: 0, with_full_recorded_chain: 0 }
  const labeledExecutions = new Set<string>()
  let labelsWithObservedExecution = 0
  for (const label of latest.values()) {
    outcomes[label.outcome]++
    labeledExecutions.add(label.execution_id)
    if (executions.has(label.execution_id)) labelsWithObservedExecution++
    const repair = !!label.links?.repair_execution_id && !!label.links.repair_head_sha
    const tests = !!label.links?.test_runs?.length
    const rereview = !!label.links?.rereview_execution_ids?.length
    const merge = !!label.links?.merge_commit_sha && !!label.links.merge_ref
    if (repair) lifecycle.with_repair_link++
    if (tests) lifecycle.with_test_links++
    if (rereview) lifecycle.with_rereview_links++
    if (merge) lifecycle.with_merge_link++
    if (repair && tests && rereview && merge) lifecycle.with_full_recorded_chain++
  }
  const precisionDenominator = outcomes.confirmed + outcomes.false_positive
  return {
    schema_version: 2, run_count: reviews.length, models, failures,
    quality: {
      authority: 'operator_recorded_not_independently_verified',
      records: labels.length, invalid_records: invalidAdjudications, unique_subjects: latest.size, outcomes,
      labeled_finding_precision: precisionDenominator ? outcomes.confirmed / precisionDenominator : null,
      precision_denominator: precisionDenominator,
      labels_with_observed_execution: labelsWithObservedExecution,
      labels_without_observed_execution: latest.size - labelsWithObservedExecution,
      observed_executions_without_labels: [...executions].filter(id => !labeledExecutions.has(id)).length,
      lifecycle_links_recorded: lifecycle,
      recall: null, ground_truth_coverage: 'unknown', time_to_verified_merge_ms: null,
    },
    missing_observations: { tool_outcome_counts: 'unknown: thread_events are not loaded', billed_cost: 'not_available', candidate_identity_join: 'not_performed', verified_merge_timing: 'not_available' },
    quality_note: 'Approval counts are not accuracy. Precision uses only operator-labeled confirmed/(confirmed+false_positive) subjects; inconclusive and missed-defect labels are excluded. Execution links do not verify candidate identity or external evidence. Recall, total defect coverage and verified merge timing remain unknown. Lifecycle links are recorded claims, not independently verified outcomes. Pending status is not a liveness guarantee. Token/latency sums include observations only; metadata estimated costs are not provider bills and unknown total cost remains null. Generic payload usage.totalCostUSD and payload tool_call_count are not treated as complete provider cost or tool-event observations.',
  }
}
