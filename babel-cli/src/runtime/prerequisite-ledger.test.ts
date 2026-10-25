import assert from 'node:assert/strict'
import test from 'node:test'
import { PrerequisiteLedger } from './prerequisite-ledger.js'

test('recorded blocker stays unchanged until revision changes', () => {
  const ledger = new PrerequisiteLedger()
  ledger.record({
    key: 'sandbox:isolation',
    revision: 'rev-a',
    reasonCode: 'SANDBOX_PROBE_FAILED',
    remediation: 'Configure Docker image and probe',
  })
  assert.equal(ledger.isUnchanged('sandbox:isolation', 'rev-a'), true)
  assert.equal(ledger.isUnchanged('sandbox:isolation', 'rev-b'), false)
  assert.equal(ledger.pending().length, 1)
  ledger.resolve('sandbox:isolation', 'rev-b')
  assert.equal(ledger.pending().length, 0)
})

test('unrelated keys do not clear an active blocker', () => {
  const ledger = new PrerequisiteLedger()
  ledger.record({ key: 'workspace:dirty-target', revision: '1', reasonCode: 'DIRTY_TARGET' })
  ledger.resolve('shell:grant', '2')
  assert.equal(ledger.pending().length, 1)
  assert.equal(ledger.isUnchanged('workspace:dirty-target', '1'), true)
})
