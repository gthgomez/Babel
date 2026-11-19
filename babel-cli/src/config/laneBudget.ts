/** Reject a saved monetary ceiling only when a lane cannot enforce it. */
import { resolveEffectiveSettings } from './userSettings.js'
import { isOfflineMode, isProviderLocal } from './offlineMode.js'

/**
 * A finite USD preference is a hard-ceiling promise. Standard Work can enforce
 * it through its owner-bound task allowance; other lanes cannot yet preauthorize
 * it and must reject the request *before* inference instead of silently
 * treating the cap as advisory. Local-only execution cannot spend remote money,
 * so offline/Ollama/loopback runs are exempt from that rejection.
 */
export function assertFiniteBudgetSupported(lane: string, projectRoot = process.env['BABEL_PROJECT_ROOT'] ?? process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const raw = env['BABEL_CHAT_MAX_COST']
  const budget = raw === undefined ? resolveEffectiveSettings({ projectRoot, env }).budgetUsd.value : raw.trim().toLowerCase() === 'unlimited' ? 'unlimited' : Number(raw)
  if (typeof budget === 'number' && (!Number.isFinite(budget) || budget <= 0)) throw new Error('Invalid task budget; choose a positive USD amount or unlimited.')
  if (typeof budget !== 'number') return
  const selected = resolveEffectiveSettings({ projectRoot, env }).connection.value
  const localRoute = isOfflineMode(env) || Boolean(selected && isProviderLocal(selected.provider, selected.baseUrl))
  if (localRoute) return
  throw new Error(
    `BUDGET_UNSUPPORTED: ${lane} cannot preauthorize the saved $${budget} hard ceiling before inference, ` +
      'and Babel will not accept a cap it cannot enforce. Use standard Work with its admitted task allowance, ' +
      'run a local/Ollama route with no remote spend, or explicitly save budgetUsd unlimited if you intend unbounded spending. ' +
      'Request rejected before dispatch.',
  )
}

/** Child inference must retain the existing owner-bound monetary allowance. */
export function assertChildBudgetSupported(lane: string, projectRoot: string, allowance?: { taskOwnerId?: string; parentTaskOwnerId?: string; remainingCostUsd: number | null }): void {
  if (!allowance?.taskOwnerId || !allowance.parentTaskOwnerId || allowance.remainingCostUsd === null || !Number.isFinite(allowance.remainingCostUsd)) assertFiniteBudgetSupported(lane, projectRoot)
}
