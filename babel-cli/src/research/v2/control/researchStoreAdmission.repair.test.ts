/**
 * Independent control review FIX — spawn-based crash/recovery, binding, cancel, cleanup.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { DurableStoreBusyError } from '../persistence/durableStoreErrors.js'
import { DurableResearchStore } from '../persistence/durableResearchStore.js'
import {
  readExclusiveStoreLockPayload,
  RESEARCH_STORE_EXCLUSIVE_LOCK_FILE,
} from '../persistence/storeDirectoryLock.js'
import {
  RESEARCH_STORE_CONTROL_FILE,
  StoreControlRecordSchema,
} from './storeControlRecord.js'
import {
  admitStaleExclusiveLockRecovery,
  openAdmittedOwnerStore,
  removeOwnedSessionControlRecord,
  setPauseBeforeOwnedControlUnlinkForTest,
  StoreAdmissionError,
} from './researchStoreAdmission.js'
import { readAdmittedOwnerCancelRequest } from './storeCancelRequest.js'
import { ResearchEngineSession } from '../engine/researchEngineSession.js'
import { FixtureResearchModelBridge } from '../model/fixtureModelBridge.js'

const testDir = dirname(fileURLToPath(import.meta.url))

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'babel-research-v2-control-'))
}

function runTsxWorker(
  scriptName: string,
  args: string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const scriptPath = join(testDir, 'testworkers', scriptName)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

describe('research store admission control repair', () => {
  it('releases exclusive lock when session control publication fails', async () => {
    const dir = await tempDir()
    const bogusControl = join(dir, RESEARCH_STORE_CONTROL_FILE)
    try {
      await mkdir(bogusControl)
      await assert.rejects(() => openAdmittedOwnerStore(dir))
      const probe = await DurableResearchStore.open(dir)
      await probe.close()
      await rm(bogusControl, { recursive: true, force: true })
      const owner = await openAdmittedOwnerStore(dir)
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('spawned child exit leaves bound lock; admitted recovery then new owner', async () => {
    const dir = await tempDir()
    try {
      const { code } = await runTsxWorker('ownerChildExit.ts', [dir])
      assert.equal(code, 0)
      const sessionId = (await readFile(join(dir, '.child-owner-session'), 'utf8')).trim()
      await admitStaleExclusiveLockRecovery(dir, {
        host_authorization_ref: 'host-ops/spawn-exit',
        acknowledged_session_id: sessionId,
      })
      const owner = await openAdmittedOwnerStore(dir)
      assert.notEqual(owner.sessionId, sessionId)
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('denies stale recovery when control is tampered but lock still names live owner pid', async () => {
    const dir = await tempDir()
    try {
      const owner = await openAdmittedOwnerStore(dir)
      const control = await readFile(join(dir, RESEARCH_STORE_CONTROL_FILE), 'utf8')
      const parsed = StoreControlRecordSchema.parse(JSON.parse(control))
      const tampered = StoreControlRecordSchema.parse({
        ...parsed,
        pid: 9_999_999,
      })
      await writeFile(join(dir, RESEARCH_STORE_CONTROL_FILE), `${JSON.stringify(tampered)}\n`, 'utf8')
      await assert.rejects(
        () =>
          admitStaleExclusiveLockRecovery(dir, {
            host_authorization_ref: 'host-ops/tamper',
            acknowledged_session_id: owner.sessionId,
          }),
        (e: unknown) =>
          e instanceof StoreAdmissionError &&
          e.message.includes('does not match session control record'),
      )
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('deterministic handoff race: new owner blocked until control removed under held lock', async () => {
    const dir = await tempDir()
    try {
      const owner = await openAdmittedOwnerStore(dir)
      let secondOpenRejected = false
      setPauseBeforeOwnedControlUnlinkForTest(async () => {
        try {
          await openAdmittedOwnerStore(dir)
        } catch (err: unknown) {
          if (err instanceof DurableStoreBusyError) {
            secondOpenRejected = true
          } else {
            throw err
          }
        }
      })
      await owner.close()
      setPauseBeforeOwnedControlUnlinkForTest(undefined)
      assert.equal(secondOpenRejected, true)
      const successor = await openAdmittedOwnerStore(dir)
      await successor.close()
    } finally {
      setPauseBeforeOwnedControlUnlinkForTest(undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('TOCTOU regression: legacy post-lock control removal after new owner open deletes successor', async () => {
    const dir = await tempDir()
    try {
      const first = await openAdmittedOwnerStore(dir)
      const firstControl = StoreControlRecordSchema.parse(
        JSON.parse(await readFile(join(dir, RESEARCH_STORE_CONTROL_FILE), 'utf8')),
      )
      await first.store.drainMutationsForClose()
      await first.store.releaseExclusiveLockForClose()

      let secondSessionId = ''
      setPauseBeforeOwnedControlUnlinkForTest(async () => {
        const second = await openAdmittedOwnerStore(dir)
        secondSessionId = second.sessionId
        await second.store.drainMutationsForClose()
        await second.store.releaseExclusiveLockForClose()
      })

      await removeOwnedSessionControlRecord(
        dir,
        firstControl.session_id,
        firstControl.release_token,
      )
      setPauseBeforeOwnedControlUnlinkForTest(undefined)

      const onDisk = await readFile(join(dir, RESEARCH_STORE_CONTROL_FILE), 'utf8').catch(() => null)
      assert.equal(onDisk, null, 'legacy read→open→unlink sequence must not retain successor control')
      assert.notEqual(secondSessionId, '')
    } finally {
      setPauseBeforeOwnedControlUnlinkForTest(undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stale owner close does not remove successor control or lock', async () => {
    const dir = await tempDir()
    try {
      const first = await openAdmittedOwnerStore(dir)
      const firstSession = first.sessionId
      const firstRelease = StoreControlRecordSchema.parse(
        JSON.parse(await readFile(join(dir, RESEARCH_STORE_CONTROL_FILE), 'utf8')),
      ).release_token

      const lock = await readExclusiveStoreLockPayload(dir)
      assert.ok(lock)
      const deadPid = 9_999_999
      const tamperedControl = StoreControlRecordSchema.parse({
        ...StoreControlRecordSchema.parse(
          JSON.parse(await readFile(join(dir, RESEARCH_STORE_CONTROL_FILE), 'utf8')),
        ),
        pid: deadPid,
      })
      await writeFile(
        join(dir, RESEARCH_STORE_EXCLUSIVE_LOCK_FILE),
        `${JSON.stringify({ schema_version: 1, session_id: firstSession, pid: deadPid })}\n`,
        'utf8',
      )
      await writeFile(
        join(dir, RESEARCH_STORE_CONTROL_FILE),
        `${JSON.stringify(tamperedControl)}\n`,
        'utf8',
      )

      await admitStaleExclusiveLockRecovery(dir, {
        host_authorization_ref: 'host-ops/handoff',
        acknowledged_session_id: firstSession,
      })

      const second = await openAdmittedOwnerStore(dir)
      const secondControlRaw = await readFile(join(dir, RESEARCH_STORE_CONTROL_FILE), 'utf8')
      const secondControl = StoreControlRecordSchema.parse(JSON.parse(secondControlRaw))

      await first.close()

      const afterStaleClose = StoreControlRecordSchema.parse(
        JSON.parse(await readFile(join(dir, RESEARCH_STORE_CONTROL_FILE), 'utf8')),
      )
      assert.equal(afterStaleClose.session_id, secondControl.session_id)
      assert.equal(afterStaleClose.release_token, secondControl.release_token)
      assert.notEqual(afterStaleClose.release_token, firstRelease)

      await assert.rejects(
        () => DurableResearchStore.open(dir),
        (e: unknown) => e instanceof DurableStoreBusyError,
      )

      await second.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('two-process external cancel request reaches owner AbortController', async () => {
    const dir = await tempDir()
    const model = new FixtureResearchModelBridge()
    try {
      const owner = await ResearchEngineSession.openOwner({ storeDirectory: dir, model })
      const abortController = new AbortController()
      const watcher = owner.watchExternalCancelRequests(abortController)

      const childPromise = runTsxWorker('submitCancelChild.ts', [dir, owner.sessionId])
      await childPromise
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 2_000
        const tick = (): void => {
          if (abortController.signal.aborted) {
            resolve()
            return
          }
          if (Date.now() > deadline) {
            assert.fail('owner did not observe external cancel request')
            return
          }
          setTimeout(tick, 10)
        }
        tick()
      })
      watcher.stop()

      const leftover = await readAdmittedOwnerCancelRequest(dir)
      assert.equal(leftover, null)
      await owner.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
