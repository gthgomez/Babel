import assert from 'node:assert/strict'
import test from 'node:test'
import { stringifyBdns, toSafeBdnsValue } from './serialization.js'

test('serializes bigint, buffers, errors, and circular values safely', () => {
  const circular: Record<string, unknown> = { count: 1n, buffer: Buffer.from('ok') }
  circular.self = circular
  circular.error = new Error('api_key=secret-value')

  const value = toSafeBdnsValue(circular) as Record<string, unknown>
  assert.equal(value.count, '1n')
  assert.deepEqual(value.buffer, { type: 'Buffer', base64: 'b2s=' })
  assert.equal(value.self, '[Circular]')
  assert.match(String((value.error as Record<string, unknown>).message), /\[REDACTED\]/)
  assert.doesNotThrow(() => stringifyBdns(circular))
})
