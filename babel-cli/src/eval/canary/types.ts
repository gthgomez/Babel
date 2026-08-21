import type { EvidenceScope } from '../evalTypes.js'

export type CanaryIntendedTerminal =
  | 'verified_behavioral_success'
  | 'NO_CHANGE_REQUIRED'
  | 'honest_block'
  | 'false_complete_probe'

export interface CanaryFileSpec {
  relativePath: string
  start: string
  gold?: string
  /** Inadequate patch used by C10 probe. */
  inadequate?: string
}

export interface CanaryTaskSpec {
  id: string
  title: string
  prompt: string
  intended_terminal: CanaryIntendedTerminal
  files: CanaryFileSpec[]
  oracle_test: string
  visible_test?: string
  production_paths: string[]
}

export interface CanaryTrialResult {
  task_id: string
  trial_index: number
  evidence_scope: EvidenceScope
  contract_success: boolean
  code_fix_success: boolean
  hidden_ok: boolean
  visible_ok: boolean | null
  claimed_complete: boolean
  false_complete: boolean
  honest_block: boolean
  production_mutated: boolean
  tokens: number | null
  cost_usd: number | null
  wall_ms: number
  notes: string[]
}

export interface CanaryTaskScore {
  task_id: string
  trials: number
  successful_trials: number
  single_trial_success_rate: number
  all_trials_reliable: boolean
  false_complete_count: number
}

export interface CanaryReport {
  schema_version: 1
  evidence_scope: EvidenceScope
  pass_at_1_estimate: number
  pass_hat_3_estimate: number
  contract_success_rate: number
  code_fix_success_rate: number
  false_complete_rate: number
  tasks: CanaryTaskScore[]
  trials: CanaryTrialResult[]
}
