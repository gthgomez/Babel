import type { ExecutionProfileName } from '../config/executionProfiles.js';
import type {
  LiteRouteMetadata,
  LiteResultPayload,
  UserFacingStatus,
} from '../cli/structuredOutput.js';
import type { SparkParallelReviewResult, SparkSynthesis } from '../services/babelFull.js';
import type { LiteFullRouteDecision } from '../services/liteFullRouter.js';
import type { SmallFixProvider } from '../services/smallFix.js';
import type { LiteFixProgressReporter } from '../ui/liteFixProgress.js';
import type { LiteToolStreamSink } from '../ui/liteToolStream.js';

/** Canonical Lite session verbs — single source of truth for agent dispatch. */
export type LiteSessionVerb =
  | 'ask'
  | 'plan'
  | 'report'
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
  'report.md',
  'plan.md',
  'proposal.diff',
  'patch.diff',
  'changes.diff',
  'verification.json',
  'checkpoint.json',
  'cost_ledger.json',
  'failure.json',
] as const;

export type BabelLiteArtifactFile = (typeof BABEL_LITE_ARTIFACT_FILES)[number];

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
  /**
   * VCS: The absolute path to the directory Babel was started from (or the
   * fuzzy-resolved target directory). Used as the write anchor for mutating
   * tools without polluting process.cwd().
   */
  anchorPath?: string;
  /**
   * VCS: Permission preset shortcut — 'read-only' | 'ask' | 'auto'.
   * Overrides per-tool policy for the duration of this session.
   */
  preset?: 'read-only' | 'ask' | 'auto';
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  /** `mock` enables offline demo fix (lite-trust-demo fixture scope only). */
  provider?: SmallFixProvider;
  executionProfile?: ExecutionProfileName;
  liteOnly?: boolean;
  agentsMode?: 'off' | 'read-only' | 'live';
  json?: boolean;
  stream?: boolean;
  /** Chat mode: callback for each natural-language answer chunk during streaming.
   *  When set, raw text chunks are routed to the ConversationalRenderer for
   *  real-time markdown display (no JSON extraction). */
  onAnswerChunk?: (chunk: string) => void;
  /** Chat mode: tool execution callbacks for ConversationalRenderer visibility.
   *  Wired through from interactive.ts → AgentSession → ChatEngine. */
  onToolStart?: (tool: string, target: string) => number;
  onToolComplete?: (id: number, detail?: string) => void;
  onFileChanged?: (path: string, additions: number, deletions: number, content?: string) => void;
  onThought?: (thought: string) => void;
  /** System-level context injected at session start (e.g. CLAUDE.md + AGENTS.md content).
   *  Persists across all turns in the session — read once at startup, not per-turn. */
  systemContext?: string;
  /** Event bus for routing log messages and streaming chunks to the renderer. */
  eventBus?: import('../pipeline.js').BabelEventBus;
  routeDecision?: LiteFullRouteDecision;
  /** Run plan→propose→fix in one session (Wave 3 worker loop). */
  workerChain?: boolean;
  /** Linked worker-chain session run dir (Wave 4 continue). */
  workerChainSessionDir?: string;
  /** On verifier failure, auto-restore pre-mutation checkpoint (bl fix only). */
  rollbackOnFail?: boolean;
  /** Read-only Spark synthesis from parallel review (Wave 5 bl do). */
  sparkSynthesis?: SparkSynthesis;
  sparkReview?: SparkParallelReviewResult;
  /** Live progress reporter for small-fix human output. */
  progress?: LiteFixProgressReporter;
  /** Optional live tool stream for read-only discovery tool cards. */
  toolStream?: LiteToolStreamSink;
  /** Write human_summary.txt even when --json is set. */
  humanSummary?: boolean;
  /** Run an independent plan review subagent after plan generation (P1.1). */
  planReview?: boolean;
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
  /** VCS: Write anchor path (absolute), set at session boot. */
  anchorPath?: string;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  /** Workflow provider: live | mock (mock = offline demo). */
  provider?: string;
  routeDecision?: LiteRouteMetadata;
  sparkSynthesis?: SparkSynthesis;
  sparkReview?: SparkParallelReviewResult;
  toolStream?: LiteToolStreamSink;
  /** Run an independent plan review subagent after plan generation (P1.1). */
  planReview?: boolean;
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
  command: string;
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
      full_babel_equivalent: `babel run "${input.task.replace(/"/g, '\\"')}" --mode deep`,
    },
  };
}
