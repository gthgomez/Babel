// ─── Plan Task Execution ────────────────────────────────────────────────────
// Extracted from interactive.ts — plan-then-approve flow. Shows a plan via
// renderInteractivePlan, then promotes to deep mode on approval.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReplContext } from '../context.js';
import type { AgentTargetContext } from '../../services/targetResolver.js';
import { runBabelPipeline, BabelEventBus } from '../../pipeline.js';
import { renderInteractivePlan, type DisplayPlan, type PlanDecision } from '../../ui/planView.js';
import { buildRunResultPayload, formatRunResultHuman } from '../../cli/structuredOutput.js';
import { globalCostTracker } from '../../services/costTracker.js';
import {
  stdinCoordinatorPauseForRun,
  stdinCoordinatorResumeAfterRun,
} from '../../ui/inputCoordinator.js';
import { BABEL_RUNS_DIR } from '../../cli/constants.js';
import { accentBright, muted, primary } from '../../ui/theme.js';
import { userStatusForRun } from '../utils.js';
import { openEditor } from '../openEditor.js';
import { updateConversationMemory } from '../turns.js';
import { alert } from '../../ui/dialog.js';

export async function executePlanTask(
  ctx: ReplContext,
  input: string,
  task: string,
  target: AgentTargetContext,
): Promise<void> {
  ctx.isRunning = true;
  stdinCoordinatorPauseForRun(ctx.rl);
  const bus = new BabelEventBus();
  const projectRoot = target.targetRoot;
  ctx.lastTargetRoot = target.targetRoot;
  ctx.lastWorkspaceRoot = target.workspaceRoot;
  ctx.state.lastRunTargetRoot = target.targetRoot;

  try {
    process.stdout.write(primary(`\n  Planning: ${task.slice(0, 80)}\n`));
    process.stdout.write(muted('  Running orchestrator + planner (Stage 1-2)…\n'));

    const result = await runBabelPipeline(task, {
      ...(ctx.state.project !== undefined ? { project: ctx.state.project } : {}),
      mode: 'plan',
      orchestratorVersion: ctx.state.router,
      ...(ctx.state.model !== undefined ? { modelOverride: ctx.state.model } : {}),
      eventBus: bus,
    });

    ctx.lastRunDir = result.runDir;

    // Extract plan from the result
    const planSteps = (result as any).plan?.minimal_action_set ?? [];
    const displayPlan: DisplayPlan = {
      taskSummary: task,
      planType: (result as any).plan?.plan_type ?? 'IMPLEMENTATION_PLAN',
      steps: planSteps.map((s: any) => ({
        description: s.description ?? s.target ?? '',
        tool: s.tool ?? 'unknown',
        target: s.TargetFile ?? s.target ?? s.path ?? '',
      })),
      runDir: result.runDir,
    };

    const decision: PlanDecision | null = await renderInteractivePlan(displayPlan);

    if (decision === 'approve') {
      // Promote to Deep: re-run with same task + plan handoff
      process.stdout.write(primary('\n  Promoting to Deep mode…\n'));
      const deepResult = await runBabelPipeline(task, {
        ...(ctx.state.project !== undefined ? { project: ctx.state.project } : {}),
        mode: 'deep',
        orchestratorVersion: ctx.state.router,
        ...(ctx.state.model !== undefined ? { modelOverride: ctx.state.model } : {}),
      });
      ctx.lastRunDir = deepResult.runDir;
      ctx.state.lastRunUserStatus = userStatusForRun(deepResult.status);
      const payload = buildRunResultPayload(deepResult, {
        task,
        mode: 'deep',
        ...(ctx.state.project !== undefined ? { project: ctx.state.project } : {}),
        ...(projectRoot ? { projectRoot } : {}),
        orchestrator: ctx.state.router,
      });
      const human = formatRunResultHuman(payload);
      updateConversationMemory(ctx, payload as unknown as Record<string, unknown>, task);
      ctx.appendTurn({
        role: 'assistant',
        ...(ctx.lastAssistantAnswer
          ? { answer: ctx.lastAssistantAnswer, summary: ctx.lastAssistantAnswer }
          : {}),
        run_dir: deepResult.runDir,
        changed_files: (payload as any).changed_files ?? [],
        verification: 'not required - plan-then-execute',
        next: ctx.lastAssistantNext,
      });
      console.log(`\n${human}\n`);
    } else if (decision === 'edit') {
      process.stdout.write(primary('\n  Opening editor to refine the task prompt…\n'));
      const edited = await openEditor({ rl: ctx.rl });
      if (edited) {
        // Re-plan with edited prompt
        process.stdout.write(muted('  Re-planning with edited prompt…\n'));
        await executePlanTask(ctx, input, edited.trim(), target);
      } else {
        ctx.state.lastRunUserStatus = 'blocked';
        console.log(muted('\n  Plan cancelled — editor returned empty.\n'));
      }
    } else {
      // Rejected or cancelled
      ctx.state.lastRunUserStatus = 'blocked';
      console.log(
        muted(
          '\n  Plan rejected. Refine your task and try again, or switch to /mode deep for governed execution.\n',
        ),
      );
    }
  } catch (error: any) {
    ctx.state.lastRunUserStatus = 'failed';
    console.error(accentBright(`\n  Plan failed: ${error.message ?? String(error)}\n`));
    if (process.stdout.isTTY && !process.env['CI']) {
      try {
        await alert({
          title: 'Planning Failed',
          message: error.message ?? String(error),
        });
        (error as any)[Symbol.for('babel.error.alerted')] = true;
      } catch {
        // alert() itself failed — already logged via console.error above
      }
    }
  } finally {
    bus.removeAllListeners();
    ctx.isRunning = false;
    stdinCoordinatorResumeAfterRun(ctx.rl);
  }
}


