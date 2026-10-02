import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatTaskAllowanceSnapshot } from './chatEngineContracts.js'
import { parseTaskAllowance } from './chatEngineTaskAllowance.js'

function checkpoint(): ChatTaskAllowanceSnapshot {
  return {
    schemaVersion: 2,
    taskOwnerId: 'owner-1',
    accountingEpoch: 'epoch-1',
    grant: {
      grantId: 'grant-1',
      provenance: 'fixture',
      costCap: { kind: 'finite', usd: 1 },
      wallCapMs: 1000,
      turnCap: 2,
    },
    consumed: { costUsd: 0.1, activeWallMs: 50, turns: 1 },
    repair: {
      criticRepairCostCapUsd: null,
      postWriteRepairWallCapMs: null,
      postWriteRepairRestrict: false,
    },
    accountedChargeIds: ['charge-1'],
    activeExecution: true,
    taskCostBaselineUsd: 0,
  }
}

test('restores allowance accounting without counting downtime as active execution', () => {
  const original = checkpoint()
  const restored = parseTaskAllowance(original)
  assert.ok(restored)
  assert.equal(restored.activeExecution, false)
  assert.equal(restored.consumed.activeWallMs, 50)
  assert.equal(restored.consumed.unknownChargeCount, 1)
  restored.accountedChargeIds.push('another-charge')
  assert.deepEqual(original.accountedChargeIds, ['charge-1'])
})

test('rejects corrupted accounting checkpoints instead of restoring spending authority', () => {
  const corruptions = [
    { taskOwnerId: '' },
    { accountingFaults: [{}] },
    { activeExecution: 'yes' },
    { consumed: { costUsd: -1, activeWallMs: 0, turns: 0 } },
    {
      grant: {
        ...checkpoint().grant,
        costCap: { kind: 'finite', usd: Infinity },
      },
    },
  ]
  for (const change of corruptions)
    assert.equal(parseTaskAllowance({ ...checkpoint(), ...change }), null)
})

test('retains explicit unlimited cost authority and known zero unknown charges', () => {
  const original = checkpoint()
  original.grant.costCap = { kind: 'unlimited' }
  original.consumed.unknownChargeCount = 0
  const restored = parseTaskAllowance(original)
  assert.deepEqual(restored?.grant.costCap, { kind: 'unlimited' })
  assert.equal(restored?.consumed.unknownChargeCount, 0)
})
