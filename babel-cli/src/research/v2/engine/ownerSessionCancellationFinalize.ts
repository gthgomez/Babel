import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { ResearchEngineSession } from './researchEngineSession.js'
import {
  finalizeOwnerResearchRunCancellation,
  type OwnerResearchRunCancellationFinalizeOutcome,
} from './finalizeOwnerResearchRunCancellation.js'

export type CancelledOwnerRunCloseOutcome =
  | { cancellation_finalize: 'not_attempted' }
  | { cancellation_finalize: OwnerResearchRunCancellationFinalizeOutcome }

/**
 * Shared owner teardown: settle cancelled work when aborted, then always close the owner.
 * When cancel happens before any plan revision exists (no bootstrap shell admitted),
 * finalization returns `pre_bootstrap_no_active_plan` and does not append a terminal receipt.
 * Closes even when finalization throws (finalize error is rethrown after close).
 */
export async function finalizeCancelledOwnerRunAndClose(params: {
  owner?: ResearchEngineSession | undefined
  mission: ResearchMissionV2
  missionAppended: boolean
  signal: AbortSignal
}): Promise<CancelledOwnerRunCloseOutcome> {
  const { owner, mission, missionAppended, signal } = params
  if (!owner) return { cancellation_finalize: 'not_attempted' }
  let finalizeError: unknown
  let cancellationFinalize: CancelledOwnerRunCloseOutcome = {
    cancellation_finalize: 'not_attempted',
  }
  if (signal.aborted && missionAppended) {
    try {
      cancellationFinalize = {
        cancellation_finalize: await finalizeOwnerResearchRunCancellation({
          store: owner.store,
          mission,
        }),
      }
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
  return cancellationFinalize
}
