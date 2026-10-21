import { access, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DURABLE_RESEARCH_STORE_SNAPSHOT_FILE,
  DurableResearchStore,
} from '../persistence/durableResearchStore.js'
import { loadStoreInnerFromSnapshotFile } from '../persistence/loadStoreSnapshot.js'
import {
  RESEARCH_STORE_EXCLUSIVE_LOCK_FILE,
  readExclusiveStoreLockPayload,
} from '../persistence/storeDirectoryLock.js'
import {
  RESEARCH_STORE_CONTROL_FILE,
  StoreControlRecordSchema,
  type StoreControlRecord,
} from './storeControlRecord.js'
import type { ResearchStoreEvent } from '../ports/researchStore.js'

export class StoreAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoreAdmissionError'
  }
}

const RECOVERY_GATE_FILE = '.research-store.stale-recovery.gate'

/** @internal Deterministic handoff race regression — pauses after match, before unlink. */
let pauseBeforeOwnedControlUnlinkForTest: (() => Promise<void>) | undefined

export function setPauseBeforeOwnedControlUnlinkForTest(
  hook: (() => Promise<void>) | undefined,
): void {
  pauseBeforeOwnedControlUnlinkForTest = hook
}

function assertPidConfirmedDead(pid: number, label: string): void {
  try {
    process.kill(pid, 0)
    throw new StoreAdmissionError(`${label} pid ${pid} is still alive; stale recovery denied`)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ESRCH') return
    if (code === 'EPERM') {
      throw new StoreAdmissionError(`${label} pid ${pid} is still alive; stale recovery denied`)
    }
    throw new StoreAdmissionError(
      `cannot verify ${label} pid ${pid}: ${code ?? 'unknown'} (fail closed)`,
    )
  }
}

async function readControlRecord(storeDirectory: string): Promise<StoreControlRecord | null> {
  const controlPath = join(storeDirectory, RESEARCH_STORE_CONTROL_FILE)
  try {
    const raw = await readFile(controlPath, 'utf8')
    return StoreControlRecordSchema.parse(JSON.parse(raw))
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return null
    throw err
  }
}

async function writeControlRecord(storeDirectory: string, record: StoreControlRecord): Promise<void> {
  const controlPath = join(storeDirectory, RESEARCH_STORE_CONTROL_FILE)
  const tmp = `${controlPath}.tmp`
  await writeFile(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  await rename(tmp, controlPath)
}

export async function removeOwnedSessionControlRecord(
  storeDirectory: string,
  sessionId: string,
  releaseToken: string,
): Promise<void> {
  const control = await readControlRecord(storeDirectory)
  if (!control) return
  if (control.session_id !== sessionId || control.release_token !== releaseToken) return
  await pauseBeforeOwnedControlUnlinkForTest?.()
  await unlink(join(storeDirectory, RESEARCH_STORE_CONTROL_FILE)).catch(() => undefined)
}

async function withStaleRecoveryGate<T>(storeDirectory: string, fn: () => Promise<T>): Promise<T> {
  const gatePath = join(storeDirectory, RECOVERY_GATE_FILE)
  const gateToken = randomUUID()
  let gateHandle: Awaited<ReturnType<typeof open>> | null = null
  try {
    gateHandle = await open(gatePath, 'wx')
    await gateHandle.writeFile(`${gateToken}\n`, 'utf8')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EEXIST') {
      throw new StoreAdmissionError('stale recovery already in progress')
    }
    throw err
  }
  try {
    return await fn()
  } finally {
    if (gateHandle) {
      await gateHandle.close()
      await unlink(gatePath).catch(() => undefined)
    }
  }
}

function assertLockMatchesControl(
  lock: NonNullable<Awaited<ReturnType<typeof readExclusiveStoreLockPayload>>>,
  control: StoreControlRecord,
): void {
  if (lock.session_id !== control.session_id || lock.pid !== control.pid) {
    throw new StoreAdmissionError(
      'exclusive lock payload does not match session control record',
    )
  }
}

export interface StaleOwnerRecoveryAdmission {
  host_authorization_ref: string
  acknowledged_session_id: string
}

/**
 * Admitted recovery when an exclusive lock outlived its owner process (not routine lock deletion).
 */
export async function admitStaleExclusiveLockRecovery(
  storeDirectory: string,
  admission: StaleOwnerRecoveryAdmission,
): Promise<void> {
  if (!admission.host_authorization_ref.trim()) {
    throw new StoreAdmissionError('stale recovery requires host_authorization_ref')
  }

  await withStaleRecoveryGate(storeDirectory, async () => {
    const control = await readControlRecord(storeDirectory)
    if (!control) {
      throw new StoreAdmissionError('stale recovery requires existing session control record')
    }
    if (control.session_id !== admission.acknowledged_session_id) {
      throw new StoreAdmissionError('acknowledged_session_id does not match control record')
    }

    const lockPath = join(storeDirectory, RESEARCH_STORE_EXCLUSIVE_LOCK_FILE)
    try {
      await access(lockPath)
    } catch {
      throw new StoreAdmissionError('stale recovery requires orphaned exclusive lock')
    }

    const lock = await readExclusiveStoreLockPayload(storeDirectory)
    if (!lock) {
      throw new StoreAdmissionError('stale recovery requires readable exclusive lock payload')
    }
    assertLockMatchesControl(lock, control)

    assertPidConfirmedDead(control.pid, 'control')
    assertPidConfirmedDead(lock.pid, 'lock')

    const lockAfter = await readExclusiveStoreLockPayload(storeDirectory)
    const controlAfter = await readControlRecord(storeDirectory)
    if (!lockAfter || !controlAfter) {
      throw new StoreAdmissionError('stale recovery state changed during admission')
    }
    assertLockMatchesControl(lockAfter, controlAfter)
    if (
      controlAfter.session_id !== admission.acknowledged_session_id ||
      controlAfter.session_id !== control.session_id
    ) {
      throw new StoreAdmissionError('stale recovery control record changed during admission')
    }
    assertPidConfirmedDead(controlAfter.pid, 'control')
    assertPidConfirmedDead(lockAfter.pid, 'lock')

    await unlink(lockPath)
  })
}

export interface OwnerStoreSession {
  store: DurableResearchStore
  sessionId: string
  close(): Promise<void>
}

/** Single-owner writable session (exclusive lock + control record). */
export async function openAdmittedOwnerStore(storeDirectory: string): Promise<OwnerStoreSession> {
  const sessionId = randomUUID()
  const releaseToken = randomUUID()
  let store: DurableResearchStore | null = null
  try {
    store = await DurableResearchStore.open(storeDirectory, { ownerSessionId: sessionId })
    const record: StoreControlRecord = {
      schema_version: 1,
      session_id: sessionId,
      pid: process.pid,
      opened_at: new Date().toISOString(),
      release_token: releaseToken,
    }
    await writeControlRecord(storeDirectory, record)
  } catch (err) {
    if (store) {
      await store.close().catch(() => undefined)
    }
    throw err
  }

  const boundStore = store
  return {
    store: boundStore,
    sessionId,
    async close() {
      await boundStore.close(async () => {
        await removeOwnedSessionControlRecord(storeDirectory, sessionId, releaseToken)
      })
    },
  }
}

export interface InspectStoreView {
  listEvents(missionId: string): Promise<readonly ResearchStoreEvent[]>
  sessionControl: StoreControlRecord | null
}

/** Read-only inspect without acquiring the exclusive owner lock (second CLI / cancel review). */
export async function openAdmittedInspectStore(storeDirectory: string): Promise<InspectStoreView> {
  const snapshotPath = join(storeDirectory, DURABLE_RESEARCH_STORE_SNAPSHOT_FILE)
  const inner = await loadStoreInnerFromSnapshotFile(snapshotPath)
  const sessionControl = await readControlRecord(storeDirectory)
  return {
    sessionControl,
    listEvents: (missionId: string) => inner.listEvents(missionId),
  }
}
