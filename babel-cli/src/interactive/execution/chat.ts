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

import { error, muted, success, warning } from '../../ui/theme.js';
import { updateConversationMemory } from '../turns.js';
import { alert } from '../../ui/dialog.js';
import { dim } from '../../ui/theme.js';
import { resolveChatEngineLimits } from '../../config/chatEngineLimits.js';
import {
  describeInteractiveCodingProfile,
  resolveChatTaskClass,
} from '../../config/chatTaskClass.js';
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
import {
  buildInteractiveCard,
} from '../../agent/failureCard.js';
import { formatRoutingStatusLabel } from '../../agent/turnRoutingReceipt.js';

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
  // C2: keep composer active so Tab can queue follow-ups during the turn.
  if (process.stdout.isTTY && !process.env['CI']) {
    ctx.rl.resume();
    ctx.rl.prompt();
  }
  const preRunCost = globalCostTracker.getSessionSummary().totalCostUSD;
  ctx.lastTargetRoot = target.targetRoot;
  ctx.lastWorkspaceRoot = target.workspaceRoot;
  ctx.state.lastRunTargetRoot = target.targetRoot;

  const useConversational =
    process.stdout.isTTY && !ctx.verboseMode && !process.env['CI'] && !process.env['NO_COLOR'];
  const convRenderer = useConversational ? new ConversationalRenderer() : null;

  // U1.2: surface active coding profile so operators see peer-CLI defaults
  // without reading env folklore. Muted — informational, not noisy.
  const activeProfile = resolveChatTaskClass({ taskText: task });
  console.log(muted(`  coding profile: ${describeInteractiveCodingProfile(activeProfile)}`));

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
      const limits = resolveChatEngineLimits();
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
      onCancel: () => ctx.chatEngine!.cancel(),
    });

    // U1.3: Surface last routing receipt label on status bar (model tier + phase)
    if (result.turnRouting && result.turnRouting.length > 0) {
      const lastReceipt = result.turnRouting[result.turnRouting.length - 1];
      if (lastReceipt) {
        ctx.lastRoutingLabel = formatRoutingStatusLabel(lastReceipt) || null;
      }
    }

    // Collect changed files from the tool log for the summary display.
    const changedFiles = collectChangedFiles(result);

    if (convRenderer) {
      scanSessionCheckpoints(convRenderer);

      const postRunCost = globalCostTracker.getSessionSummary().totalCostUSD;
      const o = result.outcome;
      // Use TerminalOutcome for precise failure display
      if (o === 'AGENT_FAILURE' || (!o && result.status === 'failed')) {
        convRenderer.fail(new Error(result.answer || 'Chat task failed'));
      } else if (o === 'BLOCKED_EXTERNAL' || o === 'BLOCKED_POLICY' || (!o && result.status === 'blocked')) {
        convRenderer.fail(new Error(result.answer || 'Task blocked'));
      } else if (o === 'CANCELLED' || (!o && result.status === 'cancelled')) {
        convRenderer.fail(new Error('Task cancelled'));
      } else if (o === 'BUDGET_EXHAUSTED' || result.budgetExceeded) {
        convRenderer.fail(new Error(result.answer || 'Budget exhausted'));
      } else if (o === 'INFRA_FAILURE') {
        convRenderer.fail(new Error(result.answer || 'Infrastructure error'));
      } else {
        convRenderer.onSummary({
          status: 'pass',
          costUSD: postRunCost,
          perRunCost: Math.max(0, postRunCost - preRunCost),
          changedFiles,
        });
        convRenderer.stop();
        const threadId = ctx.chatEngine?.getEngineRunId();
        if (threadId) {
          hydrateResumedThreadToScreen(ctx, threadId);
        }
      }
    } else if (result.outcome === 'AGENT_FAILURE' || (!result.outcome && result.status === 'failed')) {
      console.error(`\n  ${error('✖')} ${result.answer}\n`);
    } else if (result.answer) {
      console.log(`\n${result.answer}\n`);
    }

    ctx.lastResolvedTask = null;
    ctx.lastAssistantAnswer = result.answer;
    // Preserve truthful terminal outcomes from TerminalOutcome
    const lo = result.outcome;
    const hasAnyWrites = (result.toolCalls ?? []).some((t) =>
      /str_replace|write_file|apply_patch|file_write/.test(t.tool),
    );
    // W0.4: env-red from answer or tool observations (pytest/npm missing, etc.)
    const envBlocked =
      detectEnvBlockedFromText(result.answer ?? '') ||
      (result.toolCalls ?? []).some((t) =>
        detectEnvBlockedFromText(`${t.detail ?? ''} ${t.error ?? ''}`),
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

    // U1.1: Surface tool timeline + interactive card in-session.
    // Operators see last-N tools without opening harness JSON.
    const toolCalls = result.toolCalls ?? [];
    if (toolCalls.length > 0) {
      const isFailOrBlocked =
        result.outcome === 'AGENT_FAILURE' ||
        result.outcome === 'BLOCKED_EXTERNAL' ||
        result.outcome === 'BLOCKED_POLICY' ||
        result.outcome === 'CANCELLED' ||
        result.outcome === 'BUDGET_EXHAUSTED' ||
        result.outcome === 'INFRA_FAILURE' ||
        result.status === 'failed' ||
        result.status === 'blocked' ||
        result.status === 'cancelled';

      if (isFailOrBlocked) {
        const postRunCost = globalCostTracker.getSessionSummary().totalCostUSD;
        const perRunCost = Math.max(0, postRunCost - preRunCost);
        const statusLabel =
          result.status === 'blocked' || result.outcome === 'BLOCKED_EXTERNAL' || result.outcome === 'BLOCKED_POLICY'
            ? 'BLOCKED'
            : result.status === 'cancelled' || result.outcome === 'CANCELLED'
              ? 'CANCELLED'
              : result.outcome === 'BUDGET_EXHAUSTED'
                ? 'BUDGET_EXHAUSTED'
                : 'FAILED';
        const cardBody = buildInteractiveCard({
          status: statusLabel,
          costUsd: perRunCost,
          lastTools: toolCalls,
          recommendedAction: statusLabel === 'BLOCKED'
            ? 'Review blocked report or adjust constraints.'
            : statusLabel === 'FAILED'
              ? 'Inspect tool errors above; re-run with clarified intent or lower scope.'
              : undefined,
        });
        console.log(muted(`\n${cardBody}`));
      } else {
        // Success: short last-tools line when tools ran
        const lastTool = toolCalls[toolCalls.length - 1];
        if (lastTool) {
          const shortTarget =
            lastTool.target.length > 40
              ? lastTool.target.slice(0, 37) + '...'
              : lastTool.target;
          console.log(
            muted(
              `  ${toolCalls.length} tool${toolCalls.length !== 1 ? 's' : ''} run (last: ${lastTool.tool} ${shortTarget})`,
            ),
          );
        }
      }
    }

    // Surface verification status to the user when present.
    if (result.verifierReceipt) {
      const vr = result.verifierReceipt;
      if (vr.exit_code === 0) {
        console.log(`${success('✓')} ${muted('Verified')} — ${vr.command} (exit 0)`);
      } else {
        console.log(`${warning('⚠')} ${muted('Verification failed')} — ${vr.command} (exit ${vr.exit_code})`);
      }
    } else if (result.outcome === 'VERIFIED_COMPLETE' || result.outcome === 'UNVERIFIED_PATCH' || result.status === 'completed') {
      console.log(`${error('✗')} ${muted('No verification run')}`);
    }

    // Surface a compact diff summary when files were changed.
    if (changedFiles.length > 0) {
      const fileList = changedFiles.slice(0, 10).map((f) => `  ${dim('±')} ${f}`).join('\n');
      const tail = changedFiles.length > 10
        ? `\n  ${dim(`… and ${changedFiles.length - 10} more`)}`
        : '';
      console.log(`${dim('── Changes')}${tail}\n${fileList}`);
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
    });
  } catch (err: any) {
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
  }
}