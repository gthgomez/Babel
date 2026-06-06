import type { ExecutionProfileName } from '../config/executionProfiles.js';
import type { LiteRouteMetadata, LiteResultPayload, UserFacingStatus } from '../cli/structuredOutput.js';
import type { SparkParallelReviewResult, SparkSynthesis } from '../services/babelFull.js';
import type { LiteFullRouteDecision } from '../services/liteFullRouter.js';
import type { SmallFixProvider } from '../services/smallFix.js';

/** Canonical Lite session verbs — single source of truth for agent dispatch. */
export type LiteSessionVerb =
  | 'ask'
  | 'plan'
  | 'propose'
  | 'diff'
  | 'patch'
  | 'fix'
  | 'review'
  | 'undo'
  | 'do';

/** Proposal-only verbs that share the same lane. */
export type ProposalSessionVerb = 'propose' | 'diff' | 'patch';

export const BABEL_LITE_ARTIFACT_ROOT = 'runs/babel-lite';

/** Target artifact file names under `runs/babel-lite/<run-id>/`. */
export const BABEL_LITE_ARTIFACT_FILES = [
  'manifest.json',
  'request.json',
  'response.md',
  'plan.md',
  'proposal.diff',
  'patch.diff',
  'changes.diff',
  'verification.json',
  'checkpoint.json',
  'cost_ledger.json',
  'failure.json',
] as const;

export type BabelLiteArtifactFile = typeof BABEL_LITE_ARTIFACT_FILES[number];

export interface BabelLiteArtifactLayout {
  root: typeof BABEL_LITE_ARTIFACT_ROOT;
  runId: string;
  runDir: string;
  files: Partial<Record<BabelLiteArtifactFile, string>>;
}

export interface AgentSessionOptions {
  task: string;
  verb: LiteSessionVerb;
  project?: string;
  projectRoot?: string;
  workspaceRoot?: string | null;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  /** `mock` enables offline demo fix (lite-trust-demo fixture scope only). */
  provider?: SmallFixProvider;
  executionProfile?: ExecutionProfileName;
  liteOnly?: boolean;
  agentsMode?: 'off' | 'read-only';
  json?: boolean;
  stream?: boolean;
  routeDecision?: LiteFullRouteDecision;
  /** Run plan→propose→fix→review→undo in one session (Wave 3 worker loop). */
  workerChain?: boolean;
  /** Linked worker-chain session run dir (Wave 4 continue). */
  workerChainSessionDir?: string;
  /** On verifier failure, auto-restore pre-mutation checkpoint (bl fix only). */
  rollbackOnFail?: boolean;
  /** Read-only Spark synthesis from parallel review (Wave 5 bl do). */
  sparkSynthesis?: SparkSynthesis;
  sparkReview?: SparkParallelReviewResult;
}

export interface AgentSessionResult {
  payload: LiteResultPayload | Record<string, unknown>;
  exitCode: number;
  humanText?: string;
}

export interface AgentWorkerLoopStep {
  verb: LiteSessionVerb;
  status: string;
  exit_code: number;
  execution_mode?: string;
  run_dir?: string | null;
}

export interface AgentWorkerLoopPayload {
  status: 'WORKER_LOOP_COMPLETE' | 'WORKER_LOOP_FAILED';
  user_status: 'success' | 'failed';
  command: 'do';
  lite_command: 'do';
  execution_path: 'worker_loop';
  execution_mode?: 'offline_demo' | 'live';
  task: string;
  project?: string;
  steps: AgentWorkerLoopStep[];
  failed_step?: LiteSessionVerb;
  next: string[];
}

export interface AgentLaneContext {
  task: string;
  project?: string;
  projectRoot?: string;
  workspaceRoot?: string | null;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  /** Workflow provider: live | mock (mock = offline demo). */
  provider?: string;
  routeDecision?: LiteRouteMetadata;
  sparkSynthesis?: SparkSynthesis;
  sparkReview?: SparkParallelReviewResult;
}

export function isProposalVerb(verb: LiteSessionVerb): verb is ProposalSessionVerb {
  return verb === 'propose' || verb === 'diff' || verb === 'patch';
}

export function normalizeProposalVerb(verb: ProposalSessionVerb): 'patch' {
  return 'patch';
}

export function emptyLiteUsage(): LiteResultPayload['usage'] {
  return {
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    modelBreakdown: {},
    cost_ledger_path: null,
  };
}

export function baseReadOnlyLitePayload(input: {
  command: LiteSessionVerb;
  task: string;
  project: string | null;
  runDir: string | null;
  projectRoot: string | null;
  status: string;
  userStatus: UserFacingStatus;
  selectedLane: string;
  executionPath: string;
  next: string[];
}): Partial<LiteResultPayload> {
  return {
    status: input.status,
    user_status: input.userStatus,
    command: input.command as LiteResultPayload['command'],
    lite_command: input.command as LiteResultPayload['lite_command'],
    selected_lane: input.selectedLane,
    execution_path: input.executionPath,
    task: input.task,
    project: input.project,
    run_dir: input.runDir,
    scope: {
      project_root: input.projectRoot,
      allowed_write_paths: [],
      refused_paths: [],
    },
    changed_files: [],
    verification: {
      status: 'not_required',
      commands: [],
      skipped_reason: 'read-only lane',
    },
    checkpoint: {
      required: false,
      available: false,
      restore_command: null,
      inspect_command: input.runDir ? `babel checkpoint list --run "${input.runDir}"` : null,
    },
    evidence: {
      run_dir: input.runDir,
      support_path: input.runDir,
      artifacts: input.runDir ? [] : [],
    },
    checks: [],
    tests_or_checks: [],
    usage: emptyLiteUsage(),
    schema_retries: 0,
    recovered_after_schema_retry: false,
    next: input.next,
    support_path: input.runDir,
    details: {
      support_path: input.runDir,
      full_babel_equivalent: `babel run "${input.task.replace(/"/g, '\\"')}" --mode verified`,
    },
  };
}
