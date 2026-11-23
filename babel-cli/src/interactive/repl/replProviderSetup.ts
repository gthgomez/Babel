import { connectionModelSelector } from '../../config/connectionModelPolicy.js'
import { connectionStatus } from '../../services/connectionSettings.js'
import { runProviderSetup } from '../../services/providerSetup.js'
import { withExclusiveStdin } from '../../ui/inputCoordinator.js'
import type { ReplContext } from '../context.js'

/** Run setup with exclusive input and adopt saved choices only on completion. */
export async function setupReplConnection(ctx: ReplContext): Promise<void> {
  const root = ctx.resolveCurrentTarget().targetRoot ?? process.cwd()
  const setup = () => runProviderSetup({ projectRoot: root })
  const result = ctx.withExclusiveTerminal
    ? await ctx.withExclusiveTerminal('provider-setup', setup)
    : await withExclusiveStdin(setup, ctx.rl)
  if (!result.saved) return

  const status = connectionStatus({}, root)
  const wasSetupBlocked = ctx.state.readinessState !== 'configured_unverified'
  delete ctx.state.model
  delete ctx.state.connectionId
  delete ctx.state.resolvedModelId
  if (status.connection) ctx.state.connectionId = status.connection
  if (status.connection && status.model) {
    ctx.state.model = connectionModelSelector(status.connection, status.model)
    ctx.resolveSessionModel()
  }
  ctx.state.modelsByConnection = { ...ctx.state.modelsByConnection, [result.saved.connection]: result.saved.model }
  ctx.state.modelSource = status.modelSource
  ctx.state.readinessState = result.state
  if (wasSetupBlocked && result.state === 'configured_unverified') delete ctx.state.lastRunUserStatus
  delete ctx.state.savedPlanId
  ctx.chatEngine?.closeAdmissionStore?.()
  ctx.chatEngine = undefined
  ctx.saveSessionState()
}
