/** Read-only planning with an explicit saved handoff for application. */
import type { ReplContext } from '../context.js'
import type { AgentTargetContext } from '../../services/targetResolver.js'
import { runBabelPipeline, BabelEventBus } from '../../pipeline.js'
import type { PlanDecision } from '../../ui/planView.js'
import { stdinCoordinatorPauseForRun, stdinCoordinatorResumeAfterRun } from '../../ui/inputCoordinator.js'
import { resolveEffectiveSettings } from '../../config/userSettings.js'
import { savePlan, shouldAutoApplyPlan, withSavedPlanApplication } from '../../services/savedPlan.js'
import { withProjectRootEnv } from '../../commands/projectRootEnv.js'
import { userStatusForRun } from '../utils.js'
import { assertFiniteBudgetSupported } from '../../config/laneBudget.js'

export function planDecisionShellOutcome(decision: PlanDecision | null): string {
  return decision === null ? 'cancelled' : 'blocked'
}

export async function executePlanTask(ctx: ReplContext, input: string, task: string, target: AgentTargetContext): Promise<void> {
  assertFiniteBudgetSupported('Plan', target.targetRoot)
  ctx.isRunning = true
  stdinCoordinatorPauseForRun(ctx.rl)
  const bus = new BabelEventBus()
  const epoch = ctx.shellRuntime?.store.epoch
  try {
    const effective = resolveEffectiveSettings({ projectRoot: target.targetRoot })
    console.log(`Planning only. Automatic application: ${effective.autoApply.value ? 'enabled' : 'off'} (${effective.autoApply.source}).`)
    const result = await withProjectRootEnv(target.targetRoot, [target.targetRoot], () => runBabelPipeline(task, {
      ...(ctx.state.project ? { project: ctx.state.project } : {}), mode: 'plan', orchestratorVersion: ctx.state.router,
      ...(ctx.state.model ? { modelOverride: ctx.state.model } : {}), eventBus: bus,
    }))
    ctx.lastRunDir = result.runDir
    if (userStatusForRun(result.status) !== 'complete' || !result.plan) throw new Error('The planning run did not produce a usable plan; inspect the run evidence.')
    const body = JSON.stringify(result.plan, null, 2)
    const saved = savePlan({ projectRoot: target.targetRoot, task, body })
    ctx.state.savedPlanId = saved.id
    ctx.lastAssistantAnswer = body
    ctx.lastAssistantStatus = 'PLAN_READY'
    ctx.state.lastRunUserStatus = 'complete'
    console.log(`${body}\nPlan saved: ${saved.id}\nApply with /apply ${saved.id}.`)
    ctx.appendTurn({ role: 'assistant', answer: body, summary: `Plan ${saved.id}`, run_dir: result.runDir, changed_files: [], verification: 'read-only plan', next: `/apply ${saved.id}` }, 'PLAN_READY')
    if (shouldAutoApplyPlan(task, effective.autoApply.value, ctx.state.operatorMode === 'hard_plan' || ctx.state.operatorMode === 'dry_run')) {
      await withSavedPlanApplication(saved.id, { projectRoot: target.targetRoot, operatorMode: ctx.state.operatorMode, execute: async plan => {
        const applied = await withProjectRootEnv(plan.projectRoot, [plan.projectRoot], () => runBabelPipeline(
          `Implement this approved plan within current permissions.\nTask: ${plan.task}\nPlan: ${plan.body}`, {
            ...(ctx.state.project ? { project: ctx.state.project } : {}), mode: 'deep', orchestratorVersion: ctx.state.router,
            ...(ctx.state.model ? { modelOverride: ctx.state.model } : {}),
          }))
        ctx.lastRunDir = applied.runDir
        ctx.state.lastRunUserStatus = userStatusForRun(applied.status)
        if (!['COMPLETE', 'COMPLETE_NO_MODIFICATION'].includes(applied.status)) throw new Error('Plan implementation stopped; inspect the run evidence.')
      } })
    }
    ctx.saveSessionState()
    ctx.settleShellTurn?.('complete', epoch)
  } catch (error) {
    ctx.state.lastRunUserStatus = 'failed'
    ctx.settleShellTurn?.('failed', epoch)
    console.error(error instanceof Error ? error.message : 'Planning failed.')
  } finally {
    bus.removeAllListeners()
    ctx.isRunning = false
    stdinCoordinatorResumeAfterRun(ctx.rl)
  }
}
