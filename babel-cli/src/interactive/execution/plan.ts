/** Read-only planning with an explicit saved handoff for application. */
import type { ReplContext } from '../context.js'
import { assertInteractiveRunAvailable } from '../context.js'
import { basename } from 'node:path'
import type { AgentTargetContext } from '../../services/targetResolver.js'
import { runBabelPipeline } from '../../pipeline.js'
import { AgentSession } from '../../agent/session.js'
import type { PlanDecision } from '../../ui/planView.js'
import { stdinCoordinatorPauseForRun, stdinCoordinatorResumeAfterRun } from '../../ui/inputCoordinator.js'
import { resolveEffectiveSettings } from '../../config/userSettings.js'
import { shouldAutoApplyPlan, savePlanGuarded } from '../../services/savedPlan.js'
import { withProjectRootEnv } from '../../commands/projectRootEnv.js'
import { assertFiniteBudgetSupported } from '../../config/laneBudget.js'
import { loadPlanHandoffGuarded, PLAN_APPLY_UNAVAILABLE_REASON } from '../../agent/planHandoff.js'
import { buildRunResultPayload, formatRunResultHuman, writeHumanSummaryArtifact } from '../../cli/structuredOutput.js'

export function reportPlanApplication(ctx: ReplContext, result: Awaited<ReturnType<typeof runBabelPipeline>>, task: string, projectRoot: string): void {
  const payload = buildRunResultPayload(result, { task, mode: 'deep', projectRoot, orchestrator: ctx.state.router,
    ...(ctx.state.project ? { project: ctx.state.project } : {}), ...(ctx.state.model ? { requestedModel: ctx.state.model } : {}) })
  const human = formatRunResultHuman(payload)
  ctx.lastAssistantStatus = result.status
  ctx.lastAssistantAnswer = result.finalAnswer ?? null
  ctx.lastSessionRunDir = result.runDir
  const changed = Array.isArray(payload['changed_files']) ? payload['changed_files'].filter((item): item is string => typeof item === 'string') : []
  const verification = payload['verification'] && typeof payload['verification'] === 'object' ? String((payload['verification'] as Record<string, unknown>)['status'] ?? '') : null
  ctx.appendTurn({ role: 'assistant', ...(result.finalAnswer ? { answer: result.finalAnswer } : {}), summary: human,
    run_dir: result.runDir, changed_files: changed, verification }, result.status)
  writeHumanSummaryArtifact(result.runDir, human)
  console.log(`\n${human}\n`)
}

export function planDecisionShellOutcome(decision: PlanDecision | null): string {
  return decision === null ? 'cancelled' : 'blocked'
}

export async function executePlanTask(ctx: ReplContext, input: string, task: string, target: AgentTargetContext): Promise<void> {
  assertInteractiveRunAvailable(ctx)
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
    console.log(`Planning only. Automatic application is unavailable${autoApply ? ' (configured on)' : ''} (${effective.autoApply.source}).`)
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
    const sourceRunId = ctx.lastRunDir ? basename(ctx.lastRunDir) : null
    if (!sourceRunId) throw new Error('The plan source is unavailable or unsafe; inspect the retained run evidence.')
    const source = await loadPlanHandoffGuarded({ repoPath: target.targetRoot, task, planRunId: sourceRunId, includePlanText: true, signal: controller.signal })
    if (!source?.contract || !source.sourcePlanText?.trim() || source.sourcePlanText.trim() !== body) throw new Error('The plan source is unavailable or unsafe; inspect the retained run evidence.')
    const previousSavedPlanId = ctx.state.savedPlanId
    delete ctx.state.savedPlanId
    let saved: Awaited<ReturnType<typeof savePlanGuarded>> | null = null
    let saveUnavailable = false
    if (!controller.signal.aborted) {
      try {
        saved = await savePlanGuarded({ projectRoot: target.targetRoot, task, body, sourceRunId, signal: controller.signal })
      } catch {
        saveUnavailable = true
      }
    }
    if (saved) ctx.state.savedPlanId = saved.id
    ctx.lastAssistantAnswer = body
    ctx.lastAssistantStatus = 'PLAN_READY'
    ctx.state.lastRunUserStatus = saved ? 'complete' : 'blocked'
    const previousPlanNote = previousSavedPlanId ? `Previous saved Plan ID: ${previousSavedPlanId}.` : ''
    const retention = saveUnavailable ? 'The Plan is retained in its run evidence; canonical saving is unavailable.' : `Plan saved as ${saved!.id}.`
    console.log(`${body}\n${retention} Automatic application is unavailable.\n${previousPlanNote}${previousPlanNote ? '\n' : ''}${PLAN_APPLY_UNAVAILABLE_REASON}`)
    ctx.appendTurn({ role: 'assistant', answer: body, summary: [`Plan ${saved ? 'saved' : 'retained in run evidence'}; automatic application unavailable`, previousPlanNote].filter(Boolean).join(' '), ...(ctx.lastRunDir ? { run_dir: ctx.lastRunDir } : {}), changed_files: [], verification: 'read-only plan', next: PLAN_APPLY_UNAVAILABLE_REASON }, 'PLAN_READY')
    ctx.saveSessionState()
    ctx.settleShellTurn?.(ctx.state.lastRunUserStatus, epoch)
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
