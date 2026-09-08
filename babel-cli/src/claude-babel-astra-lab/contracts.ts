import type { BenchmarkProfile, OpenCodeGoModel } from './models.js';

export const LAB_PROVIDER = 'opencode-go' as const;
export const MAX_ACTIVE_WORKER_HARNESSES = 1 as const;

export type LabHarness = 'claude-code' | 'babel-live';
export type LabFailureClass =
  | 'MODEL_FAILURE'
  | 'PROVIDER_FAILURE'
  | 'AUTH_FAILURE'
  | 'CLAUDE_PROXY_FAILURE'
  | 'BABEL_PROVIDER_ADAPTER_FAILURE'
  | 'MODEL_ATTRIBUTION_FAILURE'
  | 'HARNESS_FAILURE'
  | 'TOOL_FAILURE'
  | 'TEST_FAILURE'
  | 'TIMEOUT'
  | 'PROCESS_LEAK'
  | 'RESOURCE_PRESSURE'
  | 'VERIFIER_FAILURE'
  | 'POLICY_FAILURE'
  | 'UNKNOWN';

export type LabMetric = number | 'UNKNOWN';

export interface ResourceMetrics {
  processCount: LabMetric;
  childProcessCount: LabMetric;
  peakWorkingSet: LabMetric;
  cpuTimeMs: LabMetric;
  diskReadBytes: LabMetric;
  diskWriteBytes: LabMetric;
  processCleanup: 'PASS' | 'FAIL' | 'UNKNOWN';
  threadCount?: LabMetric;
  handleCount?: LabMetric;
  systemCommitPressure?: LabMetric;
}

export interface NormalizedTrajectoryEvent {
  sequence: number;
  timestamp?: string;
  event:
    | 'task_started'
    | 'model_request'
    | 'model_response'
    | 'repository_search'
    | 'file_read'
    | 'tool_proposed'
    | 'tool_started'
    | 'tool_completed'
    | 'tool_failed'
    | 'mutation_started'
    | 'mutation_completed'
    | 'test_started'
    | 'test_completed'
    | 'repair_started'
    | 'context_compaction'
    | 'completion_claimed'
    | 'completion_verified'
    | 'completion_rejected'
    | 'run_completed'
    | 'run_failed'
    | 'run_cancelled'
    | 'unknown';
  /** Original event fields remain data; normalization never invents facts. */
  data: Record<string, unknown>;
  sourceType?: string;
}

export interface NeutralLabReceipt {
  EXPERIMENT_ID: string;
  PAIR_ID: string;
  RUN_ID: string;
  SUPERVISOR: string;
  HARNESS: LabHarness;
  HARNESS_VERSION: string;
  HARNESS_ADAPTER: string;
  HARNESS_ADAPTER_VERSION: string;
  PROVIDER: string;
  PROVIDER_ROUTE: string;
  REQUESTED_MODEL: string;
  OBSERVED_MODEL: string | 'UNKNOWN';
  TASK_ID: string;
  REPOSITORY: string;
  BASE_SHA: string;
  HEAD_SHA: string | 'UNKNOWN';
  START_TIME: string;
  END_TIME: string;
  WALL_TIME: LabMetric;
  PROCESS_IDS: Array<number | string>;
  PROCESS_COUNT: LabMetric;
  PEAK_WORKING_SET: LabMetric;
  CPU_TIME: LabMetric;
  DISK_READ_BYTES: LabMetric;
  DISK_WRITE_BYTES: LabMetric;
  MODEL_CALLS: LabMetric;
  INPUT_TOKENS: LabMetric;
  OUTPUT_TOKENS: LabMetric;
  CACHED_TOKENS: LabMetric;
  TOOL_CALLS: LabMetric;
  FILES_READ: string[];
  FILES_CHANGED: string[];
  TEST_COMMANDS: string[];
  TEST_RESULTS: Record<string, unknown>;
  REPAIR_LOOPS: LabMetric;
  CONTEXT_COMPACTIONS: LabMetric;
  TERMINAL_CLAIM: string | 'UNKNOWN';
  VERIFIER_RESULT: string | 'UNKNOWN';
  FALSE_COMPLETION: boolean | 'UNKNOWN';
  POLICY_VIOLATION: boolean | 'UNKNOWN';
  HUMAN_INTERVENTIONS: LabMetric;
  RAW_TRAJECTORY_PATH: string;
  NORMALIZED_TRAJECTORY_PATH: string;
  FALLBACK_USED: boolean | 'UNKNOWN';
  RECEIPT_HASH: string;
}

export interface ControlledRun {
  audit?: {
    executionSuccess: boolean | 'UNKNOWN';
    termination: { kind: string; evidence: string[] };
    observedProvider: string;
    observedModel: string;
    fallback: boolean | 'UNKNOWN';
    failures: Array<{ category: string; diagnostic: string; action?: string }>;
    retries: number | 'UNKNOWN';
    recoverySuccess: boolean | 'UNKNOWN';
    actionableDiagnostics?: boolean | 'UNKNOWN';
  };
  receipt: NeutralLabReceipt;
  profile: BenchmarkProfile;
  exactModel: OpenCodeGoModel;
  fixtureSha: string;
  verifier: { result: string; deterministic: boolean };
  rawTrajectory: string;
  normalizedTrajectory: string;
  resourceMetrics: ResourceMetrics;
}

export interface PairValidity {
  valid: boolean;
  code: 'VALID' | 'PAIR_INVALID' | 'INVALID_CONTROLLED_PAIR';
  reasons: string[];
}

export interface AstraComparisonPacket {
  task: string;
  fixtureSha: string;
  model: OpenCodeGoModel;
  provider: string;
  claude: ControlledRun;
  babel: ControlledRun;
  pairedMetricDeltas: Record<string, number | 'UNKNOWN'>;
  pairValidity: PairValidity;
}
