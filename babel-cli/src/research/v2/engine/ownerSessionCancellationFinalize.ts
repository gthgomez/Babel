import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { ResearchEngineSession } from './researchEngineSession.js'
import { finalizeOwnerResearchRunCancellation } from './finalizeOwnerResearchRunCancellation.js'

/**
 * Shared owner teardown: settle cancelled work when aborted, then always close the owner.
 * Closes even when finalization throws (finalize error is rethrown after close).
 */
export async function finalizeCancelledOwnerRunAndClose(params: {
  owner?: ResearchEngineSession | undefined
  mission: ResearchMissionV2
  missionAppended: boolean
  signal: AbortSignal
}): Promise<void> {
  const { owner, mission, missionAppended, signal } = params
  if (!owner) return
  let finalizeError: unknown
  if (signal.aborted && missionAppended) {
    try {
      await finalizeOwnerResearchRunCancellation({
        store: owner.store,
        mission,
      })
    } catch (err) {
      finalizeError = err
    }
  }
  try {
    await owner.close()
  } catch (closeErr) {
    if (finalizeError) throw finalizeError
    throw closeErr
  }
  if (finalizeError) throw finalizeError
}
