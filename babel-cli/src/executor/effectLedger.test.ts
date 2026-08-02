import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  findInterruptedEffects,
  loadEffectLedger,
  reconcileInterruptedEffect,
  recordEffectIntent,
  recordEffectTerminal,
} from './effectLedger.js'

test('effect ledger persists intent before terminal state and tolerates torn final lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'babel-effect-ledger-'))
  try {
    const intent = recordEffectIntent({
      runDir: root,
      sessionId: 'session-1',
      turnId: 'turn-1',
      mutationBatchId: 'batch-1',
      effectClass: 'reconcilable_mutation',
      toolName: 'write_file',
      targetPaths: ['a.txt'],
      preImageHashes: { 'a.txt': 'before' },
      intendedContent: 'after',
    })
    assert.equal(findInterruptedEffects(loadEffectLedger(root)).length, 1)

    recordEffectTerminal(root, intent, {
      status: 'completed',
      postImageHashes: { 'a.txt': 'after' },
    })
    assert.equal(findInterruptedEffects(loadEffectLedger(root)).length, 0)

    const ledgerPath = join(root, 'effect-ledger.jsonl')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(ledgerPath, '{"schemaVersion":1')
    assert.equal(loadEffectLedger(root).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('effect reconciliation retries only safe pre-image matches and recognizes post-images', () => {
  const base = {
    schemaVersion: 1 as const,
    operationId: 'op-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    mutationBatchId: 'batch-1',
    effectClass: 'reconcilable_mutation' as const,
    toolName: 'write_file',
    targetPaths: ['a.txt'],
    preImageHashes: { 'a.txt': 'before' },
    postImageHashes: { 'a.txt': 'after' },
    status: 'intent' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  assert.equal(reconcileInterruptedEffect(base, { 'a.txt': 'before' }), 'retry_reconcilable')
  assert.equal(reconcileInterruptedEffect(base, { 'a.txt': 'after' }), 'recovered_complete')
  assert.equal(reconcileInterruptedEffect(base, { 'a.txt': 'other' }), 'workspace_conflict')
  assert.equal(
    reconcileInterruptedEffect({ ...base, effectClass: 'external_side_effect' }, { 'a.txt': 'before' }),
    'manual_review',
  )
})
