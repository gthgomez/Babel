import type { CanaryReport, CanaryTaskScore, CanaryTrialResult } from './types.js'
import type { EvidenceScope } from '../evalTypes.js'

export function uncertaintyForTrials(n: number): number | null {
  if (n < 2) return null
  return 1 / Math.sqrt(n)
}

export function scoreCanaryTrials(
  trials: CanaryTrialResult[],
  evidence_scope: EvidenceScope,
): CanaryReport {
  // Fail-closed aggregation: sentinel rows from validity-excluded tasks are
  // never scored. They stay in report.trials for transparency only.
  const validTrials = trials.filter((t) => !t.invalid_task)
  const invalidTaskIds = [
    ...new Set(trials.filter((t) => t.invalid_task).map((t) => t.task_id)),
  ]
  const byTask = new Map<string, CanaryTrialResult[]>()
  for (const t of validTrials) {
    const list = byTask.get(t.task_id) ?? []
    list.push(t)
    byTask.set(t.task_id, list)
  }
  const tasks: CanaryTaskScore[] = []
  for (const [task_id, rows] of byTask) {
    const successful = rows.filter((r) => r.contract_success).length
    tasks.push({
      task_id,
      trials: rows.length,
      successful_trials: successful,
      single_trial_success_rate: rows.length === 0 ? 0 : successful / rows.length,
      all_trials_reliable: rows.length > 0 && successful === rows.length,
      false_complete_count: rows.filter((r) => r.false_complete).length,
    })
  }
  const n = tasks.length || 1
  const passAt1 = tasks.reduce((s, t) => s + t.single_trial_success_rate, 0) / n
  const passHat3 = tasks.filter((t) => t.all_trials_reliable).length / n
  const allTrials = validTrials
  return {
    schema_version: 1,
    evidence_scope,
    pass_at_1_estimate: passAt1,
    pass_hat_3_estimate: passHat3,
    contract_success_rate:
      allTrials.length === 0
        ? 0
        : allTrials.filter((t) => t.contract_success).length / allTrials.length,
    code_fix_success_rate:
      allTrials.length === 0
        ? 0
        : allTrials.filter((t) => t.code_fix_success).length / allTrials.length,
    false_complete_rate:
      allTrials.length === 0
        ? 0
        : allTrials.filter((t) => t.false_complete).length / allTrials.length,
    tasks,
    trials,
    invalid_task_ids: invalidTaskIds,
  }
}
