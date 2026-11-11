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

const npmBoundCriterion = {
  currentRequest: () => ({
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
    contract: {
      frozen: true,
      acceptance: [{
        id: 'acceptance:npm-test',
        description: 'npm test passes',
        required: true,
        type: 'unit_test',
        verification_strategy: 'Run npm test.',
        verification: {
          kind: 'unit_test',
          verifier_id: 'verifier:npm-test',
          executable_id: 'npm',
          argv: ['test'],
        },
      }],
    },
    run_id: 'r',
    project_root: '/tmp',
  }),
  refreshPrivateEvidence: () => {},
  reportAdvisoryEvidence: () => [],
  context: { schema_version: 1, kind: 'criterion-completion:v1' },
} as never

test('command-bound green npm test in tool log supports inspection-only no-change', () => {
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: [
      { tool: 'read_file', target: 'parser.ts', detail: 'ok', exit_code: 0 },
      { tool: 'run_command', target: 'npm test', exit_code: 0, effect_status: 'confirmed_no_change' },
    ],
    criterionCompletion: npmBoundCriterion,
    buildCriterionRefresh: () => ({
      criterionChatReceipts: [],
      candidate_sha: null,
      has_mutation: false,
    }),
  }), true)
})

test('unrelated all-green receipts do not clear missing required criteria', () => {
  const refreshPrivateEvidence = () => {}
  const buildCriterionRefresh = () => ({
    criterionChatReceipts: [{ exit_code: 0, command: 'node unrelated.mjs', summary: '# tests 1\n# pass 1' }],
    candidate_sha: null,
    has_mutation: false,
  })
  assert.equal(mutatingInspectionLeavesRequiredCriteriaUnmet({
    criterionCompletion: {
      currentRequest: () => ({
        context: { schema_version: 1, kind: 'criterion-completion:v1' },
        contract: {
          frozen: true,
          acceptance: [
            {
              id: 'acceptance:behavior',
              description: 'exported value is 2',
              required: true,
              type: 'command',
              verification: { kind: 'command', command: 'node verify.mjs', verifier_id: 'acceptance:behavior' },
            },
            {
              id: 'acceptance:unrelated',
              description: 'unrelated check',
              required: false,
              type: 'command',
              verification: { kind: 'command', command: 'node unrelated.mjs', verifier_id: 'acceptance:unrelated' },
            },
          ],
        },
        run_id: 'r',
        project_root: '/tmp',
      }),
      refreshPrivateEvidence,
      reportAdvisoryEvidence: () => [{
        requirement_id: 'acceptance:behavior',
        status: 'missing',
        evidence_class: 'command',
      }],
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
    } as never,
    toolCallLog: inspectedLog,
    buildCriterionRefresh,
  }), true)
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
