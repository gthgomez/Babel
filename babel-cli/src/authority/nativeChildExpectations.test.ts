import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertNativeChildExit,
  oracleExitContract,
} from './nativeChildExpectations.js'

test('oracle exit contract documents pass, mismatch, and unsupported', () => {
  assert.deepEqual(oracleExitContract(), [0, 1, 2])
})

test('probe mode rejects intentional oracle mismatch exit 1', () => {
  assert.throws(
    () => assertNativeChildExit('probe', 1, '', '{"status":"failed"}'),
    /probe exit 1/,
  )
})

test('oracle mode accepts mismatch exit 1 for red control observation', () => {
  assertNativeChildExit(
    'oracle',
    1,
    '',
    '{"schema_version":1,"status":"failed","reason_code":"literal_mismatch"}',
  )
})

test('oracle mode rejects unknown exit codes and preserves stderr diagnostics', () => {
  assert.throws(
    () => assertNativeChildExit('oracle', 3, 'diag line', '{}'),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      return /must be 0, 1, or 2/.test(message) && message.includes('diag line')
    },
  )
})
