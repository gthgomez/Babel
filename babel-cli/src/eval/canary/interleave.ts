export type ArmId = 'baseline' | 'candidate'

export interface InterleavedTrial {
  task_id: string
  trial_index: number
  first: ArmId
  second: ArmId
}

/**
 * Alternate which arm runs first per task/trial to reduce provider drift.
 */
export function interleaveTrials(taskIds: string[], trials: number): InterleavedTrial[] {
  const out: InterleavedTrial[] = []
  let flip = 0
  for (const task_id of taskIds) {
    for (let trial_index = 1; trial_index <= trials; trial_index += 1) {
      const first: ArmId = flip % 2 === 0 ? 'baseline' : 'candidate'
      const second: ArmId = first === 'baseline' ? 'candidate' : 'baseline'
      out.push({ task_id, trial_index, first, second })
      flip += 1
    }
  }
  return out
}
