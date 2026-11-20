// License: Apache-2.0 - see LICENSE
import assert from 'node:assert/strict'
import test from 'node:test'

import { requiredTapTimeoutArgs } from './required_tap_timeout_args.mjs'

test('forwards the workflow per-test timeout in its equals form', () => {
  assert.deepEqual(requiredTapTimeoutArgs(['--test-timeout=60000']), ['--test-timeout=60000'])
})

test('forwards the separated form and normalizes it', () => {
  assert.deepEqual(requiredTapTimeoutArgs(['--test-timeout', '45000']), ['--test-timeout=45000'])
})

test('ignores unrelated and malformed arguments', () => {
  assert.deepEqual(requiredTapTimeoutArgs(['--watch', '--test-timeout=abc', '--test-timeout']), [])
  assert.deepEqual(requiredTapTimeoutArgs(['--test-timeout=0']), ['--test-timeout=0'])
})

test('deduplicates repeated requests', () => {
  assert.deepEqual(
    requiredTapTimeoutArgs(['--test-timeout=1000', '--test-timeout', '1000']),
    ['--test-timeout=1000'],
  )
})
