import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { selectReadWindow } from './readWindow.js'
import {
  evaluatePostWriteRepairTurn,
  investigationToolsAvailable,
  resolveNextTurnToolAccess,
} from './postWritePolicy.js'

describe('post-write investigation lockout (shipped policy)', () => {
  test('successful write does not permanently remove investigation tools', () => {
    const policy = resolveNextTurnToolAccess({
      postWriteRestrict: true,
      lastVerifierFailed: false,
      stallRestrictOnce: false,
      taskClass: 'general_swe',
    })
    assert.equal(policy.restrict, false)
    assert.equal(policy.mode, 'full')
  })

  test('red verifier reopens read/search/LSP and a second repair can be issued', () => {
    const turn = evaluatePostWriteRepairTurn({
      taskClass: 'general_swe',
      firstMutationSucceeded: true,
      verifierExitCode: 1,
    })
    assert.equal(turn.policy.reopenInvestigation, true)
    assert.equal(turn.canReread, true)
    assert.equal(turn.canSearch, true)
    assert.equal(turn.canUseLsp, true)
    assert.equal(turn.canRepairAgain, true)
    assert.equal(investigationToolsAvailable(turn.tools), true)

    const failingFile = Array.from({ length: 40 }, (_, i) =>
      i === 11 ? 'export const add = (a, b) => a - b' : `// line ${i}`,
    ).join('\n')
    const reread = selectReadWindow(failingFile, { kind: 'range', startLine: 10, endLine: 14 })
    assert.match(reread.numberedText, /a - b/)
  })

  test('behavior remains available in general_swe', () => {
    const turn = evaluatePostWriteRepairTurn({
      taskClass: 'general_swe',
      firstMutationSucceeded: true,
      verifierExitCode: 1,
    })
    assert.equal(turn.policy.mode, 'full')
    assert.ok(turn.tools.some((d) => d.function.name === 'read_file'))
    assert.ok(turn.tools.some((d) => d.function.name === 'grep'))
    assert.ok(turn.tools.some((d) => d.function.name === 'lsp'))
    assert.ok(turn.tools.some((d) => d.function.name === 'str_replace'))
  })

  test('one-shot stall restrict still works before a write', () => {
    const policy = resolveNextTurnToolAccess({
      postWriteRestrict: false,
      lastVerifierFailed: false,
      stallRestrictOnce: true,
      taskClass: 'general_swe',
    })
    assert.equal(policy.restrict, true)
    assert.equal(policy.mode, 'mutate_only')
  })
})
