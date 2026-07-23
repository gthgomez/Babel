// ─── Chat Core ──────────────────────────────────────────────────────────────
// Shared chat execution primitives used by REPL (executeChatTask) and CLI
// one-shot paths. Dependency-injectable for integration tests.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentTargetContext } from '../../services/targetResolver.js';
import { resolveAgentTarget } from '../../services/targetResolver.js';
import {
  ChatEngine,
  type ChatCallbacks,
  type ChatEngineOptions,
  type ChatEvent,
  type ChatResult,
  type TaskIntent,
} from '../../agent/chatEngine.js';
import type { SessionUsageSummary } from '../../services/costTracker.js';
import type { BlockedReport } from '../../schemas/agentContracts.js';
import { ConversationalRenderer } from '../../ui/waterfall.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { BABEL_RUNS_DIR } from '../../cli/constants.js';
import { getProtocolClient } from '../../protocol/client/index.js';
import {
  dispatchChatEvent,
  terminalResultFromDoneEvent,
  type ChatStreamEvent,
} from './chatEventDispatch.js';
import {
  finalizeProtocolTurn,
  getEngineThreadId,
  prepareHeadlessTurn,
  prepareRendererTurn,
  type ProtocolTurnSession,
} from './chatTransport.js';
import type { TurnPersistence } from './turnPersistence.js';
import { buildAskResultPayload } from '../../cli/structuredOutput.js';
import { runGitCommandAsync } from '../../utils/gitExec.js';
import { loadProjectSessionIdentity } from '../identity.js';
import { isChatStreamingEnabled, resolveChatEngineLimits } from '../../config/chatEngineLimits.js';
import { resolveChatTaskClass } from '../../config/chatTaskClass.js';
import { isSuccessfulDirectMutation } from '../../agent/mutationTools.js';
import { computeToolCallAggregates } from '../../agent/toolCallExport.js';
import {
  buildInteractiveFirstMoveHint,
  computeToolsBeforeFirstWrite,
} from '../../agent/firstMoveCard.js';
import {
  countPhaseGateWriteBlocks,
  resolveImplementorHarnessFields,
} from '../../agent/implementorPolicy.js';
import {
  buildPreLoopPlanningInstruction,
  compileIntentPlan,
  formatIntentPlanUserMessage,
} from '../../agent/intentCompiler.js';
import { persistIntentPlan } from '../../agent/chatEngineObservability.js';
import {
  compileChatStack,
  resolveStackBudgetForClass,
  type ChatCompiledStack,
} from '../../agent/chatStackCompile.js';

export type { ChatStreamEvent };
export type ChatEngineFactory = (opts: ChatEngineOptions) => ChatEngine;

/** Last compiled chat stack (for tests / telemetry). */
let _lastChatCompiledStack: ChatCompiledStack | null = null;

export function getLastChatCompiledStack(): ChatCompiledStack | null {
  return _lastChatCompiledStack;
}

/** Compile and attach the smallest chat instruction stack (P2-A). */
export function compileChatStackForRun(input: {
  projectRoot: string;
  task: string;
  model?: string;
  babelRoot?: string;
}): ChatCompiledStack {
  // U1.4: Slim interactive stack — non-general_swe tasks get a lower budget.
  const taskClass = resolveChatTaskClass({ taskText: input.task, autoClassify: true });
  const budget = resolveStackBudgetForClass(taskClass);
  const stack = compileChatStack({
    projectRoot: input.projectRoot,
    task: input.task,
    promptBudgetChars: budget,
    ...(input.model !== undefined ? { modelId: input.model } : {}),
    ...(input.babelRoot !== undefined ? { babelRoot: input.babelRoot } : {}),
  });
  _lastChatCompiledStack = stack;
  return stack;
}

const defaultEngineFactory: ChatEngineFactory = (options) => new ChatEngine(options);

/**
 * Gather lightweight pre-flight context (git branch, dirty files).
 * Returns undefined when not in a git repo or when collection fails.
 */
export async function gatherChatPreflightContext(
  targetRoot: string,
): Promise<string | undefined> {
  try {
    const parts: string[] = [];
    const [branchResult, statusResult] = await Promise.all([
      runGitCommandAsync(['rev-parse', '--abbrev-ref', 'HEAD'], targetRoot, {
        timeoutMs: 2000,
      }),
      runGitCommandAsync(['status', '--short'], targetRoot, { timeoutMs: 2000 }),
    ]);
    if (branchResult.status === 0 && branchResult.stdout.trim()) {
      const raw = branchResult.stdout.trim();
      const safe = raw
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
        .replace(/\n/g, ' ')
        .slice(0, 120);
      parts.push(`- Current branch: ${safe}`);
    }
    if (statusResult.status === 0 && statusResult.stdout.trim()) {
      const lines = statusResult.stdout.trim().split('\n').filter(Boolean);
      parts.push(`- Modified files: ${lines.length}`);
      const diffResult = await runGitCommandAsync(['diff', '--stat'], targetRoot, {
        timeoutMs: 2000,
      });
      if (diffResult.status === 0 && diffResult.stdout.trim()) {
        const statLines = diffResult.stdout.trim().split('\n').filter(Boolean).slice(0, 8);
        parts.push(`- Changes:\n${statLines.join('\n')}`);
      }
    }
    if (parts.length > 0) {
      // Append build/test commands from package.json
      const pkgCmds = collectPackageJsonCommands(targetRoot);
      if (pkgCmds) {
        parts.push(pkgCmds);
      }
      return '## Pre-flight Context\n' + parts.join('\n');
    } else {
      // No git info but we may still have package.json commands
      const pkgCmds = collectPackageJsonCommands(targetRoot);
      if (pkgCmds) {
        return '## Pre-flight Context\n' + pkgCmds;
      }
    }
  } catch (err) {
    console.error(
      '  [chat] Pre-flight git info collection failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return undefined;
}

/**
 * Collect build/test commands from package.json if present.
 * Appended to preflight context to help the model orient.
 */
function collectPackageJsonCommands(targetRoot: string): string | undefined {
  try {
    const pkgPath = path.join(targetRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const parts: string[] = [];
    const scripts = pkg['scripts'] as Record<string, string> | undefined;
    if (scripts) {
      if (scripts['test']) parts.push(`- Test command: npm test`);
      if (scripts['build']) parts.push(`- Build command: npm run build`);
      if (scripts['typecheck']) parts.push(`- TypeCheck: npm run typecheck`);
      if (scripts['lint']) parts.push(`- Lint: npm run lint`);
    }
    if (parts.length > 0) {
      return parts.join('\n');
    }
  } catch {
    // Best-effort — never throw
  }
  return undefined;
}

/**
 * Consume the streaming ChatEvent generator and dispatch each event to sinks.
 */
export async function consumeChatStream(
  stream: AsyncGenerator<ChatEvent, void, undefined>,
  convRenderer: ConversationalRenderer | null,
  onStreamEvent?: (event: ChatStreamEvent) => void,
  protocolSession?: ProtocolTurnSession | null,
): Promise<ChatResult> {
  let answer = '';
  let usage: SessionUsageSummary = globalCostTracker.getSessionSummary();
  let toolCalls: Array<{ tool: string; target: string; detail?: string; error?: string }> | undefined;
  let runDir: string | undefined;
  let verifierReceipt: { command: string; exit_code: number; summary: string } | null | undefined;
  let blockedReport: BlockedReport | null | undefined;
  let criticReceipt: ChatResult['criticReceipt'];
  let verifierTampered: boolean | undefined;
  let turnRouting: ChatResult['turnRouting'];
  const toolIdQueue: number[] = [];
  let receivedTerminalEvent = false;

  try {
    for await (const event of stream) {
      const failed = dispatchChatEvent(event, {
        convRenderer,
        ...(onStreamEvent ? { onStreamEvent } : {}),
        ...(protocolSession ? { protocolSession } : {}),
        toolIdQueue,
      });
      if (failed) return failed;

      if (event.type === 'done') {
        answer = event.answer;
        usage = event.usage;
        toolCalls = event.toolCalls;
        runDir = event.runDir;
        verifierReceipt = event.verifierReceipt;
        blockedReport = event.blockedReport;
        criticReceipt = event.criticReceipt;
        verifierTampered = event.verifierTampered;
        turnRouting = event.turnRouting;
        receivedTerminalEvent = true;
      }
    }
  } catch (err: unknown) {
    return {
      status: 'failed',
      outcome: 'AGENT_FAILURE',
      answer: err instanceof Error ? err.message : String(err),
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
    };
  }

  if (!receivedTerminalEvent) {
    return {
      status: 'cancelled',
      outcome: 'CANCELLED',
      answer: 'Stream ended without a terminal event — possible internal error',
      usage: globalCostTracker.getSessionSummary(),
      conversation: [],
    };
  }

  return terminalResultFromDoneEvent(answer, usage, toolCalls, runDir, verifierReceipt, blockedReport, {
    ...(criticReceipt ? { criticReceipt } : {}),
    ...(verifierTampered ? { verifierTampered: true } : {}),
    ...(turnRouting ? { turnRouting } : {}),
  });
}

function buildChatCallbacks(
  convRenderer: ConversationalRenderer | null,
  onStreamEvent?: (event: ChatStreamEvent) => void,
  protocolSession?: ProtocolTurnSession | null,
): ChatCallbacks {
  const sinks = {
    convRenderer,
    ...(onStreamEvent ? { onStreamEvent } : {}),
    ...(protocolSession ? { protocolSession } : {}),
  };

  /** Track tool metadata so onToolComplete can emit the real tool name and target. */
  const toolMetadata = new Map<number, { tool: string; target: string }>();
  let toolIdCounter = 0;

  return {
    onAnswerChunk: (chunk: string) => {
      dispatchChatEvent({ type: 'answer_chunk', text: chunk }, sinks);
    },
    onToolStart: (tool: string, label: string) => {
      const id = convRenderer?.onToolCallStart(tool, label) ?? ++toolIdCounter;
      toolMetadata.set(id, { tool, target: label });
      protocolSession?.emitChatEvent({ type: 'tool_start', tool, target: label });
      return id;
    },
    onToolComplete: (id: number, detail?: string) => {
      const meta = toolMetadata.get(id);
      protocolSession?.emitChatEvent({
        type: 'tool_complete',
        tool: meta?.tool ?? 'tool',
        target: meta?.target ?? String(id),
        ...(detail !== undefined ? { detail } : {}),
      });
      if (meta) toolMetadata.delete(id);
      convRenderer?.onToolCallComplete(id, detail);
    },
    onFileChanged: (filePath: string, adds: number, dels: number, content?: string) => {
      dispatchChatEvent(
        {
          type: 'file_changed',
          path: filePath,
          additions: adds,
          deletions: dels,
          ...(content !== undefined ? { content } : {}),
        },
        sinks,
      );
    },
    onThought: (thought: string) => {
      dispatchChatEvent({ type: 'thought', text: thought }, sinks);
    },
    onContextCompacted: (info) => {
      dispatchChatEvent(
        {
          type: 'context_compacted',
          mode: info.mode,
          beforeMessages: info.beforeMessages,
          afterMessages: info.afterMessages,
          message: info.message,
        },
        sinks,
      );
    },
    onSubAgentStart: (info) =>
      convRenderer?.onSubAgentStart(info.id, info.label, info.model),
    onSubAgentComplete: (info) =>
      convRenderer?.onSubAgentComplete(info.id, info.summary, info.tokens),
    onSubAgentFailed: (info) =>
      convRenderer?.onSubAgentFailed(info.id, info.error),
  };
}

function persistTurnAssistantCells(
  turnPersistence: TurnPersistence | null,
  convRenderer: ConversationalRenderer | null,
): void {
  if (!turnPersistence || !convRenderer) return;
  turnPersistence.persistAssistantAndToolCells(convRenderer.getCommittedHistoryCells());
}

/**
 * Run one chat turn via ChatEngine (streaming or callback path).
 */
export async function runChatEngineOnce(input: {
  task: string;
  target: AgentTargetContext;
  systemContext?: string;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  appendSystemPrompt?: string;
  preflightContext?: string;
  engine?: ChatEngine;
  engineFactory?: ChatEngineFactory;
  convRenderer?: ConversationalRenderer | null;
  useStreaming?: boolean;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  onCancel?: () => void;
  taskIntent?: TaskIntent;
}): Promise<ChatResult> {
  const factory = input.engineFactory ?? defaultEngineFactory;
  const preflightContext =
    input.preflightContext ?? (await gatherChatPreflightContext(input.target.targetRoot));

  const limits = resolveChatEngineLimits();

  // P2-A: smallest compiled chat stack (identity / project / safety / provider / verifier)
  const chatStack = compileChatStackForRun({
    projectRoot: input.target.targetRoot,
    task: input.task,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });
  const stackSystemContext = [input.systemContext, chatStack.system_context]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('\n\n');

  // C1: Compile intent plan for execute tasks (heuristic, no LLM call).
  // Injects as a structured user message so the model sees expanded intent
  // before its first tool turn. Persisted to intent_plan.json after the run.
  const resolvedTaskClass = resolveChatTaskClass({ taskText: input.task, autoClassify: false });
  const intentPlan = compileIntentPlan(input.task, {
    taskClass: resolvedTaskClass,
  });
  // C1: Format intent plan user message; append first-move hint when
  // the intent plan detected a test command.
  // D5: Append pre-loop planning instruction for execute tasks
  // (controlled by BABEL_CHAT_PRELOOP_PLAN; default on for general_swe/default).
  const intentPlanUserMessage = intentPlan
    ? (() => {
        let msg = formatIntentPlanUserMessage(intentPlan);
        if (intentPlan.test_command) {
          msg += '\n\n' + buildInteractiveFirstMoveHint(intentPlan.test_command);
        }
        // Pre-loop planning: inject "think before tools" instruction.
        // Skip when env is explicitly '0'/'false'/'off', or for investigate tasks.
        const preloopEnv = process.env['BABEL_CHAT_PRELOOP_PLAN'];
        const preloopDisabled =
          preloopEnv !== undefined &&
          (preloopEnv.trim() === '0' || preloopEnv.trim().toLowerCase() === 'false' || preloopEnv.trim().toLowerCase() === 'off');
        const isExecuteClass = resolvedTaskClass !== 'investigate';
        if (isExecuteClass && !preloopDisabled) {
          msg +=
            '\n\n' +
            buildPreLoopPlanningInstruction({
              enforceMutateFirst: resolvedTaskClass === 'general_swe',
            });
        }
        return msg;
      })()
    : undefined;

  const engine =
    input.engine ??
    factory({
      task: input.task,
      projectRoot: input.target.targetRoot,
      ...(stackSystemContext ? { systemContext: stackSystemContext } : {}),
      ...(input.appendSystemPrompt ? { appendSystemPrompt: input.appendSystemPrompt } : {}),
      ...(preflightContext ? { preflightContext } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelTier !== undefined ? { modelTier: input.modelTier } : {}),
      ...(input.allowExpensive === true ? { allowExpensive: true } : {}),
      maxTurns: limits.maxTurns,
      maxConversationMessages: limits.maxConversationMessages,
      maxEstimatedTokens: limits.maxEstimatedTokens,
      workspaceRoot: input.target.workspaceRoot ?? null,
      ...(intentPlanUserMessage ? { intentPlanUserMessage } : {}),
    });

  const convRenderer = input.convRenderer ?? null;
  let protocolSession: ProtocolTurnSession | null = null;
  let turnPersistence: TurnPersistence | null = null;

  if (convRenderer) {
    const turnCtx = await prepareRendererTurn(convRenderer, engine, input.task);
    protocolSession = turnCtx.protocolSession;
    turnPersistence = turnCtx.turnPersistence;
  } else {
    const turnCtx = await prepareHeadlessTurn(engine, input.task);
    protocolSession = turnCtx.protocolSession;
    turnPersistence = turnCtx.turnPersistence;
  }

  const threadId = getEngineThreadId(engine);
  const cancelViaProtocol = () => {
    if (threadId) {
      void getProtocolClient().turnCancel({ thread_id: threadId });
    }
    engine.cancel();
  };

  if (input.onCancel) {
    convRenderer?.setCancelTarget(input.onCancel);
  } else {
    convRenderer?.setCancelTarget(cancelViaProtocol);
  }

  const useStreaming =
    input.useStreaming ??
    (convRenderer !== null ? isChatStreamingEnabled() : true);
  const resolvedIntent = input.taskIntent ?? ChatEngine.classifyChatTaskIntent(input.task);

  let result: ChatResult;
  if (useStreaming) {
    result = await consumeChatStream(
      engine.submitMessageStream(input.task, resolvedIntent),
      convRenderer,
      input.onStreamEvent,
      protocolSession,
    );
  } else {
    result = await engine.submitMessage(
      input.task,
      buildChatCallbacks(convRenderer, input.onStreamEvent, protocolSession),
      resolvedIntent,
    );
    if (result.status === 'completed') {
      protocolSession?.emitChatEvent({
        type: 'done',
        answer: result.answer,
        usage: result.usage,
      });
    } else if (result.status === 'failed') {
      protocolSession?.emitChatEvent({ type: 'failed', error: result.answer });
    }
  }

  if (result.status === 'completed') {
    persistTurnAssistantCells(turnPersistence, convRenderer);
    finalizeProtocolTurn(protocolSession);
  }

  // C1: Persist intent plan to run_dir/intent_plan.json after the run
  if (intentPlan && result.runDir) {
    persistIntentPlan(result.runDir, intentPlan).catch(() => {});
  }

  // P2-A: persist chat stack manifest hash next to the run when possible
  if (result.runDir && chatStack.manifest_hash) {
    try {
      const manifestPath = path.join(result.runDir, 'chat_stack_manifest.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            manifest_hash: chatStack.manifest_hash,
            selected_entries: chatStack.selected_entries.map((e) => ({
              id: e.id,
              layer: e.layer,
              path: e.path,
            })),
            deep_stages_excluded: true,
            estimated_tokens: chatStack.estimated_tokens,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch {
      // best-effort telemetry
    }
  }

  return result;
}

/**
 * Map ChatResult to a `run --mode chat` payload (chat_engine orchestrator).
 */
export function buildChatRunPayload(
  result: ChatResult,
  context: {
    task: string;
    project?: string;
    projectRoot: string;
    workspaceRoot?: string | null;
    model?: string;
    modelTier?: string;
  },
  opts?: { taskIntent?: TaskIntent },
): Record<string, unknown> {
  // P0-D: Map truthful TerminalOutcome to legacy AskAnswer status.
  // Falls back to old heuristics when outcome is absent (test fixtures).
  const answerStatus = (() => {
    const o = result.outcome;
    if (o !== undefined) {
      switch (o) {
        case 'VERIFIED_COMPLETE': return 'ANSWER_READY' as const;
        case 'UNVERIFIED_PATCH': return 'ANSWER_READY' as const;
        case 'BLOCKED_EXTERNAL': return 'BLOCKED' as const;
        case 'BLOCKED_POLICY': return 'BLOCKED' as const;
        case 'BUDGET_EXHAUSTED': return 'BUDGET_EXCEEDED' as const;
        case 'CANCELLED': return 'NEEDS_MORE_CONTEXT' as const;
        case 'INFRA_FAILURE': return 'NEEDS_MORE_CONTEXT' as const;
        case 'AGENT_FAILURE': return 'NEEDS_MORE_CONTEXT' as const;
      }
    }
    // Legacy fallback for test fixtures without outcome
    if (result.status === 'completed') return 'ANSWER_READY' as const;
    if (result.status === 'blocked') return 'BLOCKED' as const;
    if (
      result.budgetExceeded ||
      /\bBUDGET_EXCEEDED\b/i.test(result.answer) ||
      /Time budget exceeded/i.test(result.answer) ||
      /Cost budget exceeded/i.test(result.answer) ||
      /Token explosion with zero mutations/i.test(result.answer)
    ) {
      return 'BUDGET_EXCEEDED' as const;
    }
    return 'NEEDS_MORE_CONTEXT' as const;
  })();

  const isExecute = opts?.taskIntent === 'execute' || opts?.taskIntent === undefined;
  const liteCommand = isExecute ? ('fix' as const) : ('ask' as const);

  const payload = buildAskResultPayload({
    answer: {
      schema_version: 1 as const,
      status: answerStatus,
      summary: result.answer.slice(0, 200),
      answer: result.answer,
      facts: [],
      assumptions: [],
      evidence: [],
      next: [],
    },
    task: context.task,
    ...(context.project !== undefined ? { project: context.project } : {}),
    projectRoot: context.projectRoot,
    usageSummary: result.usage,
    sessionLoopSteps: [],
    lite: true,
    liteCommand,
    suppressImplementationNext: isExecute,
    ...(result.runDir !== undefined ? { runDir: result.runDir } : {}),
  }) as unknown as Record<string, unknown>;

  payload['command'] = 'run';
  payload['mode'] = 'chat';
  payload['checks'] = ['chat engine path'];
  payload['verification'] = result.verifierReceipt
    ? {
        status: 'completed',
        commands: [result.verifierReceipt.command],
        exit_code: result.verifierReceipt.exit_code,
      }
    : {
        status: 'not_required',
        commands: ['chat engine path'],
        skipped_reason: 'chat mode',
      };
  payload['routing'] = {
    orchestrator: 'chat_engine',
    requested_model: context.model ?? null,
    requested_model_tier: context.modelTier ?? null,
    target_project: context.project ?? null,
    task_category: 'Chat',
    pipeline_mode: 'chat',
    domain_id: null,
    model_adapter_id: null,
    selected_entry_ids: [],
    prompt_manifest_count: 0,
  };
  const verifier = result.verifierReceipt;
  const gatePolicy = result.gatePolicy;
  let status: 'pass' | 'fail' | 'not_required' | 'not_run';
  let required: boolean;
  let reason: string;
  let verification: { command: string; exit_code: number; summary: string } | null;

  if (verifier) {
    status = verifier.exit_code === 0 ? 'pass' : 'fail';
    required = true;
    reason = `Verifier "${verifier.command}" exited with code ${verifier.exit_code}.`;
    verification = verifier;
  } else if (gatePolicy === 'none') {
    status = 'not_required';
    required = false;
    reason = 'Verification policy is none — no verifier was required.';
    verification = null;
  } else if (gatePolicy === 'required' || gatePolicy === 'strict') {
    status = 'not_run';
    required = true;
    reason = `Verification policy is "${gatePolicy}" but no verifier was executed.`;
    verification = null;
  } else {
    status = 'not_required';
    required = false;
    reason = 'Completion verification is not required for chat engine runs.';
    verification = null;
  }

  payload['completion_verification'] = {
    schema_version: 1,
    status,
    reason,
    required,
    verification,
  };

  // P4: Surface toolCalls for evidence linking — always include even when empty
  payload['toolCalls'] = result.toolCalls ?? [];

  // A1: Aggregate tool call counts derived from toolCalls
  if (result.toolCalls && result.toolCalls.length > 0) {
    const aggregates = computeToolCallAggregates(
      result.toolCalls.map(tc => ({
        tool: tc.tool,
        ...(tc.error !== undefined ? { error: tc.error } : {}),
      }))
    );
    payload['tool_call_count'] = aggregates.tool_call_count;
    payload['write_count'] = aggregates.write_count;
    payload['verifier_attempt_count'] = aggregates.verifier_attempt_count;
    // C2: Count tools before first successful mutation
    payload['tools_before_first_write'] = computeToolsBeforeFirstWrite(
      result.toolCalls.map(tc => ({
        tool: tc.tool,
        ...(tc.error !== undefined ? { error: tc.error } : {}),
      }))
    );
  } else {
    payload['tool_call_count'] = 0;
    payload['write_count'] = 0;
    payload['verifier_attempt_count'] = 0;
    payload['tools_before_first_write'] = 0;
  }

  // A4: Patch reality snapshot (derived from toolCalls; harness fills git fields)
  const writeCountFromTools = result.toolCalls
    ? result.toolCalls.filter(tc => isSuccessfulDirectMutation(tc.tool, tc.error)).length
    : 0;
  const changedFiles = result.toolCalls && result.toolCalls.length > 0
    ? [...new Set(
        result.toolCalls
          .filter(tc => isSuccessfulDirectMutation(tc.tool, tc.error))
          .map(tc => tc.target)
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
      )]
    : [];
  payload['patch_reality'] = {
    patch_bytes: 0,  // harness fills this; CLI can't know git diff
    changed_files: changedFiles,
    empty_patch: writeCountFromTools === 0,
    capture_method: 'tool_log',
    tool_write_count: writeCountFromTools,
    git_write_signal: false,  // harness fills this
  };

  // A4: Transcript path — set by harness if available
  payload['transcript_path'] = null;

  // P4: Surface changed_files derived from toolCalls (T0.1: includes str_replace)
  if (result.toolCalls && result.toolCalls.length > 0) {
    const changedFiles = [...new Set(
      result.toolCalls
        .filter(tc => isSuccessfulDirectMutation(tc.tool, tc.error))
        .map(tc => tc.target)
        .filter((t): t is string => typeof t === 'string' && t.length > 0)
    )];
    payload['changed_files'] = changedFiles;
  } else {
    payload['changed_files'] = [];
  }

  // P4: Surface verifier receipt
  if (result.verifierReceipt) {
    payload['verifier_receipt'] = result.verifierReceipt;
  }

  // Idea 14: Surface asymmetric diff critic receipt (model + tier for A/B)
  if (result.criticReceipt) {
    payload['critic_receipt'] = {
      verdict: result.criticReceipt.verdict,
      reasons: result.criticReceipt.reasons,
      confidence: result.criticReceipt.confidence,
      ...(result.criticReceipt.model ? { model: result.criticReceipt.model } : {}),
      ...(result.criticReceipt.tier ? { tier: result.criticReceipt.tier } : {}),
      ...(result.criticReceipt.skippedReason
        ? { skipped_reason: result.criticReceipt.skippedReason }
        : {}),
      ...(result.criticReceipt.latency_ms !== undefined
        ? { latency_ms: result.criticReceipt.latency_ms }
        : {}),
    };
  }

  // Honest budget-kill classification for harness failure_class mapping
  if (result.budgetExceeded || answerStatus === 'BUDGET_EXCEEDED') {
    payload['budget_exceeded'] = true;
    payload['failure_class_hint'] = 'budget_exceeded';
    payload['user_status'] = 'budget_exceeded';
  }

  // W0.4: env-red honesty — ENV_BLOCKED distinct from fail / empty success
  const implementorHarness = resolveImplementorHarnessFields({
    answer: result.answer,
    ...(result.toolCalls !== undefined ? { toolCalls: result.toolCalls } : {}),
    hasAnyWrites: writeCountFromTools > 0,
    emptyPatch: writeCountFromTools === 0,
    legacyAnswerStatus: answerStatus,
  });
  payload['env_blocked'] = implementorHarness.env_blocked;
  payload['empty_patch_scoreable'] = implementorHarness.empty_patch_scoreable;
  payload['empty_patch_score_reason'] = implementorHarness.empty_patch_score_reason;

  // W1.2 / Wave 1 exit #3: phase-gate write blocks visible + counted in harness JSON
  const resultExtras = result as unknown as Record<string, unknown>;
  const policyEventsForGate = Array.isArray(result.policyEvents)
    ? result.policyEvents
    : Array.isArray(resultExtras['policyEvents'])
      ? (resultExtras['policyEvents'] as Array<{ kind: string; detail?: string; tool?: string }>)
      : [];
  const blockedAttemptsForGate = Array.isArray(resultExtras['blockedAttempts'])
    ? (resultExtras['blockedAttempts'] as Array<{ reason: string; tool: string }>)
    : [];
  const phaseGateMetrics = countPhaseGateWriteBlocks({
    policyEvents: policyEventsForGate,
    blockedAttempts: blockedAttemptsForGate,
  });
  payload['phase_gate_block_count'] = phaseGateMetrics.phase_gate_block_count;
  payload['phase_gate_write_block_count'] = phaseGateMetrics.phase_gate_write_block_count;
  if (phaseGateMetrics.visibility_line) {
    payload['phase_gate_write_block_visibility'] = phaseGateMetrics.visibility_line;
  }
  if (implementorHarness.env_blocked) {
    payload['status'] = implementorHarness.status;
    payload['failure_class_hint'] = implementorHarness.failure_class_hint;
    payload['user_status'] =
      writeCountFromTools > 0 ? 'partial' : 'blocked';
    if (implementorHarness.operator_card) {
      payload['env_blocked_card'] = implementorHarness.operator_card;
    }
    // Keep patch_reality.empty_patch truthful, but quarantine KPI scoring.
    const pr = payload['patch_reality'] as Record<string, unknown> | undefined;
    if (pr && typeof pr === 'object') {
      pr['env_blocked'] = true;
      pr['empty_patch_scoreable'] = implementorHarness.empty_patch_scoreable;
    }
  }

  // P4: Surface run_dir
  payload['run_dir'] = result.runDir ?? null;

  // BLOCKED: Surface blocked report when present
  if (result.blockedReport) {
    payload['blocked_report'] = result.blockedReport;
  } else if (result.answer && /\bBLOCKED\b/i.test(result.answer) && Array.isArray(result.toolCalls)) {
    // R1 fallback: detect BLOCKED in the answer text when the engine didn't
    // produce a structured report (e.g., streaming path edge cases).
    const investigateTools = new Set([
      'read_file',
      'read_range',
      'grep',
      'glob',
      'list_dir',
      'run_command',
      'shell_exec',
      'test_run',
    ]);
    const checked = (result.toolCalls as Array<Record<string, unknown>>)
      .filter(tc => investigateTools.has(String(tc['tool'] ?? '')) && !!tc['target'])
      .slice(-15)
      .map(tc => ({
        action: String(tc['tool'] ?? ''),
        target: String(tc['target'] ?? ''),
        finding: typeof tc['detail'] === 'string' ? tc['detail'] : 'Investigated',
      }));
    if (checked.length > 0) {
      payload['blocked_report'] = {
        schema_version: 1,
        status: 'BLOCKED' as const,
        reason: result.answer.slice(0, 200),
        missing: 'External dependency not available in the execution environment',
        checked,
        next_steps: ['Review the blocked report and provide the missing dependencies before retrying.'],
      };
      // Also update the payload status so the benchmark recognizes the BLOCKED outcome
      payload['status'] = 'BLOCKED';
    }
  }

  // R2: Surface read dedupe cache hit count for evidence (always include, even when 0)
  payload['dedupe_hit_count'] = result.dedupeHitCount ?? 0;

  // R9: Surface verifier tampering flag
  if (result.verifierTampered) {
    payload['verifier_tampered'] = true;
  }

  // B4: Prompt stack fingerprint for run provenance
  if (result.promptFingerprint) {
    payload['fingerprint'] = result.promptFingerprint;
  }

  // B3: Blocked attempt ledger
  const blockedAttempts = (result as unknown as Record<string, unknown>)['blockedAttempts'];
  if (Array.isArray(blockedAttempts) && blockedAttempts.length > 0) {
    payload['blocked_attempts'] = blockedAttempts;
    const blockedCounts = (result as unknown as Record<string, unknown>)['blockedAttemptCounts'];
    if (blockedCounts && typeof blockedCounts === 'object') {
      payload['blocked_attempt_counts'] = blockedCounts;
    }
  }

  // B2: Turn decision summaries
  const turnSummaries = (result as unknown as Record<string, unknown>)['turnSummaries'];
  if (Array.isArray(turnSummaries) && turnSummaries.length > 0) {
    payload['turn_summaries'] = turnSummaries;
  } else {
    payload['turn_summaries'] = [];
  }

  return payload;
}

function shouldUseConversationalRenderer(outputFormat: 'text' | 'json' | 'stream-json'): boolean {
  return (
    outputFormat === 'text' &&
    process.stdout.isTTY &&
    !process.env['CI'] &&
    !process.env['NO_COLOR']
  );
}

function finishConversationalRenderer(
  convRenderer: ConversationalRenderer | null,
  result: ChatResult,
  preRunCost: number,
): void {
  if (!convRenderer) return;

  const postRunCost = globalCostTracker.getSessionSummary().totalCostUSD;
  if (result.status === 'failed') {
    convRenderer.fail(new Error(result.answer || 'Chat task failed'));
  } else {
    convRenderer.onSummary({
      status: 'pass',
      costUSD: postRunCost,
      perRunCost: Math.max(0, postRunCost - preRunCost),
      changedFiles: [],
    });
    convRenderer.stop();
  }
}

/**
 * Scan session checkpoints and surface availability to the renderer.
 */
export function scanSessionCheckpoints(convRenderer: ConversationalRenderer): void {
  try {
    const sessionCpDir = path.join(BABEL_RUNS_DIR, 'session-checkpoints');
    if (fs.existsSync(sessionCpDir)) {
      for (const sessionId of fs.readdirSync(sessionCpDir)) {
        const sessionDir = path.join(sessionCpDir, sessionId);
        if (fs.statSync(sessionDir).isDirectory()) {
          const files = fs.readdirSync(sessionDir);
          if (files.some((f) => f.endsWith('.json') && f !== 'latest.json')) {
            convRenderer.setCheckpointAvailable(true);
            break;
          }
        }
      }
    }
  } catch (err) {
    console.error(
      '  [chat] Checkpoint scan failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Headless CLI wrapper: load identity, run engine once, handle TTY renderer vs
 * plain stdout, optional stream-json events.
 */
export async function runCliChatTask(input: {
  task: string;
  project?: string;
  projectRoot: string;
  workspaceRoot?: string | null;
  model?: string;
  modelTier?: string;
  allowExpensive?: boolean;
  showModelPolicy?: boolean;
  outputFormat?: 'text' | 'json' | 'stream-json';
  onStreamEvent?: (event: ChatStreamEvent) => void;
  engineFactory?: ChatEngineFactory;
}): Promise<{ payload: Record<string, unknown>; exitCode: number }> {
  const outputFormat = input.outputFormat ?? 'text';
  const target = resolveAgentTarget({
    ...(input.project !== undefined ? { project: input.project } : {}),
    projectRoot: input.projectRoot,
    ...(input.workspaceRoot ? { namedProjectRoot: input.workspaceRoot } : {}),
  });

  const systemContext = await loadProjectSessionIdentity(
    input.projectRoot,
    input.workspaceRoot ?? target.workspaceRoot,
  );

  const useConversational = shouldUseConversationalRenderer(outputFormat);
  const convRenderer = useConversational ? new ConversationalRenderer() : null;

  const preRunCost = globalCostTracker.getSessionSummary().totalCostUSD;

  // Classify intent up front so the gate and payload status are consistent.
  const resolvedIntent = ChatEngine.classifyChatTaskIntent(input.task);

  const result = await runChatEngineOnce({
    task: input.task,
    target,
    systemContext,
    taskIntent: resolvedIntent,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelTier !== undefined ? { modelTier: input.modelTier } : {}),
    ...(input.allowExpensive === true ? { allowExpensive: true } : {}),
    convRenderer,
    ...(input.onStreamEvent ? { onStreamEvent: input.onStreamEvent } : {}),
    ...(input.engineFactory ? { engineFactory: input.engineFactory } : {}),
  });

  if (outputFormat === 'text') {
    finishConversationalRenderer(convRenderer, result, preRunCost);
  }

  const payload = buildChatRunPayload(result, {
    task: input.task,
    ...(input.project !== undefined ? { project: input.project } : {}),
    projectRoot: input.projectRoot,
    workspaceRoot: input.workspaceRoot ?? target.workspaceRoot,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelTier !== undefined ? { modelTier: input.modelTier } : {}),
  }, { taskIntent: resolvedIntent });

  if (input.showModelPolicy === true) {
    payload['show_model_policy'] = true;
  }

  return {
    payload,
    exitCode: result.status === 'completed' ? 0 : 1,
  };
}