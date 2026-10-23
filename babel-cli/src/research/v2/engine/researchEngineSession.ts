import type { MissionWriteContext } from '../contracts/common.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { ResearchReportV2 } from '../contracts/plan.js'
import type { ResearchContinuationResume } from '../contracts/storeLifecycle.js'
import type { ResearchModelPort } from '../ports/researchModelPort.js'
import type { ResearchStore, ResearchStoreMissionHandle } from '../ports/researchStore.js'
import type { DurableResearchStore } from '../persistence/durableResearchStore.js'
import {
  admitStaleExclusiveLockRecovery,
  openAdmittedInspectStore,
  openAdmittedOwnerStore,
  type InspectStoreView,
  type OwnerStoreSession,
  type StaleOwnerRecoveryAdmission,
} from '../control/researchStoreAdmission.js'
import {
  readAdmittedOwnerCancelRequest,
  submitAdmittedOwnerCancelRequest,
  watchAdmittedOwnerCancelRequest,
  type StoreCancelRequest,
} from '../control/storeCancelRequest.js'

export interface ResearchEngineSessionOptions {
  storeDirectory: string
  model: ResearchModelPort
}

/**
 * Test-first engine/control slice: single admitted owner store + inspect + stale recovery hooks.
 * No live network; canonical cancel/resume uses store contracts only.
 */
export class ResearchEngineSession {
  private constructor(
    private readonly storeDirectory: string,
    private readonly owner: OwnerStoreSession,
    readonly model: ResearchModelPort,
  ) {}

  get store(): DurableResearchStore {
    return this.owner.store
  }

  get sessionId(): string {
    return this.owner.sessionId
  }

  static async openOwner(options: ResearchEngineSessionOptions): Promise<ResearchEngineSession> {
    const owner = await openAdmittedOwnerStore(options.storeDirectory)
    return new ResearchEngineSession(options.storeDirectory, owner, options.model)
  }

  static openInspect(storeDirectory: string): Promise<InspectStoreView> {
    return openAdmittedInspectStore(storeDirectory)
  }

  static admitStaleOwnerRecovery(
    storeDirectory: string,
    admission: StaleOwnerRecoveryAdmission,
  ): Promise<void> {
    return admitStaleExclusiveLockRecovery(storeDirectory, admission)
  }

  static submitExternalCancelRequest(
    storeDirectory: string,
    targetSessionId: string,
  ): Promise<StoreCancelRequest> {
    return submitAdmittedOwnerCancelRequest(storeDirectory, targetSessionId)
  }

  watchExternalCancelRequests(abortController: AbortController): { stop(): void } {
    return watchAdmittedOwnerCancelRequest(
      this.storeDirectory,
      this.sessionId,
      abortController,
    )
  }

  /** Cancel-request file still targets this owner (AbortSignal may lag on slow hosts). */
  async externalCancelTargetsThisSession(): Promise<boolean> {
    const request = await readAdmittedOwnerCancelRequest(this.storeDirectory)
    return request?.target_session_id === this.sessionId
  }

  async close(): Promise<void> {
    await this.owner.close()
  }

  async appendMission(mission: ResearchMissionV2): Promise<ResearchStoreMissionHandle> {
    return this.owner.store.appendMission(mission)
  }

  async acquireWriterOwnership(
    request: Parameters<ResearchStore['acquireWriterOwnership']>[0],
  ): Promise<ResearchStoreMissionHandle> {
    return this.owner.store.acquireWriterOwnership(request)
  }

  async appendTerminalReport(
    ctx: MissionWriteContext,
    report: ResearchReportV2,
  ): Promise<void> {
    await this.owner.store.appendTerminalReport(ctx, report)
  }

  async resumeResearchContinuation(
    request: ResearchContinuationResume,
  ): Promise<ResearchStoreMissionHandle> {
    return this.owner.store.resumeResearchContinuation(request)
  }
}
