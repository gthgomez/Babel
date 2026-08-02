import assert from 'node:assert/strict'
import test from 'node:test'

import { assertEffectAllowed, assertTerminalAllowed } from './modeController.js'

test('plan controller boundary denies every classified mutation and shell effect', () => {
  assert.doesNotThrow(() => assertEffectAllowed('plan', 'read_file'))
  assert.throws(() => assertEffectAllowed('plan', 'write_file'), /denied/)
  assert.throws(() => assertEffectAllowed('plan', 'run_command'), /denied/)
  assert.throws(() => assertEffectAllowed('plan', 'test_run'), /denied/)
})

test('mode controller boundary keeps plan and executor terminal vocabularies separate', () => {
  assert.doesNotThrow(() => assertTerminalAllowed('plan', 'PLAN_COMPLETE'))
  assert.throws(() => assertTerminalAllowed('plan', 'VERIFIED_COMPLETE'), /cannot emit/)
  assert.throws(() => assertTerminalAllowed('chat', 'PLAN_COMPLETE'), /cannot emit/)
  assert.doesNotThrow(() => assertTerminalAllowed('deep', 'UNVERIFIED_PATCH'))
})
