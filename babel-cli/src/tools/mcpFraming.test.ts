import assert from 'node:assert/strict'
import test from 'node:test'

import {
  frameJsonRpcMessage,
  McpFrameLimitError,
  MCP_MAX_FRAME_BYTES,
  parseFramedMessages,
} from '../mcp/framing.js'

test('MCP stdio frames use newline-delimited JSON without Content-Length', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  const framed = frameJsonRpcMessage(body)

  assert.equal(framed, `${body}\n`)
  assert.doesNotMatch(framed, /content-length/i)
})

test('parseFramedMessages parses newline-delimited batches and remains split-safe', () => {
  const first = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  const second = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    result: { text: 'héllo 🌍' },
  })
  const batch = `${first}\n${second}\n`

  const complete = parseFramedMessages(Buffer.from(batch, 'utf8'))
  assert.deepEqual(
    complete.messages.map((message) => message['id']),
    [1, 2],
  )
  assert.equal((complete.messages[1]?.['result'] as Record<string, unknown>)['text'], 'héllo 🌍')
  assert.equal(complete.remainder.length, 0)

  const batchBytes = Buffer.from(batch, 'utf8')
  for (let split = 1; split < batchBytes.length; split += 7) {
    const partial = parseFramedMessages(batchBytes.subarray(0, split))
    assert.ok(partial.messages.length <= 2)
    const rest = parseFramedMessages(Buffer.concat([partial.remainder, batchBytes.subarray(split)]))
    assert.deepEqual(
      [...partial.messages, ...rest.messages].map((message) => message['id']),
      [1, 2],
    )
  }
})

test('parseFramedMessages keeps bounded legacy Content-Length input compatibility', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} })
  const legacy = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`

  const parsed = parseFramedMessages(Buffer.from(legacy, 'utf8'))
  assert.equal(parsed.messages.length, 1)
  assert.equal(parsed.messages[0]?.['id'], 0)
  assert.equal(parsed.parseErrors.length, 0)
})

test('parseFramedMessages reports malformed JSON without echoing the payload', () => {
  const parsed = parseFramedMessages(
    Buffer.from(
      '{"jsonrpc":"2.0","id":1,"result":{"leak":"MCP_FRAME_SENTINEL"}}\nnot-json\n[]\n',
      'utf8',
    ),
  )

  assert.equal(parsed.messages.length, 1)
  assert.deepEqual(parsed.parseErrors, [
    'Invalid JSON in MCP frame.',
    'MCP frame did not contain a JSON object.',
  ])
  assert.doesNotMatch(parsed.parseErrors.join(' '), /MCP_FRAME_SENTINEL/)
})

test('parseFramedMessages enforces frame and header memory ceilings', () => {
  const oversizedLine = Buffer.from(`${'a'.repeat(MCP_MAX_FRAME_BYTES + 1)}\n`, 'utf8')
  assert.throws(() => parseFramedMessages(oversizedLine), McpFrameLimitError)

  const oversizedPartial = Buffer.from('a'.repeat(MCP_MAX_FRAME_BYTES + 1), 'utf8')
  assert.throws(() => parseFramedMessages(oversizedPartial), McpFrameLimitError)

  const oversizedHeader = Buffer.from(`Content-Length: ${MCP_MAX_FRAME_BYTES + 1}\r\n\r\n`, 'utf8')
  assert.throws(() => parseFramedMessages(oversizedHeader), McpFrameLimitError)
})

test('frameJsonRpcMessage refuses to emit an oversized frame', () => {
  assert.throws(() => frameJsonRpcMessage('a'.repeat(MCP_MAX_FRAME_BYTES + 1)), McpFrameLimitError)
})
