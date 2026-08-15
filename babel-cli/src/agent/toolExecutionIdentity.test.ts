import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  countParallelCompletionReorders,
  projectDurableToolBatch,
  projectDurableToolBatchBySlicePosition,
  resolveActionToolCallId,
  type DurableToolLogRow,
} from './toolExecutionIdentity.js'

const outOfOrderSlice: DurableToolLogRow[] = [
  { tool: 'read_file', target: 'CURRENT_STATE.md', index: 1 },
  { tool: 'list_dir', target: 'scripts', index: 2 },
  { tool: 'read_file', target: 'SIMLIFE_ROADMAP_2026.md', index: 0 },
]

const providerIds = [
  'call_00_M7L5Dq8bFICnERtjDy0e4133',
  'call_01_YQ2rVs1LCpXhgHflkP668215',
  'call_02_YwzqQfLha7lVrA0p9tt21038',
]

describe('toolExecutionIdentity', () => {
  test('resolves provider IDs by original action index, not completion position', () => {
    assert.equal(
      resolveActionToolCallId({
        actionIndex: 2,
        turn: 0,
        providerToolCallIds: providerIds,
      }),
      providerIds[2],
    )
    assert.equal(
      resolveActionToolCallId({ actionIndex: 1, turn: 3 }),
      'tool_call_3_1',
    )
  })

  test('counts reverse completion of a three-tool parallel batch', () => {
    assert.equal(countParallelCompletionReorders(outOfOrderSlice), 2)
    assert.equal(
      countParallelCompletionReorders([
        { tool: 'read_file', target: 'a', index: 0 },
        { tool: 'read_file', target: 'b', index: 1 },
      ]),
      0,
    )
  })

  test('request order != completion order keeps each row on its own provider ID', () => {
    const projected = projectDurableToolBatch({
      turnSlice: outOfOrderSlice,
      turn: 0,
      providerToolCallIds: providerIds,
    })
    assert.equal(projected.parallelCompletionReorders, 2)
    assert.deepEqual(
      projected.results.map((row) => ({
        id: row.tool_call_id,
        name: row.tool_name,
        index: row.action_index,
      })),
      [
        { id: providerIds[1], name: 'read_file', index: 1 },
        { id: providerIds[2], name: 'list_dir', index: 2 },
        { id: providerIds[0], name: 'read_file', index: 0 },
      ],
    )
  })

  test('positional reconstruction swaps names onto the wrong provider IDs', () => {
    const buggy = projectDurableToolBatchBySlicePosition({
      turnSlice: outOfOrderSlice,
      turn: 0,
      providerToolCallIds: providerIds,
    })
    assert.equal(buggy.results[0]?.tool_call_id, providerIds[0])
    assert.equal(buggy.results[0]?.tool_name, 'read_file')
    assert.equal(buggy.results[0]?.action_index, 0)
    assert.notEqual(buggy.results[0]?.tool_call_id, providerIds[1])
  })
})
