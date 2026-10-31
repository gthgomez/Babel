/** Reject a saved monetary ceiling when a lane cannot enforce it. */
import { resolveEffectiveSettings } from './userSettings.js'

export function assertFiniteBudgetSupported(lane: string, projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const raw = env['BABEL_CHAT_MAX_COST']
  const budget = raw === undefined ? resolveEffectiveSettings({ projectRoot, env }).budgetUsd.value : raw.trim().toLowerCase() === 'unlimited' ? 'unlimited' : Number(raw)
  if (typeof budget === 'number' && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Invalid task budget; choose a positive USD amount or unlimited.')
  if (typeof budget === 'number') throw new Error(`BUDGET_UNSUPPORTED: ${lane} cannot enforce the saved $${budget} task cap. Use standard Work with its admitted task allowance, or explicitly save budgetUsd unlimited if you intend unbounded spending. Request rejected before dispatch.`)
}

/** Child inference must retain the existing owner-bound monetary allowance. */
export function assertChildBudgetSupported(lane: string, projectRoot: string, allowance?: { taskOwnerId?: string; parentTaskOwnerId?: string; remainingCostUsd: number | null }): void {
  if (!allowance?.taskOwnerId || !allowance.parentTaskOwnerId || allowance.remainingCostUsd === null || !Number.isFinite(allowance.remainingCostUsd)) assertFiniteBudgetSupported(lane, projectRoot)
}
