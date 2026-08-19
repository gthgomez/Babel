/**
 * Frozen coding-agent corpus v0 — pinned task schema and trajectory scoring.
 */

export const CODING_CORPUS_VERSION = 'coding-corpus-v0' as const

export type TaskClass =
  | 'single_file_bug'
  | 'medium_bug'
  | 'multi_file_feature'
  | 'behavior_preserving_refactor'
  | 'failing_test_repair'
  | 'unfamiliar_repo'
  | 'api_contract'
  | 'dependency_config_build'
  | 'regression_shared_workspace'

export type TaskRisk = 'low' | 'medium' | 'high'

export interface CodingCorpusTask {
  id: string
  repository: string
  starting_commit: string
  task_prompt: string
  task_class: TaskClass
  risk: TaskRisk
  visible_checks: string[]
  hidden_acceptance: string[]
  known_baseline_failures: string[]
  max_cost_usd: number
  max_turns: number
  max_wall_s: number
  expected_files: string[]
  forbidden_changes: string[]
  language: string
  windows_relevant?: boolean
  validated_by: string
  validation_note: string
}

export type ObservationBlindnessKind =
  | 'dropped_stderr'
  | 'head_only_hidden_failure'
  | 'skipped_requested_range'
  | 'inaccessible_overflow'
  | 'lost_parsed_failure'

export interface TrajectoryEvent {
  turn: number
  kind:
    | 'read'
    | 'read_range'
    | 'search'
    | 'lsp'
    | 'git'
    | 'mutation'
    | 'verifier'
    | 'observation'
    | 'hypothesis'
    | 'finish'
  path?: string
  startLine?: number
  endLine?: number
  command?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  observation?: string
  skipped?: boolean
  skipReason?: string
  rawSpillPath?: string
  parsedFailures?: string[]
  hypothesis?: string
  claimedComplete?: boolean
  hiddenTestsPassed?: boolean
}

export interface CorpusTrajectory {
  task_id: string
  harness: 'babel_baseline' | 'babel_hardened' | 'opencode' | 'fixture'
  events: TrajectoryEvent[]
}

export interface TaskScore {
  task_id: string
  hiddenSuccess: boolean
  falseCompletion: boolean
  honestBlock: boolean
  observationBlindness: ObservationBlindnessKind[]
  repairEvidenceBeforeSecondMutation: boolean | null
  secondRepairCount: number
}

export interface CorpusScorecard {
  version: typeof CODING_CORPUS_VERSION
  taskCount: number
  hiddenSuccessRate: number
  falseCompletionRate: number
  observationBlindnessEvents: number
  repairEvidenceRate: number | null
  scores: TaskScore[]
}
