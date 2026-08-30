import type { EvidenceScope } from "../evalTypes.js";
import type { CausalRunWhyReport } from "../../services/causalAttribution.js";

export type CanaryIntendedTerminal =
  | "verified_behavioral_success"
  | "NO_CHANGE_REQUIRED"
  | "honest_block"
  | "false_complete_probe";

export interface CanaryFileSpec {
  relativePath: string;
  start: string;
  gold?: string;
  /** Inadequate patch used by false-completion probe tasks. */
  inadequate?: string;
}

export interface CanaryTaskSpec {
  id: string;
  title: string;
  prompt: string;
  intended_terminal: CanaryIntendedTerminal;
  files: CanaryFileSpec[];
  oracle_test: string;
  visible_test?: string;
  /** Public focused verifier exposed to the live agent workspace. */
  public_test?: string;
  production_paths: string[];
}

export interface CanaryTrialResult {
  task_id: string;
  trial_index: number;
  evidence_scope: EvidenceScope;
  provider?: string;
  model?: string;
  /** Terminal ChatEngine status, retained separately from verifier contract success. */
  status?: string | null;
  baseline_sha?: string | null;
  harness_sha?: string | null;
  run_dir?: string | null;
  evidence_path?: string;
  contract_success: boolean;
  code_fix_success: boolean;
  hidden_ok: boolean;
  visible_ok: boolean | null;
  claimed_complete: boolean;
  false_complete: boolean;
  honest_block: boolean;
  production_mutated: boolean;
  /** Digest of the captured production candidate state for paired evaluation. */
  candidate_state_hash?: string;
  tokens: number | null;
  cost_usd: number | null;
  wall_ms: number;
  notes: string[];
  /**
   * Fail-closed validity marker. Invalid tasks are never executed and never
   * aggregated; the sentinel row exists only for report transparency.
   */
  invalid_task?: boolean;
  invalid_reason?: string;
  causal_attribution?: CausalRunWhyReport;
}

export interface CanaryTaskScore {
  task_id: string;
  trials: number;
  successful_trials: number;
  single_trial_success_rate: number;
  all_trials_reliable: boolean;
  false_complete_count: number;
  /** Present when the task failed construction-time validity and was excluded. */
  invalid_reason?: string;
}

export interface CanaryReport {
  schema_version: 1;
  evidence_scope: EvidenceScope;
  pass_at_1_estimate: number;
  pass_hat_3_estimate: number;
  contract_success_rate: number;
  code_fix_success_rate: number;
  false_complete_rate: number;
  tasks: CanaryTaskScore[];
  trials: CanaryTrialResult[];
  /** Task ids excluded from scoring because validity was not proven. */
  invalid_task_ids: string[];
}
