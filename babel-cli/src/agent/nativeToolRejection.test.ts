import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeNativeToolRejection } from './nativeToolRejection.js'

test('rejected native arguments never persist arbitrary command or source values', () => {
  const canary = 'synthetic-sensitive-assignment'
  const record = describeNativeToolRejection({ turn: 1, id: 'call-1', name: 'write_file',
    input: { content: `OPENROUTER_API_KEY=${canary}`, command: `CUSTOM_SECRET=${canary}`, path: 42 },
    reason: 'arguments_schema_invalid', issues: [{ code: 'invalid_type', path: ['path'] }] })
  const json = JSON.stringify(record)
  assert.equal(json.includes(canary), false, 'diagnostic contains values')
  assert.equal(json.includes('OPENROUTER_API_KEY'), false)
  assert.equal(record.dispatched, false)
  assert.match(String(record.input_sha256), /^[a-f0-9]{64}$/)
  assert.deepEqual(record.issues, [{ code: 'invalid_type', path: ['path'] }])
})
