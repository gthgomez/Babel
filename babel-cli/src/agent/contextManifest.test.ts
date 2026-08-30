import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildContextManifest,
  validateContextManifest,
} from './contextManifest.js'

test('context manifest proves complete no-compaction delivery', () => {
  const manifest = buildContextManifest({
    inferenceId: 'inference-1',
    conversationState: ['system', 'tool-1'],
    systemPolicyPrompt: 'policy',
    userTaskPrompt: 'task',
    expectedPriorEventIds: ['tool-1'],
    deliveredPriorEventIds: ['tool-1'],
    deliveryMode: 'native',
    compactionOccurred: false,
  })

  validateContextManifest(manifest)
  assert.equal(manifest.preservation_status, true)
  assert.deepEqual(manifest.missing_event_ids, [])
  assert.equal(manifest.conversation_state_hash?.length, 64)
})

test('context manifest reports missing evidence after compaction', () => {
  const manifest = buildContextManifest({
    inferenceId: 'inference-2',
    expectedPriorEventIds: ['tool-1', 'tool-2'],
    deliveredPriorEventIds: ['tool-1'],
    deliveryMode: 'native',
    compactionOccurred: true,
    preservedEventIds: ['tool-1'],
  })

  validateContextManifest(manifest)
  assert.equal(manifest.preservation_status, false)
  assert.deepEqual(manifest.missing_event_ids, ['tool-2'])
})

test('unknown delivery mode remains unknown instead of becoming model blame', () => {
  const manifest = buildContextManifest({
    inferenceId: 'inference-3',
    expectedPriorEventIds: ['tool-1'],
    deliveryMode: 'unknown',
  })

  validateContextManifest(manifest)
  assert.equal(manifest.preservation_status, null)
  assert.deepEqual(manifest.missing_event_ids, [])
})
