import assert from 'node:assert/strict'
import test from 'node:test'

import {
  frameLspMessage,
  LspFrameLimitError,
  LSP_MAX_HEADER_BYTES,
  LSP_MAX_MESSAGE_BYTES,
  parseLspMessages,
} from './framing.js'

test('LSP frames use Content-Length headers and round-trip', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  const framed = frameLspMessage(body)

  assert.match(framed, /^Content-Length: \d+\r\n\r\n/u)
  const parsed = parseLspMessages(Buffer.from(framed, 'utf8'))
  assert.deepEqual(parsed.messages, [{ jsonrpc: '2.0', id: 1, result: { ok: true } }])
  assert.equal(parsed.remainder.length, 0)
})

test('LSP parser handles split and multi-frame input', () => {
  const one = frameLspMessage(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'héllo 🌍' } }),
  )
  const two = frameLspMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, result: null }))
  const bytes = Buffer.from(`${one}${two}`, 'utf8')

  for (let split = 1; split < bytes.length; split += 11) {
    const first = parseLspMessages(bytes.subarray(0, split))
    const rest = parseLspMessages(Buffer.concat([first.remainder, bytes.subarray(split)]))
    assert.deepEqual(
      [...first.messages, ...rest.messages].map((message) => message['id']),
      [1, 2],
    )
  }
})

test('LSP parser enforces complete-header memory ceilings', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: null })
  const oversizedHeader =
    `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n` +
    `X-Pad: ${'a'.repeat(LSP_MAX_HEADER_BYTES)}\r\n\r\n${body}`

  assert.throws(() => parseLspMessages(Buffer.from(oversizedHeader, 'utf8')), LspFrameLimitError)
})

test('LSP parser enforces message and output ceilings', () => {
  assert.throws(() => frameLspMessage('a'.repeat(LSP_MAX_MESSAGE_BYTES + 1)), LspFrameLimitError)
  assert.throws(
    () =>
      parseLspMessages(Buffer.from(`Content-Length: ${LSP_MAX_MESSAGE_BYTES + 1}\r\n\r\n`, 'utf8')),
    LspFrameLimitError,
  )
})
