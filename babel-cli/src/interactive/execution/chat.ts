// ─── Chat Task Execution ────────────────────────────────────────────────────
// Extracted from interactive.ts — direct chat execution via ChatEngine.
// No waterfall, no pipeline, no Zod. Streams the model's response and tool
// calls conversationally, exactly like Claude Code or Codex.

import * as fs from 'node:fs';
import type { ReplContext } from '../context.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { ChatEngine, type ChatEngineOptions } from '../../agent/chatEngine.js';
import { ConversationalRenderer } from '../../ui/waterfall.js';
import { globalCostTracker } from '../../services/costTracker.js';

import { error, muted } from '../../ui/theme.js';
import { updateConversationMemory } from '../turns.js';
import { alert } from '../../ui/dialog.js';
import { resolveChatEngineLimits } from '../../config/chatEngineLimits.js';
import {
  describeInteractiveCodingProfile,
  resolveChatTaskClass,
  getChatTaskTune,
} from '../../config/chatTaskClass.js';
import type { TerminalOutcome } from '../../schemas/agentContracts.js';
import { isSuccessfulDirectMutation } from '../../agent/mutationTools.js';
import { hydrateResumedThreadToScreen } from '../../services/threadStore/index.js';
import {
  buildChatRunPayload,
  gatherChatPreflightContext,
  runChatEngineOnce,
  scanSessionCheckpoints,
} from './chatCore.js';
import { createChatEngineForSession } from './chatTransport.js';
import {
  createChatPlanExecuteHandoff,
  normalizeChatOperatorMode,
  operatorModeImpliesDryRun,
  type ChatPlanExecuteHandoff,
} from '../../agent/planExecuteMode.js';
import {
  classifyImplementorTerminal,
  detectEnvBlockedFromText,
} from '../../agent/implementorPolicy.js';
import { formatRoutingStatusLabel } from '../../agent/turnRoutingReceipt.js';
import { notifyRunEnded, notifyRunStarted, takeStreamingDraft } from '../../ui/interruptHost.js';
import { presentChatReview } from '../../ui/reviewCard.js';
import { projectTurnViewState, renderProjectedReviewCard } from '../projection/turnViewProjector.js';
import { rememberReviewDiff } from '../../ui/diffReview.js';
import { isOperatorAbortError } from '../../agent/operatorAbort.js';
import { isSessionConsistencyFailureMessage } from '../../agent/sessionEventDiagnostics.js';

/**
 * Extract changed file paths from a ChatResult's tool-call log.
 * Only includes files touched by successful mutation tools.
 */
function collectChangedFiles(result: {
  toolCalls?: Array<{ tool: string; target: string; detail?: string; error?: string }>;
}): string[] {
  if (!result.toolCalls || result.toolCalls.length === 0) return [];
  const seen = new Set<string>();
  for (const tc of result.toolCalls) {
    if (isSuccessfulDirectMutation(tc.tool, tc.error) && tc.target) {
      seen.add(tc.target);
    }
  }
  // Also pick up sub-agent writes from detail
  for (const tc of result.toolCalls) {
    if (tc.tool === 'sub_agent' && tc.detail && /[1-9]\d*\s+changed/.test(tc.detail)) {
      // Sub-agent targets are agent labels, not file paths — skip
    }
  }
  return [...seen].sort();
}

export interface ExecuteChatTaskDeps {
  /** Injectable factory for integration tests (avoids mock.module). */
  engineFactory?: (options: ChatEngineOptions) => ChatEngine;
  gatherPreflight?: typeof gatherChatPreflightContext;
}

/**
 * Direct chat execution via ChatEngine — no waterfall, no pipeline, no Zod.
 * Streams the model's response and tool calls conversationally, exactly like
 * Claude Code or Codex. The governed pipeline is only invoked via explicit
 * `babel deep` or `/mode deep`.
 */
export async function executeChatTask(
  ctx: ReplContext,
  input: string,
  task: string,
  target: AgentTargetContext,
  systemContext?: string,
  deps?: ExecuteChatTaskDeps,
): Promise<void> {
  ctx.isRunning = true;
  notifyRunStarted();
  // Slice 2: do not re-activate PromptInput during the turn. A live composer
  // shares stdin with ConversationalRenderer and turns one Ctrl+C into
  // cancel + process-exit on ConPTY (raw 0x03 plus SIGINT).
  const preRunCost = globalCostTracker.getSessionSummary().totalCostUSD;
  ctx.lastTargetRoot = target.targetRoot;
  ctx.lastWorkspaceRoot = target.workspaceRoot;
  ctx.state.lastRunTargetRoot = target.targetRoot;
  ctx.activeContext = null;
  ctx.lastTurnActiveContextTokens = null;

  const useConversational =
    process.stdout.isTTY && !process.env['CI'] && !process.env['NO_COLOR'];
  const convRenderer = useConversational
    ? new ConversationalRenderer({ verboseMode: Boolean(ctx.verboseMode) })
    : null;

  // U1.2: surface active coding profile when non-default/specialized or in verbose mode
  const activeProfile = resolveChatTaskClass({ taskText: task });
  const isExplicitOrSpecialized =
    ctx.verboseMode ||
    process.env['BABEL_VERBOSE'] ||
    process.env['BABEL_CHAT_TASK_CLASS'] ||
    process.env['BABEL_CHAT_SWE_PROFILE'] ||
    activeProfile === 'governance' ||
    activeProfile === 'general_swe';

  if (isExplicitOrSpecialized) {
    console.log(muted(`  coding profile: ${describeInteractiveCodingProfile(activeProfile)}`));
  }

  try {
    const appendFragments: string[] = [];
    const appendSystemPrompt = appendFragments.length > 0
      ? appendFragments.join('\n\n')
      : undefined;

    const gatherPreflight = deps?.gatherPreflight ?? gatherChatPreflightContext;
    if (!fs.existsSync(target.targetRoot)) {
      throw new Error(`Resolved target root does not exist: ${target.targetRoot}`);
    }
    const preflightContext = await gatherPreflight(target.targetRoot);
    const engineFactory = deps?.engineFactory ?? ((options) => new ChatEngine(options));

    if (!ctx.chatEngine) {
      const limits = resolveChatEngineLimits({}, ctx.state.model, {
        taskClass: activeProfile,
        taskText: task,
      });
      const operatorMode = normalizeChatOperatorMode(ctx.state.operatorMode) ?? 'default';
      if (operatorModeImpliesDryRun(operatorMode)) {
        process.env['BABEL_DRY_RUN'] = '1';
      }
      let planHandoff: ChatPlanExecuteHandoff | undefined;
      if (ctx.state.pendingPlanBody?.trim()) {
        planHandoff = createChatPlanExecuteHandoff({
          planBody: ctx.state.pendingPlanBody,
          linkedEventId: ctx.interactiveSessionId,
        });
        // Consume staged plan once implement engine starts.
        delete ctx.state.pendingPlanBody;
        ctx.state.operatorMode = 'default';
        ctx.saveSessionState();
      }
      const engineOptions: ChatEngineOptions = {
        task,
        projectRoot: target.targetRoot,
        ...(systemContext ? { systemContext } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        ...(preflightContext ? { preflightContext } : {}),
        ...(ctx.state.model !== undefined ? { model: ctx.state.model } : {}),
        maxTurns: limits.maxTurns,
        maxConversationMessages: limits.maxConversationMessages,
        maxEstimatedTokens: limits.maxEstimatedTokens,
        workspaceRoot: target.workspaceRoot ?? null,
        operatorMode,
        ...(operatorMode === 'hard_plan' ? { hardPlanMode: true } : {}),
        ...(planHandoff ? { planHandoff } : {}),
      };
      ctx.chatEngine = await createChatEngineForSession(engineOptions, engineFactory);
    }

    const result = await runChatEngineOnce({
      task,
      target,
      taskIntent: ChatEngine.classifyChatTaskIntent(task),
      ...(systemContext ? { systemContext } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      ...(ctx.state.model !== undefined ? { model: ctx.state.model } : {}),
      engine: ctx.chatEngine,
      engineFactory,
      convRenderer,

      ...(preflightContext ? { preflightContext } : {}),
      onCancel: () => ctx.chatEngine!.abortTurn(),
    });

    // U1.3: Surface last routing receipt label on status bar (model tier + phase)
    if (result.turnRouting && result.turnRouting.length > 0) {
      const lastReceipt = result.turnRouting[result.turnRouting.length - 1];
      if (lastReceipt) {
        ctx.lastRoutingLabel = formatRoutingStatusLabel(lastReceipt) || null;
      }
    }

    // Record active context tokens strictly from latest model request prompt_tokens (never cumulative session tokens)
    if (result.activeContext) {
      ctx.activeContext = result.activeContext;
      ctx.lastTurnActiveContextTokens = result.activeContext.tokens;
    } else if (result.lastRequestPromptTokens != null && result.lastRequestPromptTokens > 0) {
      ctx.activeContext = {
        tokens: result.lastRequestPromptTokens,
        modelId: ctx.state.resolvedModelId ?? ctx.state.model ?? 'default',
        source: 'provider_prompt_tokens',
      };
      ctx.lastTurnActiveContextTokens = result.lastRequestPromptTokens;
    } else {
      ctx.activeContext = null;
      ctx.lastTurnActiveContextTokens = null;
    }

    // Collect changed files from the tool log for the summary display.
    const changedFiles = collectChangedFiles(result);

    const postRunCost = globalCostTracker.getSessionSummary().totalCostUSD;
    const perRunCost = Math.max(0, postRunCost - preRunCost);
    const resolvedOutcome: TerminalOutcome =
      result.outcome ??
      (result.status === 'completed'
        ? 'NO_CHANGE_REQUIRED'
        : result.status === 'cancelled'
          ? 'CANCELLED'
          : result.status === 'blocked'
            ? 'BLOCKED_POLICY'
            : result.status === 'budget_exhausted'
              ? 'BUDGET_EXHAUSTED'
              : 'AGENT_FAILURE');

    const projectedState = projectTurnViewState([
      {
        type: 'turn_started',
        turnId: String(ctx.turnCounter + 1),
        timestamp: Date.now(),
        userInput: task,
        taskClass: activeProfile ?? 'default',
        model: ctx.state.model ?? 'unknown',
        modelId: ctx.state.resolvedModelId ?? ctx.state.model ?? 'unknown',
      },
      ...(result.activeContext
        ? [
            {
              type: 'provider_usage_recorded' as const,
              requestId: `req-${ctx.turnCounter + 1}`,
              timestamp: Date.now(),
              modelId: result.activeContext.modelId,
              promptTokens: result.activeContext.tokens,
              completionTokens: result.lastRequestCompletionTokens ?? 0,
              costUsd: perRunCost,
            },
          ]
        : []),
      ...changedFiles.map((p) => ({
        type: 'mutation_batch_recorded' as const,
        timestamp: Date.now(),
        paths: [p],
      })),
      ...(result.verifierReceipt
        ? [
            {
              type: 'verification_evaluated' as const,
              timestamp: Date.now(),
              command: result.verifierReceipt.command,
              exitCode: result.verifierReceipt.exit_code,
              receipt: result.verifierReceipt,
              passed: result.verifierReceipt.exit_code === 0,
            },
          ]
        : []),
      {
        type: 'turn_terminal_resolved',
        timestamp: Date.now(),
        outcome: resolvedOutcome,
        status:
          result.status === 'completed' ||
          result.status === 'cancelled' ||
          result.status === 'blocked' ||
          result.status === 'budget_exhausted'
            ? result.status
            : 'failed',
        finalAnswer: result.answer ?? '',
      },
    ]);

    const review = renderProjectedReviewCard(projectedState, {
      verificationPolicy: activeProfile ? getChatTaskTune(activeProfile).verificationPolicy : undefined,
      verificationApplicability:
        changedFiles.length === 0 &&
        !result.verifierReceipt &&
        (activeProfile === 'quick_inspect' || activeProfile === 'investigate')
          ? 'not_applicable'
          : undefined,
      costUsd: perRunCost,
      tokens: result.usage?.totalTokens,
      sessionConsistencyFailure: isSessionConsistencyFailureMessage(result.answer),
    });

    if (convRenderer) {
      scanSessionCheckpoints(convRenderer);

      if (review.kind === 'VERIFIED_COMPLETE') {
        convRenderer.onSummary({
          status: 'pass',
          costUSD: postRunCost,
          perRunCost,
          changedFiles,
        });
        convRenderer.stop();
      } else if (review.kind === 'CANCELLED') {
        convRenderer.cancelRun();
      } else if (review.kind === 'COMPLETE_UNVERIFIED') {
        convRenderer.onSummary({
          status: 'unverified',
          costUSD: postRunCost,
          perRunCost,
          changedFiles,
        });
        convRenderer.stop();
      } else {
        convRenderer.fail(new Error(result.answer || review.title));
      }
      const threadId = ctx.chatEngine?.getEngineRunId();
      if (threadId && review.kind === 'VERIFIED_COMPLETE') {
        hydrateResumedThreadToScreen(ctx, threadId);
      }
    } else if (result.outcome === 'AGENT_FAILURE' || (!result.outcome && result.status === 'failed')) {
      console.error(`\n  ${error('✖')} ${result.answer}\n`);
    } else if (result.answer) {
      console.log(`\n${result.answer}\n`);
    }

    console.log(`\n${review.body}\n`);
    rememberReviewDiff({ files: changedFiles, draft: '', cwd: target.targetRoot });

    ctx.lastResolvedTask = null;
    ctx.lastAssistantAnswer = result.answer;
    // Preserve truthful terminal outcomes from TerminalOutcome
    const lo = result.outcome;
    const hasAnyWrites = (result.toolCalls ?? []).some((t) =>
      /str_replace|write_file|apply_patch|file_write/.test(t.tool),
    );
    // W0.4: env-red from answer or tool observations (pytest/npm missing, etc.).
    // After writes, import-class failures are not scored as host ENV_BLOCKED.
    const envDetectOpts = { hasAnyWrites };
    const envBlocked =
      detectEnvBlockedFromText(result.answer ?? '', envDetectOpts) ||
      (result.toolCalls ?? []).some((t) =>
        detectEnvBlockedFromText(
          `${t.detail ?? ''} ${t.error ?? ''}`,
          envDetectOpts,
        ),
      );
    if (envBlocked) {
      ctx.lastAssistantStatus = 'ENV_BLOCKED';
    } else if (lo === 'VERIFIED_COMPLETE' || lo === 'UNVERIFIED_PATCH') {
      ctx.lastAssistantStatus = 'ANSWER_READY';
    } else if (lo === 'BLOCKED_EXTERNAL' || lo === 'BLOCKED_POLICY') {
      ctx.lastAssistantStatus = 'BLOCKED';
    } else if (lo === 'CANCELLED') {
      ctx.lastAssistantStatus = 'CANCELLED';
    } else if (lo === 'BUDGET_EXHAUSTED') {
      ctx.lastAssistantStatus = 'BUDGET_EXCEEDED';
    } else if (lo === 'INFRA_FAILURE') {
      ctx.lastAssistantStatus = 'NEEDS_MORE_CONTEXT';
    } else {
      // Fallback when outcome is absent (legacy test fixtures)
      const term = classifyImplementorTerminal({
        status:
          result.status === 'completed'
            ? 'completed'
            : result.status === 'cancelled'
              ? 'cancelled'
              : result.status === 'blocked'
                ? 'blocked'
                : 'failed',
        hasAnyWrites,
        envBlocked: false,
        budgetExceeded: result.budgetExceeded === true,
        answer: result.answer,
      });
      ctx.lastAssistantStatus =
        result.status === 'completed' && term !== 'ENV_BLOCKED'
          ? 'ANSWER_READY'
          : term;
    }
    ctx.lastRunDir = null;
    // Preserve truthful outcome — blocked/budget-exhausted/cancelled are not plain "failed"
    // W0.4: env_blocked is operator-visible and distinct from clean complete
    if (envBlocked) {
      ctx.state.lastRunUserStatus = 'blocked';
    } else if (lo === 'VERIFIED_COMPLETE' || lo === 'UNVERIFIED_PATCH') {
      ctx.state.lastRunUserStatus = 'complete';
    } else if (lo === 'BLOCKED_EXTERNAL' || lo === 'BLOCKED_POLICY') {
      ctx.state.lastRunUserStatus = 'blocked';
    } else if (lo === 'CANCELLED') {
      ctx.state.lastRunUserStatus = 'cancelled';
    } else if (lo === 'BUDGET_EXHAUSTED') {
      ctx.state.lastRunUserStatus = 'budget_exhausted';
    } else {
      ctx.state.lastRunUserStatus = result.status === 'completed' ? 'complete' : 'failed';
    }

    const verificationData = result.verifierReceipt
      ? {
          status: 'completed' as const,
          commands: [result.verifierReceipt.command],
          exit_code: result.verifierReceipt.exit_code,
        }
      : {
          status: 'not_run' as const,
          commands: [],
          skipped_reason: 'chat mode',
        };

    updateConversationMemory(
      ctx,
      {
        ...buildChatRunPayload(result, {
          task,
          projectRoot: target.targetRoot,
          ...(ctx.state.project !== undefined && ctx.state.project !== null
            ? { project: ctx.state.project }
            : {}),
        }),
        command: 'chat',
        user_status: ctx.state.lastRunUserStatus,
      },
      task,
    );

    ctx.appendTurn({
      role: 'assistant',
      answer: result.answer,
      summary: result.answer.slice(0, 200),
      run_dir: null,
      target_root: target.targetRoot,
      workspace_root: target.workspaceRoot,
      changed_files: [],
      verification: verificationData.status === 'completed'
        ? `exit ${verificationData.exit_code}: ${verificationData.commands.join(', ')}`
        : 'not_run',
      next: ctx.lastAssistantNext,
      ...(result.turnTelemetry !== undefined ? { turn_telemetry: result.turnTelemetry } : {}),
    });
    // updateConversationMemory remaps TerminalOutcome onto legacy AskAnswer
    // statuses (CANCELLED → NEEDS_MORE_CONTEXT). Restore the operator-facing
    // status so cancel cannot masquerade as a generic failure.
    if (lo === 'CANCELLED') ctx.lastAssistantStatus = 'CANCELLED';
    else if (review.kind === 'COMPLETE_UNVERIFIED') ctx.lastAssistantStatus = 'ANSWER_READY';
    else if (review.kind === 'VERIFICATION_FAILED') ctx.lastAssistantStatus = 'ANSWER_READY';
  } catch (err: any) {
    if (isOperatorAbortError(err)) {
      const projectedState = projectTurnViewState([
        {
          type: 'turn_started',
          turnId: String(ctx.turnCounter + 1),
          timestamp: Date.now(),
          userInput: task,
          taskClass: activeProfile ?? 'default',
          model: ctx.state.model ?? 'unknown',
          modelId: ctx.state.resolvedModelId ?? ctx.state.model ?? 'unknown',
        },
        {
          type: 'turn_terminal_resolved',
          timestamp: Date.now(),
          outcome: 'CANCELLED',
          status: 'cancelled',
          finalAnswer: 'Cancelled',
        },
      ]);
      const review = renderProjectedReviewCard(projectedState);
      if (convRenderer) {
        convRenderer.cancelRun();
      }
      console.log(`\n${review.body}\n`);
      ctx.state.lastRunUserStatus = 'cancelled';
      ctx.lastAssistantStatus = 'CANCELLED';
      return;
    }
    const message = err?.message ?? String(err);
    console.error(`\n  ${error('✖')} ${message}\n`);
    ctx.state.lastRunUserStatus = 'failed';
    if (convRenderer) {
      convRenderer.fail(err);
    }
    // Record the failure in turn history so the session transcript is continuous
    updateConversationMemory(
      ctx,
      {
        status: 'CHAT_FAILED',
        summary: message.slice(0, 200),
        answer: message,
        facts: [],
        assumptions: [],
        evidence: [],
        next: [],
        changed_files: [],
        checks: [],
        verification: { status: 'failed', commands: [], skipped_reason: message },
      },
      task,
    );
    ctx.appendTurn({
      role: 'assistant',
      answer: message,
      summary: message.slice(0, 200),
      run_dir: null,
      target_root: target.targetRoot,
      workspace_root: target.workspaceRoot,
      changed_files: [],
      verification: 'failed',
      next: null,
    });
    if (process.stdout.isTTY && !process.env['CI']) {
      try {
        await alert({
          title: 'Chat Failed',
          message: err.message ?? String(err),
        });
        (err as any)[Symbol.for('babel.error.alerted')] = true;
      } catch (alertErr) {
        console.error('[chat] alert display failed:', (alertErr as Error)?.message ?? alertErr);
      }
    }
  } finally {
    ctx.isRunning = false;
    notifyRunEnded();
    const typedDuringRun = takeStreamingDraft();
    if (typedDuringRun) {
      const adapter = ctx.rl as unknown as {
        getInputText?: () => string;
        setInputText?: (text: string) => void;
      };
      const existing = adapter.getInputText?.() ?? '';
      adapter.setInputText?.(existing + typedDuringRun);
    }
  }
}