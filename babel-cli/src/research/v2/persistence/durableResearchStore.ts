import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MissionWriteContext } from '../contracts/common.js'
import type { FindingRecord } from '../contracts/findings.js'
import type {
  ExternalOperationCompletion,
  ExternalOperationIntent,
  ExternalOperationReconciliation,
} from '../contracts/operations.js'
import type { PlanRevision, ResearchReportV2 } from '../contracts/plan.js'
import type { PassageRecord } from '../contracts/passages.js'
import type { ResearchMissionV2 } from '../contracts/mission.js'
import type { SourceRecord, SourceRevision } from '../contracts/sources.js'
import { InMemoryResearchStore } from '../fixtures/fakePorts.js'
import type { ModelRouteReceipt } from '../ports/researchModelPort.js'
import type {
  ResearchContinuationResume,
  WriterOwnershipAcquire,
} from '../contracts/storeLifecycle.js'
import type {
  ResearchStore,
  ResearchStoreEvent,
  ResearchStoreMissionHandle,
  ResearchStoreWriteResult,
} from '../ports/researchStore.js'
import { loadStoreInnerFromSnapshotFile } from './loadStoreSnapshot.js'
import { MutationQueue } from './mutationQueue.js'
import { acquireExclusiveStoreLock } from './storeDirectoryLock.js'

export const DURABLE_RESEARCH_STORE_SNAPSHOT_FILE = 'research-store.snapshot.json'

/** @internal Regression hook — delays persist between stage and rename. */
let durableStoreFlushDelayMsForTest = 0

export function setDurableStoreFlushDelayMsForTest(ms: number): void {
  durableStoreFlushDelayMsForTest = ms
}

/**
 * File-backed {@link ResearchStore} — exclusive directory lock, staged commit, validated reload.
 */
export class DurableResearchStore implements ResearchStore {
  private inner: InMemoryResearchStore
  private readonly mutationQueue = new MutationQueue()
  private closed = false

  private constructor(
    inner: InMemoryResearchStore,
    private readonly snapshotPath: string,
    private readonly releaseExclusiveLock: () => Promise<void>,
  ) {
    this.inner = inner
  }

  static async open(
    storeDirectory: string,
    options?: { ownerSessionId?: string },
  ): Promise<DurableResearchStore> {
    await mkdir(storeDirectory, { recursive: true })
    const sessionId = options?.ownerSessionId ?? randomUUID()
    const releaseExclusiveLock = await acquireExclusiveStoreLock(storeDirectory, {
      session_id: sessionId,
      pid: process.pid,
    })
    const snapshotPath = join(storeDirectory, DURABLE_RESEARCH_STORE_SNAPSHOT_FILE)
    try {
      const inner = await loadStoreInnerFromSnapshotFile(snapshotPath)
      return new DurableResearchStore(inner, snapshotPath, releaseExclusiveLock)
    } catch (err) {
      await releaseExclusiveLock()
      throw err
    }
  }

  async close(beforeExclusiveLockRelease?: () => Promise<void>): Promise<void> {
    if (this.closed) return
    await this.mutationQueue.drain()
    if (beforeExclusiveLockRelease) {
      await beforeExclusiveLockRelease()
    }
    this.closed = true
    await this.releaseExclusiveLock()
  }

  /** @internal Regression — drain writes without releasing the directory exclusive lock. */
  async drainMutationsForClose(): Promise<void> {
    await this.mutationQueue.drain()
  }

  /** @internal Regression — release lock after {@link drainMutationsForClose} (skips owner control cleanup). */
  async releaseExclusiveLockForClose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.releaseExclusiveLock()
  }

  /** Test/diagnostic — new handle; requires this instance to be closed first. */
  async reloadFresh(): Promise<DurableResearchStore> {
    const dir = join(this.snapshotPath, '..')
    return DurableResearchStore.open(dir)
  }

  private async flushSnapshot(staged: InMemoryResearchStore): Promise<void> {
    const snapshot = staged.exportSnapshot()
    const payload = `${JSON.stringify(snapshot)}\n`
    const tmpPath = `${this.snapshotPath}.tmp`
    if (durableStoreFlushDelayMsForTest > 0) {
      await new Promise((resolve) => setTimeout(resolve, durableStoreFlushDelayMsForTest))
    }
    await writeFile(tmpPath, payload, { encoding: 'utf8', flag: 'w' })
    await rename(tmpPath, this.snapshotPath)
  }

  private async reloadInnerFromDisk(): Promise<void> {
    this.inner = await loadStoreInnerFromSnapshotFile(this.snapshotPath)
  }

  private mutate<T>(apply: (staged: InMemoryResearchStore) => Promise<T>): Promise<T> {
    return this.mutationQueue.enqueue(async () => {
      if (this.closed) {
        throw new Error('durable research store is closed')
      }
      const staged = InMemoryResearchStore.restoreSnapshot(this.inner.exportSnapshot())
      const result = await apply(staged)
      try {
        await this.flushSnapshot(staged)
      } catch (err) {
        await this.reloadInnerFromDisk()
        throw err
      }
      this.inner = staged
      return result
    })
  }

  appendMission(mission: ResearchMissionV2): Promise<ResearchStoreMissionHandle> {
    return this.mutate((staged) => staged.appendMission(mission))
  }

  acquireWriterOwnership(request: WriterOwnershipAcquire): Promise<ResearchStoreMissionHandle> {
    return this.mutate((staged) => staged.acquireWriterOwnership(request))
  }

  resumeResearchContinuation(
    request: ResearchContinuationResume,
  ): Promise<ResearchStoreMissionHandle> {
    return this.mutate((staged) => staged.resumeResearchContinuation(request))
  }

  replaceWriterOwnership(
    ctx: MissionWriteContext,
    rationale: string,
  ): Promise<ResearchStoreMissionHandle> {
    return this.mutate((staged) => staged.replaceWriterOwnership(ctx, rationale))
  }

  releaseWriterOwnership(ctx: MissionWriteContext): Promise<void> {
    return this.mutate((staged) => staged.releaseWriterOwnership(ctx))
  }

  appendPlanRevision(
    ctx: MissionWriteContext,
    plan: PlanRevision,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendPlanRevision(ctx, plan))
  }

  appendSource(ctx: MissionWriteContext, source: SourceRecord): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendSource(ctx, source))
  }

  appendSourceRevision(
    ctx: MissionWriteContext,
    revision: SourceRevision,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendSourceRevision(ctx, revision))
  }

  appendPassage(
    ctx: MissionWriteContext,
    passage: PassageRecord,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendPassage(ctx, passage))
  }

  appendFinding(
    ctx: MissionWriteContext,
    finding: FindingRecord,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendFinding(ctx, finding))
  }

  appendModelReceipt(
    ctx: MissionWriteContext,
    receipt: ModelRouteReceipt,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendModelReceipt(ctx, receipt))
  }

  appendExternalOperationIntent(
    ctx: MissionWriteContext,
    intent: ExternalOperationIntent,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendExternalOperationIntent(ctx, intent))
  }

  appendExternalOperationCompleted(
    ctx: MissionWriteContext,
    completion: ExternalOperationCompletion,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendExternalOperationCompleted(ctx, completion))
  }

  appendExternalOperationReconciled(
    ctx: MissionWriteContext,
    reconciliation: ExternalOperationReconciliation,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendExternalOperationReconciled(ctx, reconciliation))
  }

  appendTerminalReport(
    ctx: MissionWriteContext,
    report: ResearchReportV2,
  ): Promise<ResearchStoreWriteResult> {
    return this.mutate((staged) => staged.appendTerminalReport(ctx, report))
  }

  listEvents(missionId: string): Promise<readonly ResearchStoreEvent[]> {
    return this.inner.listEvents(missionId)
  }
}
