// ─── Task Execution Dispatch ───────────────────────────────────────────────
// Extracted from interactive.ts — routes a user input to the correct execution
// engine based on lane classification and session mode.

import type { ReplContext } from '../context.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { parseInteractiveDailyCommand } from '../parsers.js';
import * as Turn from '../turns.js';
import { updateConversationMemory } from '../turns.js';
import { loadSessionIdentity } from '../identity.js';
import {
  AMBIGUOUS_CONFIRMATION_PATTERN,
  EXPLICIT_FOLLOW_UP_FIX_PATTERN,
  APPROVAL_READY_STATUSES,
} from '../types.js';
import { globalCostTracker } from '../../services/costTracker.js';
import { formatRunResultHuman } from '../../cli/structuredOutput.js';
import { primary } from '../../ui/theme.js';
import { executeChatTask as _executeChatTask } from './chat.js';
import { executePlanTask as _executePlanTask } from './plan.js';
import { executeGovernedTask as _executeGovernedTask } from './governed.js';

/** Injectable dependencies for routing tests. Mirrors the ExecuteChatTaskDeps pattern. */
export interface ExecuteTaskDeps {
  executeChatTask?: typeof _executeChatTask;
  executePlanTask?: typeof _executePlanTask;
  executeGovernedTask?: typeof _executeGovernedTask;
  loadSessionIdentity?: typeof loadSessionIdentity;
}

export async function executeTask(
  ctx: ReplContext,
  input: string,
  deps?: ExecuteTaskDeps,
): Promise<void> {
  const executeChatTask = deps?.executeChatTask ?? _executeChatTask;
  const executePlanTask = deps?.executePlanTask ?? _executePlanTask;
  const executeGovernedTask = deps?.executeGovernedTask ?? _executeGovernedTask;
  const resolveIdentity = deps?.loadSessionIdentity ?? loadSessionIdentity;
  try {
    const explicitDailyCommand = parseInteractiveDailyCommand(input);
    // Phase 4A: Deprecation warning for `bl` prefix in REPL (CLI already blocks it)
    if (explicitDailyCommand?.prefix === 'bl') {
      console.warn(
        '[DEPRECATED] `bl` prefix is deprecated. Use `babel` instead. Continuing with babel prefix.',
      );
    }
    const resolvedTask = explicitDailyCommand
      ? explicitDailyCommand.task
      : Turn.resolveInteractiveTask(ctx, input);
    const currentTarget = ctx.resolveCurrentTarget();
    ctx.scheduleIndexWarmup(currentTarget.targetRoot);
    const target =
      Turn.isFollowUpInput(ctx, input) && !ctx.targetOverrideRoot && ctx.lastTargetRoot
        ? {
            ...currentTarget,
            targetRoot: ctx.lastTargetRoot,
            workspaceRoot: ctx.lastWorkspaceRoot,
            source: 'current_repo' as const,
          }
        : currentTarget;
    ctx.appendTurn({
      role: 'user',
      input,
      resolved_task: resolvedTask,
      target_root: target.targetRoot,
      workspace_root: target.workspaceRoot,
    });
    // Load session identity once per project root (AGENTS.md, CLAUDE.md,
    // ENGINEERING.md, PROJECT_CONTEXT.md + cached repo map). This gives the
    // agent immediate awareness of who it is, where it is, and how to work.
    const systemContext = await resolveIdentity(ctx, target.targetRoot);

    const lane = explicitDailyCommand?.verb ?? Turn.classifyInteractiveLane(ctx, input);
    const approvalFollowUp =
      !explicitDailyCommand &&
      ctx.lastAssistantStatus !== null &&
      APPROVAL_READY_STATUSES.has(ctx.lastAssistantStatus) &&
      (AMBIGUOUS_CONFIRMATION_PATTERN.test(input.trim()) ||
        EXPLICIT_FOLLOW_UP_FIX_PATTERN.test(input.trim()));
    const effectiveTask = approvalFollowUp
      ? Turn.resolveApprovalFollowUpTask(ctx, input)
      : resolvedTask;
    if (lane === 'ambiguous_confirmation') {
      handleAmbiguousConfirmation(ctx, input, target);
      return;
    }
    if (!resolvedTask) {
      console.log(
        primary('\n  Please include task text after `babel`. Try: babel "describe the task"\n'),
      );
      ctx.state.lastRunUserStatus = 'blocked';
      return;
    }
    if (lane === 'deep') {
      await executeGovernedTask(ctx, input, resolvedTask, target, 'deep');
      return;
    }
    // Plan mode: run plan pipeline and show interactive review
    if (ctx.state.mode === 'plan') {
      await executePlanTask(ctx, input, effectiveTask, target);
      return;
    }
    // Chat mode: direct streaming ChatEngine — no waterfall, no pipeline, no Zod.
    // Use 'babel deep' or /mode deep to access the full governed pipeline.
    if (ctx.state.mode === 'chat' || ctx.state.mode === 'chat-headless') {
      if (ctx.state.mode === 'chat-headless') {
        process.env['BABEL_HEADLESS'] = '1';
      }
      if (explicitDailyCommand?.verb === 'deep') {
        await executeGovernedTask(ctx, input, resolvedTask, target, 'deep');
        return;
      }
      await executeChatTask(ctx, input, effectiveTask, target, systemContext);
      return;
    }
    // Legacy governed path (non-chat modes)
    await executeGovernedTask(ctx, input, effectiveTask, target);
  } finally {
    ctx.saveSessionState();
  }
}

export function handleAmbiguousConfirmation(
  ctx: ReplContext,
  input: string,
  target: AgentTargetContext,
): void {
  const message =
    'Please say `babel "make the change"` or `go ahead` if you want Babel to apply work. A bare confirmation will not start a run.';
  const payload: Record<string, unknown> = {
    status: 'NEEDS_MORE_CONTEXT',
    user_status: 'blocked',
    command: 'plan',
    task: input,
    project: ctx.state.project ?? null,
    run_dir: null,
    scope: {
      project_root: target.targetRoot,
      allowed_write_paths: [],
      refused_paths: [],
    },
    changed_files: [],
    verification: {
      status: 'not_required',
      commands: [],
      skipped_reason: 'ambiguous confirmation',
    },
    checkpoint: {
      required: false,
      available: false,
      restore_command: null,
      inspect_command: null,
    },
    evidence: {
      run_dir: null,
      support_path: null,
      artifacts: [],
    },
    checks: [],
    usage: globalCostTracker.getSessionSummary(),
    answer: {
      summary: message,
      answer: message,
      facts: [],
      assumptions: [],
      evidence: [],
    },
    next: ['Use `babel "make the change"` when you want work applied.'],
    support_path: null,
  };
  const human = formatRunResultHuman(payload);
  ctx.state.lastRunUserStatus = 'blocked';
  updateConversationMemory(ctx, payload, input);
  ctx.appendTurn({
    role: 'assistant',
    answer: message,
    summary: message,
    run_dir: null,
    target_root: target.targetRoot,
    workspace_root: target.workspaceRoot,
    changed_files: [],
    verification: 'not required - ambiguous confirmation',
    next: ctx.lastAssistantNext,
  });
  console.log(`\n${human}\n`);
}
