import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatTextToolResults,
  parseChatTurnLenient,
  wrapPresentationCallbacks,
} from './chatEngineHelpers.js'

test('retains prose and answer-bearing near misses when the provider omits the chat schema', () => {
  assert.deepEqual(parseChatTurnLenient('  explanatory answer  '), {
    type: 'completion',
    answer: 'explanatory answer',
  })
  assert.deepEqual(
    parseChatTurnLenient('{"type":"unknown","answer":"useful answer"}'),
    { type: 'completion', answer: 'useful answer' },
  )
  const empty = parseChatTurnLenient(' ')
  assert.ok(empty.type === 'completion')
  assert.match(empty.answer, /could not produce a valid response/)
})

test('retains bounded child provenance even when the child reports a nonzero exit', () => {
  const evidence = `${'context '.repeat(100)}\nauthority: parent-owned\nevidence: receipt-1`
  const rendered = formatTextToolResults([
    {
      tool: 'sub_agent',
      target: 'child',
      detail: 'blocked',
      exit_code: 1,
      stdout: evidence,
    },
  ])
  assert.match(rendered, /authority: parent-owned/)
  assert.match(rendered, /evidence: receipt-1/)
  assert.match(rendered, /^\[RESULT\]/)
})

test('continues execution presentation after a host callback throws', (t) => {
  t.mock.method(console, 'error', () => {})
  let completed = false
  const callbacks = wrapPresentationCallbacks({
    onToolStart: () => {
      throw new Error('presentation failure')
    },
    onToolComplete: () => {
      completed = true
    },
  })
  assert.equal(callbacks.onToolStart?.('read_file', 'source.ts'), undefined)
  callbacks.onToolComplete?.(1)
  assert.equal(completed, true)
})
