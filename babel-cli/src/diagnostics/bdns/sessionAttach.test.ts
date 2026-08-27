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
import {
  closeAllBdnsSessions,
  hasAttachedBdnsSession,
  waitForBdnsSession,
} from './sessionAttach.js'

test('attaches a session-owned BDNS runtime after canonical flush without delaying finalize', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'bdns-enable-'))
  const rt = createParityRuntime('bdns-enable-session')
  try {
    parityOnUserTurn(rt, {
      task: 'inspect the repo',
      model: 'test-model',
      provider: 'test-provider',
      projectRoot: runDir,
    })
    const started = performance.now()
    finalizeParityTurnSync(rt, runDir, 'CANCELLED', 'cancelled')
    const elapsed = performance.now() - started
    assert.ok(elapsed < 250, `canonical finalize took ${elapsed.toFixed(1)}ms`)
    await waitForBdnsSession(rt.sessionEvents.session_id)
    const bundle = await loadBdnsDiagnosticBundle(runDir)
    assert.equal(bundle.status, 'available')
    assert.equal(hasAttachedBdnsSession(rt.sessionEvents.session_id), true)
    assert.doesNotMatch(JSON.stringify(bundle.summary), /claimSatisfied|acceptanceVerdict/)
  } finally {
    await closeAllBdnsSessions()
    await rm(runDir, { recursive: true, force: true })
  }
})
