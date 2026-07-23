import { existsSync, readFileSync, promises as fsPromises } from 'node:fs';
import { join } from 'node:path';

import { BabelEventBus, runBabelPipeline } from '../pipeline.js';
import type { ValidMode } from '../cli/constants.js';
import {
  buildAskResultPayload,
  buildLiteResultPayload,
  formatAskResultHuman,
  formatLiteResultHuman,
  getSchemaRetrySummary,
  type LiteResultPayload,
  type LiteVerb,
} from '../cli/structuredOutput.js';
import { type ExecutionProfileName, resolveToolBudget } from '../config/executionProfiles.js';
import { runAskAnswerFastPath, runAskAnswerPath } from '../services/askAnswer.js';
import { StreamedAnswerExtractor } from '../runners/base.js';
import { runSparkParallelReview, type SparkParallelReviewResult } from '../services/babelFull.js';
import {
  inferDoExecutionVerb,
  liteVerbForSelectedLane,
  resolveDailyProfile,
  routeLiteOrFull,
  shouldSpawnSparkReview,
  type LiteFullAgentsMode,
  type LiteFullRouteDecision,
} from '../services/liteFullRouter.js';
import { runSmallFixPath, type SmallFixCompleted } from '../services/smallFix.js';
import {
  applyLiteOfflineEnv,
  createLiteProviderAdapter,
  restoreLiteOfflineEnv,
  snapshotLiteOfflineEnv,
} from './provider/textProviderLane.js';
import type {
  AgentSessionOptions,
  AgentSessionResult,
  AgentWorkerLoopPayload,
  AgentWorkerLoopStep,
  LiteSessionVerb,
} from './contracts.js';
import { isProposalVerb } from './contracts.js';
import { executionProfileForPreset, presetForVerb } from './policy.js';
import { resetCircuitBreaker } from './toolExecutor.js';
import { resetCompactionCircuitBreaker } from '../services/compaction.js';
import { runPlanLane } from './lanes/planLane.js';
import { runReportLane } from './lanes/reportLane.js';
import { runMutationAgentLoop } from './lanes/runMutationAgentLoop.js';
import { backgroundTaskRegistry } from '../services/backgroundTaskRegistry.js';
import { runProposalLane } from './lanes/proposalLane.js';
import { runReviewLane } from './lanes/reviewLane.js';
import { runUndoLane } from './lanes/undoLane.js';
import { beginLiteArtifactRun, writeLiteManifest, writeLiteRequest } from './liteArtifacts.js';
import {
  type WorkerChainManifest,
  WORKER_CHAIN_VERBS,
  writeWorkerChainManifest,
} from '../services/liteRecovery.js';
import { ChatEngine, type ChatCallbacks } from './chatEngine.js';

export { READ_ONLY_LITE_TOOLS } from './policy.js';

function buildLiteTask(verb: LiteSessionVerb, task: string): string {
  if (verb === 'ask') {
    return `Answer in read-only mode. Do not modify files. Do not propose an edit unless the user asks for a plan or fix. ${task}`;
  }
  if (verb === 'plan') {
    return `Plan only, do not modify. ${task}`;
  }
  if (isProposalVerb(verb)) {
    return `Produce a proposal-only patch or diff plan. Do not modify files. Do not apply changes. ${task}`;
  }
  return task;
}

function resolveLitePipelineMode(verb: LiteSessionVerb): ValidMode {
  if (verb === 'ask') return 'chat';
  if (verb === 'fix') return 'deep';
  return 'deep';
}

function isSuccessfulRunStatus(status: string): boolean {
  return (
    status === 'COMPLETE' ||
    status === 'COMPLETE_NO_MODIFICATION' ||
    status === 'READ_ONLY_NO_MODIFICATION'
  );
}

function getSmallFixCheckpointPayload(
  runDir: string | null,
  changedFiles: string[],
): LiteResultPayload['checkpoint'] {
  const required = changedFiles.length > 0;
  let checkpointId: string | null = null;
  if (runDir) {
    const smallFixCheckpointPath = join(runDir, 'small_fix_checkpoint.json');
    if (existsSync(smallFixCheckpointPath)) {
      try {
        const parsed = JSON.parse(readFileSync(smallFixCheckpointPath, 'utf-8')) as {
          checkpoint_id?: string;
        };
        checkpointId = typeof parsed.checkpoint_id === 'string' ? parsed.checkpoint_id : null;
      } catch {
        checkpointId = null;
      }
    }
  }
  return {
    required,
    available: checkpointId !== null,
    restore_command: checkpointId ? 'babel undo' : null,
    inspect_command: runDir ? `babel checkpoint list --run "${runDir}"` : null,
  };
}

export function buildSmallFixLitePayload(
  result: SmallFixCompleted,
  context: {
    verb: LiteVerb;
    task: string;
    project?: string;
    projectRoot?: string;
    routeDecision?: LiteFullRouteDecision;
    progressSteps?: string[];
  },
): LiteResultPayload {
  const sessionLoopSteps = result.sessionLoopSteps ?? [];
  const selectedLane =
    context.routeDecision !== undefined ? context.routeDecision.selected_lane : 'small_fix';
  const successStatus = context.verb === 'do' ? 'DO_COMPLETE' : 'FIX_COMPLETE';
  const status = result.status === 'SMALL_FIX_COMPLETE' ? successStatus : 'SMALL_FIX_FAILED';
  const changedFiles = result.changedFiles;
  const costLedgerPath =
    result.runDir && existsSync(join(result.runDir, 'cost_ledger.json'))
      ? join(result.runDir, 'cost_ledger.json')
      : null;
  const verificationStatus =
    changedFiles.length > 0 && result.status === 'SMALL_FIX_COMPLETE'
      ? 'passed'
      : changedFiles.length === 0 && result.status === 'SMALL_FIX_COMPLETE'
        ? 'not_required'
        : 'failed';
  const schemaRetry = getSchemaRetrySummary(result.runDir);
  return {
    status,
    user_status: result.status === 'SMALL_FIX_COMPLETE' ? 'success' : 'failed',
    internal_status: result.status,
    command: context.verb,
    lite_command: context.verb,
    selected_lane: selectedLane,
    execution_path: sessionLoopSteps.length > 0 ? 'session_loop' : 'small_fix',
    ...(result.executionMode !== undefined ? { execution_mode: result.executionMode } : {}),
    task: context.task,
    project: context.project ?? result.project,
    run_dir: result.runDir,
    scope: {
      project_root: context.projectRoot ?? null,
      allowed_write_paths: context.projectRoot ? [context.projectRoot] : [],
      refused_paths: [],
    },
    changed_files: changedFiles,
    verification: {
      status: verificationStatus,
      commands: result.checks,
      skipped_reason:
        verificationStatus === 'failed' ? 'small-fix verification did not pass' : null,
    },
    checkpoint: getSmallFixCheckpointPayload(result.runDir, changedFiles),
    evidence: {
      run_dir: result.runDir,
      support_path: result.runDir,
      artifacts: [
        join(result.runDir, 'terminal_status_summary.json'),
        join(result.runDir, '04_execution_report.json'),
        join(result.runDir, 'small_fix_answer.json'),
        join(result.runDir, 'small_fix_scope.json'),
        join(result.runDir, 'small_fix_scope_before.json'),
        join(result.runDir, 'small_fix_checkpoint.json'),
        join(result.runDir, 'changes.diff'),
        join(result.runDir, 'small_fix_verifier_stdout.log'),
        join(result.runDir, 'small_fix_verifier_stderr.log'),
        join(result.runDir, 'cost_ledger.json'),
        ...(result.status === 'SMALL_FIX_FAILED'
          ? [join(result.runDir, 'small_fix_failure_capsule.json')]
          : []),
      ],
    },
    checks: result.checks,
    tests_or_checks: result.checks,
    answer: {
      summary: result.summary,
      facts: [],
      assumptions: [],
      read_only_steps: [],
    },
    ...(context.progressSteps !== undefined && context.progressSteps.length > 0
      ? { progress_steps: context.progressSteps }
      : {}),
    ...(sessionLoopSteps.length > 0 ? { session_loop_steps: sessionLoopSteps } : {}),
    usage: {
      ...result.usageSummary,
      cost_ledger_path: costLedgerPath,
    },
    ...schemaRetry,
    next:
      result.status === 'SMALL_FIX_COMPLETE'
        ? ['Review the changed file.', 'Rollback: babel undo']
        : result.checks.some((check) => check === 'rollback_on_fail: restored checkpoint')
          ? [
              'Verifier failed; checkpoint auto-restored.',
              'Adjust the task and retry babel "<task>".',
            ]
          : ['Inspect the verifier output.', 'babel undo', 'babel continue latest'],
    support_path: result.runDir,
    scope_path: result.scopePath,
    ...(result.status === 'SMALL_FIX_FAILED'
      ? {
          retryable: true,
          failure_capsule_path: join(result.runDir, 'small_fix_failure_capsule.json'),
          execution_report_path: join(result.runDir, '04_execution_report.json'),
          next_command: 'babel continue latest',
        }
      : {}),
    details: {
      support_path: result.runDir,
      full_babel_equivalent: `babel run "${context.task.replace(/"/g, '\\"')}" --mode deep`,
    },
    ...(context.routeDecision !== undefined
      ? {
          route_reason: context.routeDecision.route_reason,
          complexity: context.routeDecision.complexity,
          risk_signals: context.routeDecision.risk_signals,
          model_tier_recommendation: context.routeDecision.model_tier_recommendation,
          full_babel_equivalent: context.routeDecision.full_babel_equivalent,
        }
      : {}),
  };
}

// ─── Live Sub-Agent Types (Gap 7) ──────────────────────────────────────────

export interface LiveSubagentSpec {
  id: string;
  task: string;
  writeScope: string[];
  role?: string;
  maxRounds?: number;
  /** Model backend key override (e.g. "deepseek-v4-pro", "scout").
   *  When omitted, uses the default model. */
  model?: string;
  /** Custom instructions injected into the sub-agent's system prompt. */
  instructions?: string;
}

export interface LiveSubagentResult {
  agentId: string;
  success: boolean;
  summary: string;
  changedFiles: Array<{
    path: string;
    before_hash: string | null;
    after_hash: string;
    bytes: number;
  }>;
  stepsExecuted: number;
  error: string | null;
  rollback(): Promise<any>;
}

export class AgentSession {
  public readonly deniedFingerprints = new Map<string, { count: number; turn: number }>();

  constructor(private readonly options: AgentSessionOptions) {
    this.loadSessionState();
  }

  private loadSessionState(): void {
    const dir = this.options.workerChainSessionDir;
    if (dir && existsSync(join(dir, 'session_state.json'))) {
      try {
        const statePath = join(dir, 'session_state.json');
        const data = JSON.parse(readFileSync(statePath, 'utf8'));
        if (data && Array.isArray(data.deniedFingerprints)) {
          for (const entry of data.deniedFingerprints) {
            this.deniedFingerprints.set(entry.fingerprint, {
              count: entry.count,
              turn: entry.turn,
            });
          }
        }
      } catch (err) {
        // ignore
      }
    }
  }

  async serializeSessionState(runDir: string): Promise<void> {
    const sessionStatePath = join(runDir, 'session_state.json');
    const tempPath = sessionStatePath + '.tmp';
    const data = {
      deniedFingerprints: Array.from(this.deniedFingerprints.entries()).map(([fp, val]) => ({
        fingerprint: fp,
        count: val.count,
        turn: val.turn,
      })),
    };
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
      await fsPromises.rename(tempPath, sessionStatePath);
    } catch (err) {
      // ignore
    }
  }

  private async withProjectRootEnv<T>(fn: () => Promise<T>): Promise<T> {
    if (this.options.projectRoot === undefined) {
      return fn();
    }
    const previous = process.env['BABEL_PROJECT_ROOT'];
    process.env['BABEL_PROJECT_ROOT'] = this.options.projectRoot;
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env['BABEL_PROJECT_ROOT'];
      } else {
        process.env['BABEL_PROJECT_ROOT'] = previous;
      }
    }
  }

  private laneContext() {
    return {
      task: this.options.task,
      ...(this.options.project !== undefined ? { project: this.options.project } : {}),
      ...(this.options.projectRoot !== undefined ? { projectRoot: this.options.projectRoot } : {}),
      ...(this.options.workspaceRoot !== undefined
        ? { workspaceRoot: this.options.workspaceRoot }
        : {}),
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(this.options.modelTier !== undefined ? { modelTier: this.options.modelTier } : {}),
      ...(this.options.allowExpensive === true ? { allowExpensive: true } : {}),
      ...(this.options.showModelPolicy === true ? { showModelPolicy: true } : {}),
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      ...(this.options.routeDecision !== undefined
        ? { routeDecision: this.options.routeDecision }
        : {}),
      ...(this.options.sparkSynthesis !== undefined
        ? { sparkSynthesis: this.options.sparkSynthesis }
        : {}),
      ...(this.options.sparkReview !== undefined ? { sparkReview: this.options.sparkReview } : {}),
      ...(this.options.toolStream !== undefined ? { toolStream: this.options.toolStream } : {}),
      ...(this.options.planReview === true ? { planReview: true } : {}),
    };
  }

  async run(): Promise<AgentSessionResult> {
    return this.withProjectRootEnv(async () => this.runDispatch());
  }

  private async runDispatch(): Promise<AgentSessionResult> {
    // Reset circuit-breakers at the start of each new dispatch so a fresh
    // session is never immediately terminated by a prior session's blocks.
    resetCircuitBreaker();
    resetCompactionCircuitBreaker();

    // Ensure resolveToolBudget is exercised so the executionProfiles plumbing is validated.
    // DEFAULT_TOOL_BUDGET is the effective fallback in executeActionWithPolicy for now.
    void resolveToolBudget(
      this.options.executionProfile ?? executionProfileForPreset(presetForVerb(this.options.verb)),
    );

    const verb = this.options.verb;
    if (this.options.workerChain === true) {
      return this.runWorkerLoop();
    }
    if (verb === 'do') {
      return this.runRouted();
    }
    if (verb === 'ask') {
      if (this.options.systemContext) return this.runChat();
      return this.runAsk();
    }
    if (verb === 'plan') return this.runPlan();
    if (verb === 'report') return this.runReport();
    if (isProposalVerb(verb)) return this.runProposal(verb);
    if (verb === 'fix') return this.runFix();
    if (verb === 'review') return this.runReview();
    if (verb === 'undo') return this.runUndo();
    throw new Error(`Unsupported Lite session verb: ${verb}`);
  }

  /**
   * CLI ask mode — single LLM call with structured JSON output.
   * Chat mode routes through {@link runChat} instead (multi-turn ChatEngine).
   */
  async runAsk(): Promise<AgentSessionResult> {
    let onChunk: ((chunk: string) => void) | undefined;
    const streamedAnswerChunks: string[] = [];
    if (this.options.stream) {
      // Extract "answer" field from JSON stream chunks for CLI output
      const extractor = new StreamedAnswerExtractor((answerChunk) => {
        streamedAnswerChunks.push(answerChunk);
      });
      onChunk = (chunk) => {
        extractor.feedText(chunk);
      };
    }

    const askResult = await runAskAnswerFastPath({
      task: this.options.task,
      ...(this.options.project !== undefined ? { project: this.options.project } : {}),
      ...(this.options.projectRoot !== undefined ? { projectRoot: this.options.projectRoot } : {}),
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(this.options.modelTier !== undefined ? { modelTier: this.options.modelTier } : {}),
      ...(this.options.allowExpensive === true ? { allowExpensive: true } : {}),
      ...(this.options.showModelPolicy === true ? { showModelPolicy: true } : {}),
      ...(onChunk ? { onChunk } : {}),
      ...(this.options.stream
        ? {
            onStreamReset: () => {
              streamedAnswerChunks.length = 0;
            },
          }
        : {}),
    });

    if (this.options.stream) {
      const streamedAnswer = streamedAnswerChunks.join('');
      process.stdout.write(
        streamedAnswer.trim().length > 0 ? streamedAnswer : askResult.answer.answer,
      );
      process.stdout.write('\n');
    }

    const payload = buildAskResultPayload({
      answer: askResult.answer,
      task: this.options.task,
      ...(this.options.project !== undefined ? { project: this.options.project } : {}),
      runDir: askResult.runDir,
      ...(this.options.projectRoot !== undefined ? { projectRoot: this.options.projectRoot } : {}),
      usageSummary: askResult.usageSummary,
      sessionLoopSteps: askResult.sessionLoopSteps,
      lite: true,
    });
    return {
      payload: payload as unknown as LiteResultPayload,
      exitCode: askResult.status === 'NEEDS_MORE_CONTEXT' ? 1 : 0,
      humanText: formatAskResultHuman(payload),
    };
  }

  /**
   * Chat mode ask — unified conversational agent loop via ChatEngine.
   *
   * Replaces the single-call fast path (runAskAnswerFastPath) with a persistent
   * multi-turn ChatEngine that can use tools, spawn sub-agents, and stream
   * answers through the ConversationalRenderer. Invoked when systemContext is
   * present (chat mode with project identity loaded).
   */
  async runChat(): Promise<AgentSessionResult> {
    const engine = new ChatEngine({
      task: this.options.task,
      projectRoot: this.options.projectRoot ?? process.cwd(),
      ...(this.options.systemContext ? { systemContext: this.options.systemContext } : {}),
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(this.options.modelTier !== undefined ? { modelTier: this.options.modelTier } : {}),
      ...(this.options.allowExpensive === true ? { allowExpensive: true } : {}),
      ...(this.options.workspaceRoot !== undefined && this.options.workspaceRoot !== null
        ? { workspaceRoot: this.options.workspaceRoot }
        : {}),
    });

    const callbacks: ChatCallbacks = {
      ...(this.options.onAnswerChunk ? { onAnswerChunk: this.options.onAnswerChunk } : {}),
      ...(this.options.onToolStart ? { onToolStart: this.options.onToolStart } : {}),
      ...(this.options.onToolComplete ? { onToolComplete: this.options.onToolComplete } : {}),
      ...(this.options.onFileChanged ? { onFileChanged: this.options.onFileChanged } : {}),
      ...(this.options.onThought ? { onThought: this.options.onThought } : {}),
    };

    const result = await engine.submitMessage(this.options.task, callbacks);

    const payload = buildAskResultPayload({
      answer: {
        schema_version: 1 as const,
        status:
          result.status === 'completed'
            ? ('ANSWER_READY' as const)
            : ('NEEDS_MORE_CONTEXT' as const),
        summary: '',
        answer: result.answer,
        facts: [],
        assumptions: [],
        evidence: [],
        next: [],
      },
      task: this.options.task,
      ...(this.options.project !== undefined ? { project: this.options.project } : {}),
      ...(this.options.projectRoot !== undefined ? { projectRoot: this.options.projectRoot } : {}),
      usageSummary: result.usage,
      sessionLoopSteps: [],
      lite: true,
    });

    return {
      payload: payload as unknown as LiteResultPayload,
      exitCode: result.status === 'completed' ? 0 : 1,
      humanText: result.answer,
    };
  }

  async runPlan(): Promise<AgentSessionResult> {
    const result = await runPlanLane(this.laneContext());
    return {
      payload: result.payload,
      exitCode: result.exitCode,
      humanText: result.humanText,
    };
  }

  async runReport(): Promise<AgentSessionResult> {
    const result = await runReportLane(this.laneContext());
    return {
      payload: result.payload,
      exitCode: result.exitCode,
      humanText: result.humanText,
    };
  }

  async runProposal(verb: 'propose' | 'diff' | 'patch'): Promise<AgentSessionResult> {
    const result = await runProposalLane(this.laneContext(), verb);
    return {
      payload: result.payload,
      exitCode: result.exitCode,
      humanText: result.humanText,
    };
  }

  async runFix(): Promise<AgentSessionResult> {
    const fixProvider = createLiteProviderAdapter().resolveFixProvider({
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
    });
    const smallFix = await runSmallFixPath({
      task: this.options.task,
      ...(this.options.project !== undefined ? { project: this.options.project } : {}),
      ...(this.options.projectRoot !== undefined ? { projectRoot: this.options.projectRoot } : {}),
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(this.options.modelTier !== undefined ? { modelTier: this.options.modelTier } : {}),
      ...(this.options.allowExpensive === true ? { allowExpensive: true } : {}),
      ...(this.options.showModelPolicy === true ? { showModelPolicy: true } : {}),
      provider: fixProvider,
      ...(this.options.rollbackOnFail === true ? { rollbackOnFail: true } : {}),
      ...(this.options.sparkSynthesis !== undefined
        ? { sparkSynthesis: this.options.sparkSynthesis }
        : {}),
      ...(this.options.progress !== undefined ? { progress: this.options.progress } : {}),
      ...(this.options.toolStream !== undefined ? { toolStream: this.options.toolStream } : {}),
    });
    if (smallFix.status !== 'SMALL_FIX_NOT_APPLICABLE') {
      const payload = buildSmallFixLitePayload(smallFix, {
        verb: 'fix',
        task: this.options.task,
        ...(this.options.project !== undefined ? { project: this.options.project } : {}),
        ...(this.options.projectRoot !== undefined
          ? { projectRoot: this.options.projectRoot }
          : {}),
        ...(this.options.routeDecision !== undefined
          ? { routeDecision: this.options.routeDecision }
          : {}),
        ...(this.options.progress !== undefined
          ? { progressSteps: this.options.progress.getProgressSteps() }
          : {}),
      });
      return {
        payload,
        exitCode: smallFix.status === 'SMALL_FIX_COMPLETE' ? 0 : 1,
        humanText: formatLiteResultHuman(payload),
      };
    }

    if (this.options.liteOnly === true) {
      const payload = {
        status: 'SMALL_FIX_NOT_APPLICABLE',
        command: this.options.verb,
        lite_command: this.options.verb,
        user_status: 'blocked',
        task: this.options.task,
        reason: smallFix.reason,
        route_reason: 'Lite-only mode refused Full pipeline escalation for an unscoped fix task.',
        next: [
          'Name the target file and verifier command explicitly (for example: Only edit src/math.js. Run npm test before completing.).',
          'Or run without --lite-only to allow governed Full escalation.',
        ],
        ...(this.options.routeDecision !== undefined
          ? {
              selected_lane: this.options.routeDecision.selected_lane,
            }
          : {}),
      };
      return {
        payload: payload as unknown as LiteResultPayload,
        exitCode: 1,
        humanText: formatLiteResultHuman(payload as unknown as LiteResultPayload),
      };
    }

    const executionProfile =
      this.options.executionProfile ?? executionProfileForPreset(presetForVerb('fix'));
    const result = await runBabelPipeline(buildLiteTask('fix', this.options.task), {
      ...(this.options.project !== undefined ? { project: this.options.project } : {}),
      ...(this.options.model !== undefined ? { modelOverride: this.options.model } : {}),
      ...(this.options.modelTier !== undefined ? { modelTier: this.options.modelTier } : {}),
      ...(this.options.allowExpensive === true ? { allowExpensive: true } : {}),
      ...(this.options.showModelPolicy === true ? { showModelPolicy: true } : {}),
      mode: resolveLitePipelineMode('fix'),
      executionProfile,
      deniedFingerprints: this.deniedFingerprints,
    });
    await this.serializeSessionState(result.runDir);
    const payload = buildLiteResultPayload(result, {
      verb: 'fix',
      task: this.options.task,
      mode: resolveLitePipelineMode('fix'),
      ...(this.options.project !== undefined ? { project: this.options.project } : {}),
      ...(this.options.projectRoot !== undefined ? { projectRoot: this.options.projectRoot } : {}),
      ...(this.options.model !== undefined ? { requestedModel: this.options.model } : {}),
      ...(this.options.modelTier !== undefined
        ? { requestedModelTier: this.options.modelTier }
        : {}),
      orchestrator: process.env['BABEL_ORCHESTRATOR_VERSION'] ?? 'v9',
      ...(this.options.routeDecision !== undefined
        ? { routeDecision: this.options.routeDecision }
        : {}),
    });
    return {
      payload,
      exitCode: isSuccessfulRunStatus(result.status) ? 0 : 1,
      humanText: formatLiteResultHuman(payload),
    };
  }

  async runReview(): Promise<AgentSessionResult> {
    const result = await runReviewLane(this.laneContext());
    return {
      payload: result.payload,
      exitCode: result.exitCode,
      humanText: result.humanText,
    };
  }

  runUndo(): AgentSessionResult {
    const result = runUndoLane(this.laneContext());
    return {
      payload: result.payload,
      exitCode: result.exitCode,
      humanText: result.humanText,
    };
  }

  private childSessionOptions(verb: LiteSessionVerb): AgentSessionOptions {
    return {
      ...this.options,
      verb,
      workerChain: false,
    };
  }

  private workerLoopVerbs(): LiteSessionVerb[] {
    return [...WORKER_CHAIN_VERBS];
  }

  private beginWorkerChainSession(): { sessionRunDir: string; manifest: WorkerChainManifest } {
    const repoPath = this.options.projectRoot ?? process.cwd();
    const sessionRun = beginLiteArtifactRun({ command: 'do', repoPath });
    writeLiteRequest(sessionRun, {
      schema_version: 1,
      command: 'do',
      task: this.options.task,
      project: this.options.project ?? null,
      project_root: repoPath,
      worker_chain: true,
    });
    const manifest: WorkerChainManifest = {
      schema_version: 1,
      artifact_type: 'babel_lite_worker_chain',
      session_run_id: sessionRun.runId,
      session_run_dir: sessionRun.runDir,
      task: this.options.task,
      project: this.options.project ?? null,
      project_root: repoPath,
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      chain_status: 'in_progress',
      steps: [],
      next_verb: WORKER_CHAIN_VERBS[0] ?? null,
      updated_at: new Date().toISOString(),
    };
    writeLiteManifest(sessionRun, {
      schema_version: 1,
      command: 'do',
      status: 'WORKER_LOOP_IN_PROGRESS',
      run_id: sessionRun.runId,
      task: this.options.task,
      mutation_policy: 'worker_chain',
    });
    writeWorkerChainManifest(sessionRun.runDir, manifest);
    return { sessionRunDir: sessionRun.runDir, manifest };
  }

  private updateWorkerChainManifest(
    sessionRunDir: string,
    manifest: WorkerChainManifest,
    step: AgentWorkerLoopStep,
    failed: boolean,
  ): WorkerChainManifest {
    const updatedSteps = [
      ...manifest.steps.filter((existing) => existing.verb !== step.verb),
      step,
    ];
    const nextIndex = WORKER_CHAIN_VERBS.indexOf(step.verb) + 1;
    const nextVerb = failed
      ? step.verb
      : nextIndex < WORKER_CHAIN_VERBS.length
        ? (WORKER_CHAIN_VERBS[nextIndex] ?? null)
        : null;
    const updated: WorkerChainManifest = {
      ...manifest,
      steps: updatedSteps,
      chain_status: failed ? 'failed' : nextVerb === null ? 'complete' : 'in_progress',
      next_verb: failed ? step.verb : nextVerb,
      ...(failed ? { failed_step: step.verb } : {}),
      updated_at: new Date().toISOString(),
    };
    if (!failed && updated.failed_step !== undefined) {
      delete updated.failed_step;
    }
    writeWorkerChainManifest(sessionRunDir, updated);
    return updated;
  }

  private stepFromResult(verb: LiteSessionVerb, result: AgentSessionResult): AgentWorkerLoopStep {
    const payload = result.payload as Record<string, unknown>;
    return {
      verb,
      status: typeof payload['status'] === 'string' ? payload['status'] : 'UNKNOWN',
      exit_code: result.exitCode,
      ...(typeof payload['execution_mode'] === 'string'
        ? { execution_mode: payload['execution_mode'] }
        : {}),
      run_dir: typeof payload['run_dir'] === 'string' ? payload['run_dir'] : null,
    };
  }

  /**
   * Multi-turn worker loop: plan → propose → fix with shared session context.
   */
  async runWorkerLoop(): Promise<AgentSessionResult> {
    const steps: AgentWorkerLoopStep[] = [];
    const { sessionRunDir, manifest: initialManifest } = this.beginWorkerChainSession();
    let manifest = initialManifest;
    const adapter = createLiteProviderAdapter();
    const resolved = adapter.resolve({
      ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
    });
    const offlineEnvSnapshot = snapshotLiteOfflineEnv();
    if (resolved.offlineDemo) {
      applyLiteOfflineEnv(resolved.fixProvider);
    }

    try {
      for (const stepVerb of this.workerLoopVerbs()) {
        const child = new AgentSession({
          ...this.childSessionOptions(stepVerb),
          workerChainSessionDir: sessionRunDir,
        });
        const result = await child.run();
        const step = this.stepFromResult(stepVerb, result);
        steps.push(step);
        manifest = this.updateWorkerChainManifest(
          sessionRunDir,
          manifest,
          step,
          result.exitCode !== 0,
        );
        if (result.exitCode !== 0) {
          const payload: AgentWorkerLoopPayload = {
            status: 'WORKER_LOOP_FAILED',
            user_status: 'failed',
            command: 'do',
            lite_command: 'do',
            execution_path: 'worker_loop',
            ...(resolved.offlineDemo
              ? { execution_mode: 'offline_demo' as const }
              : { execution_mode: 'live' as const }),
            task: this.options.task,
            ...(this.options.project !== undefined ? { project: this.options.project } : {}),
            steps,
            failed_step: stepVerb,
            next: [
              `Inspect the ${stepVerb} lane artifacts.`,
              'Run babel continue latest to resume the linked worker chain.',
            ],
          };
          return {
            payload: {
              ...(payload as unknown as LiteResultPayload),
              session_run_dir: sessionRunDir,
              worker_chain: manifest,
            } as unknown as LiteResultPayload,
            exitCode: 1,
            humanText: [
              'Babel Lite worker loop failed',
              `Failed step: ${stepVerb}`,
              `Status: ${steps.at(-1)?.status ?? 'UNKNOWN'}`,
              `Session: ${sessionRunDir}`,
            ].join('\n'),
          };
        }
      }

      const payload: AgentWorkerLoopPayload = {
        status: 'WORKER_LOOP_COMPLETE',
        user_status: 'success',
        command: 'do',
        lite_command: 'do',
        execution_path: 'worker_loop',
        ...(resolved.offlineDemo
          ? { execution_mode: 'offline_demo' as const }
          : { execution_mode: 'live' as const }),
        task: this.options.task,
        ...(this.options.project !== undefined ? { project: this.options.project } : {}),
        steps,
        next: [
          'Worker loop complete: plan, propose, and fix succeeded.',
          'Re-run babel "<task>" for additional edits.',
        ],
      };
      return {
        payload: {
          ...(payload as unknown as LiteResultPayload),
          session_run_dir: sessionRunDir,
          worker_chain: manifest,
        } as unknown as LiteResultPayload,
        exitCode: 0,
        humanText: [
          'Babel Lite worker loop complete',
          `Steps: ${steps.map((step) => step.verb).join(' → ')}`,
          `Session: ${sessionRunDir}`,
          ...(resolved.offlineDemo ? ['Execution mode: offline_demo'] : []),
        ].join('\n'),
      };
    } finally {
      restoreLiteOfflineEnv(offlineEnvSnapshot);
    }
  }

  private mergeDoPayloadWithSpark(
    childResult: AgentSessionResult,
    routeDecision: LiteFullRouteDecision,
    sparkReview: SparkParallelReviewResult | null,
    effectiveVerb: string,
  ): AgentSessionResult {
    const payload = {
      ...childResult.payload,
      command: 'do',
      lite_command: 'do',
      selected_lane: effectiveVerb,
      route_reason: routeDecision.route_reason,
      complexity: routeDecision.complexity,
      risk_signals: routeDecision.risk_signals,
      model_tier_recommendation: routeDecision.model_tier_recommendation,
      full_babel_equivalent: routeDecision.full_babel_equivalent,
      execution_path: sparkReview ? 'spark_parallel_review_do' : 'routed_do',
      ...(sparkReview
        ? {
            spark_agents: sparkReview.spark_agents,
            spark_synthesis: sparkReview.synthesis,
            spark_run_dir: sparkReview.run_dir,
            spark_synthesis_path: sparkReview.synthesis_path,
            mutation_subagents: {
              enabled: false as const,
              reason:
                'Read-only Spark reviewers synthesized evidence only; lead lane owns mutation.',
            },
          }
        : {}),
    };
    const sparkLines = sparkReview
      ? [
          `Spark reviewers: ${sparkReview.spark_agents.length} read-only evidence file(s)`,
          `Synthesis: ${sparkReview.synthesis_path}`,
        ]
      : [];
    return {
      payload,
      exitCode: childResult.exitCode,
      humanText: [childResult.humanText ?? '', ...sparkLines].filter(Boolean).join('\n'),
    };
  }

  async runRouted(): Promise<AgentSessionResult> {
    const routeDecision =
      this.options.routeDecision ??
      routeLiteOrFull(this.options.task, {
        requestedVerb: 'do',
        forceLiteOnly: this.options.liteOnly === true,
        dailyProfile: resolveDailyProfile(),
      });
    const agentsMode: LiteFullAgentsMode = this.options.agentsMode ?? 'read-only';
    const spawnSpark = shouldSpawnSparkReview(routeDecision, {
      requestedVerb: 'do',
      agentsMode,
    });
    const sparkReview = spawnSpark
      ? runSparkParallelReview({
          task: this.options.task,
          routeDecision,
          ...(this.options.projectRoot !== undefined
            ? { projectRoot: this.options.projectRoot }
            : {}),
        })
      : null;

    if (routeDecision.selected_lane === 'deep_lane') {
      if (this.options.liteOnly === true) {
        return {
          payload: {
            status: 'FULL_ROUTE_REFUSED',
            selected_lane: routeDecision.selected_lane,
            route_reason: routeDecision.route_reason,
            task: this.options.task,
          },
          exitCode: 1,
        };
      }

      const effectiveVerb = inferDoExecutionVerb(this.options.task);
      const child = new AgentSession({
        ...this.options,
        verb: effectiveVerb,
        routeDecision,
        ...(sparkReview ? { sparkSynthesis: sparkReview.synthesis, sparkReview } : {}),
      });
      const childResult = await child.run();
      return this.mergeDoPayloadWithSpark(childResult, routeDecision, sparkReview, effectiveVerb);
    }

    const effectiveVerb = liteVerbForSelectedLane(routeDecision.selected_lane);
    const child = new AgentSession({
      ...this.options,
      verb: effectiveVerb,
      routeDecision,
      ...(sparkReview ? { sparkSynthesis: sparkReview.synthesis, sparkReview } : {}),
    });

    const childResult = await child.run();
    if (this.options.verb === 'do') {
      return this.mergeDoPayloadWithSpark(
        childResult,
        routeDecision,
        sparkReview,
        routeDecision.selected_lane.replace('lite_', ''),
      );
    }
    return childResult;
  }

  async runLiveSubagents(
    specs: LiveSubagentSpec[],
  ): Promise<{
    results: LiveSubagentResult[];
    mergeReport: {
      changedFiles: string[];
      conflicts: string[];
      rollbackAvailable: boolean;
    };
  }> {
    const projectRoot = this.options.projectRoot ?? process.cwd();
    const totalAgents = specs.length;

    // Register background task for the entire team
    const teamTaskId = backgroundTaskRegistry.register(
      `Live sub-agent team: ${totalAgents} agent(s)`,
    );
    backgroundTaskRegistry.updateProgress(teamTaskId, 0, totalAgents);

    // Run all sub-agents concurrently
    const settled = await Promise.allSettled(
      specs.map(async (spec, index) => {
        const taskLabel = `Live sub-agent ${spec.id}: ${spec.task.slice(0, 60)}`;
        const subTaskId = backgroundTaskRegistry.register(taskLabel);

        try {
          const result = await runMutationAgentLoop({
            agentId: spec.id,
            task: spec.task,
            projectRoot,
            writeScope: spec.writeScope,
            toolContext: {
              agentId: spec.id,
              runId: `live-${Date.now()}`,
              runDir: join(projectRoot, '.babel', 'runs', 'agents', spec.id),
              babelRoot: process.env['BABEL_ROOT'] ?? projectRoot,
            },
            maxRounds: spec.maxRounds ?? 8,
          });

          backgroundTaskRegistry.updateProgress(teamTaskId, index + 1, totalAgents);

          if (result.success) {
            backgroundTaskRegistry.complete(subTaskId);
          } else {
            backgroundTaskRegistry.fail(subTaskId, result.error ?? 'Unknown error');
          }

          const liveResult: LiveSubagentResult = {
            agentId: spec.id,
            success: result.success,
            summary: result.summary,
            changedFiles: result.changedFiles.map((f) => ({
              path: f.path,
              before_hash: f.before_hash,
              after_hash: f.after_hash,
              bytes: f.bytes,
            })),
            stepsExecuted: result.stepsExecuted,
            error: result.error,
            rollback: () => result.rollback(),
          };

          return liveResult;
        } catch (err) {
          backgroundTaskRegistry.fail(subTaskId, err instanceof Error ? err.message : String(err));
          backgroundTaskRegistry.updateProgress(teamTaskId, index + 1, totalAgents);

          const failedResult: LiveSubagentResult = {
            agentId: spec.id,
            success: false,
            summary: `Sub-agent ${spec.id} threw an exception`,
            changedFiles: [],
            stepsExecuted: 0,
            error: err instanceof Error ? err.message : String(err),
            rollback: async () => {},
          };
          return failedResult;
        }
      }),
    );

    backgroundTaskRegistry.complete(teamTaskId);

    // Collect results
    const results: LiveSubagentResult[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results.push(s.value);
      }
    }

    // Detect conflicts across agents
    const fileOwner = new Map<string, string>();
    const conflicts: string[] = [];
    const changedFiles: string[] = [];

    for (const result of results) {
      for (const change of result.changedFiles) {
        const prior = fileOwner.get(change.path);
        if (prior && prior !== result.agentId) {
          conflicts.push(
            `File "${change.path}" modified by both "${prior}" and "${result.agentId}"`,
          );
        }
        fileOwner.set(change.path, result.agentId);
        if (!changedFiles.includes(change.path)) {
          changedFiles.push(change.path);
        }
      }
    }

    const rollbackAvailable = results.some((r) => r.changedFiles.length > 0);

    return {
      results,
      mergeReport: {
        changedFiles,
        conflicts,
        rollbackAvailable,
      },
    };
  }
}
