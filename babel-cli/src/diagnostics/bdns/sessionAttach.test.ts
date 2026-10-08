import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createParityRuntime,
  finalizeParityTurnSync,
  parityOnUserTurn,
} from '../../agent/chatEngineParityBridge.js'
import { loadBdnsDiagnosticBundle } from './reader.js'
import { BdnsRuntime } from './runtime.js'
import {
  closeAllBdnsSessions,
  hasAttachedBdnsSession,
  waitForBdnsSession,
} from './sessionAttach.js'

test('attaches a session-owned BDNS runtime after canonical flush without delaying finalize', async t => {
  const runDir = await mkdtemp(join(tmpdir(), 'bdns-enable-'))
  const rt = createParityRuntime('bdns-enable-session')
  let releasePersistence!: () => void
  let observePersistence!: () => void
  const persistenceGate = new Promise<void>(resolve => { releasePersistence = resolve })
  const persistenceStarted = new Promise<void>(resolve => { observePersistence = resolve })
  const flushPersistence = BdnsRuntime.prototype.flushPersistence
  const flushMock = t.mock.method(BdnsRuntime.prototype, 'flushPersistence', async function (this: BdnsRuntime) {
    observePersistence()
    await persistenceGate
    await flushPersistence.call(this)
  })
  try {
    parityOnUserTurn(rt, {
      task: 'inspect the repo',
      model: 'test-model',
      provider: 'test-provider',
      projectRoot: runDir,
    })
    assert.equal(finalizeParityTurnSync(rt, runDir, 'CANCELLED', 'cancelled'), undefined)
    await persistenceStarted
    let persistenceCompleted = false
    const pending = waitForBdnsSession(rt.sessionEvents.session_id).then(() => { persistenceCompleted = true })
    await Promise.resolve()
    assert.equal(persistenceCompleted, false, 'canonical finalize returned while BDNS persistence remains gated')
    releasePersistence()
    await pending
    flushMock.mock.restore()
    const bundle = await loadBdnsDiagnosticBundle(runDir)
    assert.equal(bundle.status, 'available')
    assert.equal(hasAttachedBdnsSession(rt.sessionEvents.session_id), true)
    assert.doesNotMatch(JSON.stringify(bundle.summary), /claimSatisfied|acceptanceVerdict/)
  } finally {
    releasePersistence()
    flushMock.mock.restore()
    await closeAllBdnsSessions()
    await rm(runDir, { recursive: true, force: true })
  }
})
