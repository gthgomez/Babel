import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import { buildBootstrapPlanRevision } from './planFromModelOutput.js'

export interface EnsureAdmittedBootstrapPlanShellResult {
  handle: ResearchStoreMissionHandle
  bootstrapPlanRevisionId: string
  /** False when an active plan revision was already present. */
  appended_shell: boolean
}

/**
 * Admit the host bootstrap plan shell before model planning so admitted runs always have a
 * durable active plan revision (honest shell — not fabricated research findings).
 */
export async function ensureAdmittedBootstrapPlanShell(params: {
  store: ResearchStore
  mission: ResearchMissionV2
  handle: ResearchStoreMissionHandle
  planRevisionId: string
  bootstrapPlanRevisionId?: string
  createdAt: string
}): Promise<EnsureAdmittedBootstrapPlanShellResult> {
  const fence = params.store.readMissionWriteFence(params.mission.mission_id)
  if (fence.active_plan_revision_id) {
    return {
      handle: params.handle,
      bootstrapPlanRevisionId: fence.active_plan_revision_id,
      appended_shell: false,
    }
  }
  const acquired = await params.store.acquireWriterOwnership({
    mission_id: params.handle.mission_id,
    expected_writer_generation: params.handle.writer_generation,
  })
  const bootstrapPlanRevisionId =
    params.bootstrapPlanRevisionId ?? `${params.planRevisionId}-bootstrap`
  const ctx: MissionWriteContext = {
    mission_id: acquired.mission_id,
    plan_revision_id: bootstrapPlanRevisionId,
    writer_generation: acquired.writer_generation,
  }
  await params.store.appendPlanRevision(
    ctx,
    buildBootstrapPlanRevision({
      mission: params.mission,
      planRevisionId: bootstrapPlanRevisionId,
      createdAt: params.createdAt,
    }),
  )
  return {
    handle: acquired,
    bootstrapPlanRevisionId,
    appended_shell: true,
  }
}
