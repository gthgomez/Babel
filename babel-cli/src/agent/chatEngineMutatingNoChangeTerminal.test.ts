import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasInspectedNoChangeEvidence } from './completionGatePolicy.js'
import { resolveAcceptedReadOnlyTerminal } from './chatEngineMutatingNoChangeTerminal.js'

test('HYBRID inspection retains productive no-change without criterion refresh', () => {
  const log = [{ tool: 'read_file', target: 'a.ts', detail: 'export const value = 1', exit_code: 0 }]
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'HYBRID',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: log,
    criterionCompletion: undefined,
    buildCriterionRefresh: () => null,
  }), true)
  assert.equal(hasInspectedNoChangeEvidence(log), true)
})

test('MUTATING inspection fails closed without criterion authority', () => {
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: [{ tool: 'read_file', target: 'a.ts', detail: 'x', exit_code: 0 }],
    criterionCompletion: undefined,
    buildCriterionRefresh: () => null,
  }), false)
})
