import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasInspectedNoChangeEvidence } from './completionGatePolicy.js'
import {
  mutatingInspectionLeavesRequiredCriteriaUnmet,
  resolveAcceptedReadOnlyTerminal,
} from './chatEngineMutatingNoChangeTerminal.js'

const inspectedLog = [{ tool: 'read_file', target: 'a.ts', detail: 'export const value = 1', exit_code: 0 }]

test('HYBRID inspection-only terminal requires criterion authority (no bypass)', () => {
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'HYBRID',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: inspectedLog,
    criterionCompletion: undefined,
    buildCriterionRefresh: () => null,
  }), false)
  assert.equal(hasInspectedNoChangeEvidence(inspectedLog), true)
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

test('meaning-only obligations cannot satisfy terminal on inspection alone', () => {
  assert.equal(mutatingInspectionLeavesRequiredCriteriaUnmet({
    criterionCompletion: {
      currentRequest: () => ({
        context: { schema_version: 1, kind: 'criterion-completion:v1' },
        contract: {
          frozen: true,
          acceptance: [{
            id: 'behavior',
            description: 'parseSum(2, 3) returns 5',
            required: true,
            type: 'custom',
            verification_strategy: 'meaning',
            verification: { kind: 'custom', verifier_id: 'meaning:behavior', command_hash: 'x' },
          }],
        },
        run_id: 'r',
        project_root: '/tmp',
      }),
      refreshPrivateEvidence: () => {},
      reportAdvisoryEvidence: () => [{
        requirement_id: 'behavior',
        status: 'missing',
        evidence_class: 'inspection',
      }],
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
    } as never,
    toolCallLog: inspectedLog,
    buildCriterionRefresh: () => ({
      criterionChatReceipts: [],
      candidate_sha: null,
      has_mutation: false,
    }),
  }), true)
})
