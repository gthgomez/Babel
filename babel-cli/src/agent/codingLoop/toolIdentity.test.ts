import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  pairToolResultsByActionIdentity,
  rebuildPairedToolTurn,
  resolveDurableToolCallId,
} from './toolIdentity.js'

describe('parallel tool identity (shipped)', () => {
  test('reverse-order completions stay paired with original provider calls', () => {
    const rebuilt = rebuildPairedToolTurn({
      turn: 4,
      requests: [
        { actionIndex: 0, providerId: 'call_aaa', tool: 'read_file', target: 'a.ts' },
        { actionIndex: 1, providerId: 'call_bbb', tool: 'read_file', target: 'b.ts' },
        { actionIndex: 2, providerId: 'call_ccc', tool: 'grep', target: 'TODO' },
      ],
      completionsInArrivalOrder: [
        { actionIndex: 2, content: 'grep-result', exit_code: 0 },
        { actionIndex: 1, content: 'b-contents', exit_code: 0 },
        { actionIndex: 0, content: 'a-contents', exit_code: 0 },
      ],
    })
    assert.equal(rebuilt.lifecycleOk, true)
    assert.equal(rebuilt.paired[0]?.toolCallId, 'call_aaa')
    assert.equal(rebuilt.paired[0]?.result.content, 'a-contents')
    assert.equal(rebuilt.paired[1]?.toolCallId, 'call_bbb')
    assert.equal(rebuilt.paired[2]?.toolCallId, 'call_ccc')
    assert.equal(rebuilt.providerById.get('call_aaa'), 'read_file')
    assert.equal(rebuilt.providerById.get('call_ccc'), 'grep')
  })

  test('pairing never uses completion-order array position', () => {
    const results = [
      { index: 1, tool: 'read_range', content: 'range-200' },
      { index: 0, tool: 'read_file', content: 'full-head' },
    ]
    const providerIds = ['id-full', 'id-range']
    const paired = pairToolResultsByActionIdentity(results, (actionIndex) =>
      resolveDurableToolCallId({ actionIndex, providerIds, turn: 1 }),
    )
    assert.equal(paired[0]?.toolCallId, 'id-full')
    assert.equal(paired[0]?.result.content, 'full-head')
    assert.equal(paired[1]?.toolCallId, 'id-range')
    assert.equal(paired[1]?.result.content, 'range-200')
  })

  test('session replay/rebuild succeeds with the same pairing function', () => {
    const first = rebuildPairedToolTurn({
      turn: 2,
      requests: [
        { actionIndex: 0, providerId: 'p0', tool: 'read_file', target: 'x.ts' },
        { actionIndex: 1, providerId: 'p1', tool: 'read_file', target: 'y.ts' },
      ],
      completionsInArrivalOrder: [
        { actionIndex: 1, content: 'Y' },
        { actionIndex: 0, content: 'X' },
      ],
    })
    const replay = rebuildPairedToolTurn({
      turn: 2,
      requests: [
        { actionIndex: 0, providerId: 'p0', tool: 'read_file', target: 'x.ts' },
        { actionIndex: 1, providerId: 'p1', tool: 'read_file', target: 'y.ts' },
      ],
      completionsInArrivalOrder: [
        { actionIndex: 1, content: 'Y' },
        { actionIndex: 0, content: 'X' },
      ],
    })
    assert.deepEqual(
      replay.paired.map((p) => p.toolCallId),
      first.paired.map((p) => p.toolCallId),
    )
    assert.equal(replay.lifecycleOk, true)
  })
})
