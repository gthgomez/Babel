/** Read-only planning with an explicit saved handoff for application. */
import type { ReplContext } from '../context.js'
import { basename } from 'node:path'
import type { AgentTargetContext } from '../../services/targetResolver.js'
import { runBabelPipeline } from '../../pipeline.js'
import { AgentSession } from '../../agent/session.js'
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
  const epoch = ctx.shellRuntime?.store.epoch
  const controller = new AbortController()
  const cancel = () => controller.abort()
  ctx.cancelActiveRun = cancel
  try {
    const effective = resolveEffectiveSettings({ projectRoot: target.targetRoot })
    const autoApply = shouldAutoApplyPlan(task, effective.autoApply.value, ctx.state.operatorMode === 'hard_plan' || ctx.state.operatorMode === 'dry_run')
    console.log(`Planning only. Automatic application: ${autoApply ? 'enabled' : 'off'} (${effective.autoApply.source}).`)
    // Public and Desktop planning share this read-only controller. The legacy
    // pipeline's plan mode exports a manual prompt, not a completed saved plan.
    const result = await withProjectRootEnv(target.targetRoot, [target.targetRoot], () => new AgentSession({
      task, verb: 'plan', projectRoot: target.targetRoot, signal: controller.signal,
      ...(target.workspaceRoot ? { workspaceRoot: target.workspaceRoot } : {}),
      ...(ctx.state.project ? { project: ctx.state.project } : {}),
      ...(ctx.state.model ? { model: ctx.state.model } : {}),
    }).run())
    const runDir = result.payload['run_dir']
    ctx.lastRunDir = typeof runDir === 'string' ? runDir : null
    controller.signal.throwIfAborted()
    const body = result.planText?.trim()
    if (result.exitCode !== 0 || result.payload['status'] !== 'PLAN_READY' || !body) throw new Error('The planning run did not produce a usable plan; inspect the run evidence.')
    const saved = savePlan({ projectRoot: target.targetRoot, task, body,
      ...(ctx.lastRunDir ? { sourceRunId: basename(ctx.lastRunDir) } : {}) })
    ctx.state.savedPlanId = saved.id
    ctx.lastAssistantAnswer = body
    ctx.lastAssistantStatus = 'PLAN_READY'
    ctx.state.lastRunUserStatus = 'complete'
    console.log(`${body}\nPlan saved: ${saved.id}\nApply with /apply ${saved.id}.`)
    ctx.appendTurn({ role: 'assistant', answer: body, summary: `Plan ${saved.id}`, ...(ctx.lastRunDir ? { run_dir: ctx.lastRunDir } : {}), changed_files: [], verification: 'read-only plan', next: `/apply ${saved.id}` }, 'PLAN_READY')
    if (autoApply) {
      await withSavedPlanApplication(saved.id, { projectRoot: target.targetRoot, operatorMode: ctx.state.operatorMode, execute: async plan => {
        const applied = await withProjectRootEnv(plan.projectRoot, [plan.projectRoot], () => runBabelPipeline(
          `Implement this approved plan within current permissions.\nTask: ${plan.task}\nPlan: ${plan.body}`, {
            ...(ctx.state.project ? { project: ctx.state.project } : {}), mode: 'deep', orchestratorVersion: ctx.state.router,
            ...(ctx.state.model ? { modelOverride: ctx.state.model } : {}),
            abortSignal: controller.signal,
            planRunId: plan.sourceRunId ?? null,
          }))
        controller.signal.throwIfAborted()
        ctx.lastRunDir = applied.runDir
        ctx.state.lastRunUserStatus = userStatusForRun(applied.status)
        if (!['COMPLETE', 'COMPLETE_NO_MODIFICATION'].includes(applied.status)) throw new Error('Plan implementation stopped; inspect the run evidence.')
      } })
    }
    ctx.saveSessionState()
    ctx.settleShellTurn?.('complete', epoch)
  } catch (error) {
    ctx.state.lastRunUserStatus = controller.signal.aborted ? 'cancelled' : 'failed'
    if (controller.signal.aborted) ctx.lastAssistantStatus = 'CANCELLED'
    ctx.settleShellTurn?.(ctx.state.lastRunUserStatus, epoch)
    console.error(controller.signal.aborted ? 'Planning cancelled.' : error instanceof Error ? error.message : 'Planning failed.')
  } finally {
    if (ctx.cancelActiveRun === cancel) delete ctx.cancelActiveRun
    ctx.isRunning = false
    stdinCoordinatorResumeAfterRun(ctx.rl)
  }
}
