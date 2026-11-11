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

test('sole informal npm task closes single meaning criterion for no-change', () => {
  const task = 'Fix add so it returns the sum of its arguments; run npm test before finishing.'
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: [
      { tool: 'read_file', target: 'parser.ts', detail: 'ok', exit_code: 0 },
      { tool: 'run_command', target: 'npm test', exit_code: 0, effect_status: 'confirmed_no_change' },
    ],
    criterionCompletion: {
      currentRequest: () => ({
        context: { schema_version: 1, kind: 'criterion-completion:v1' },
        contract: {
          frozen: true,
          user_request: task,
          acceptance: [{
            id: 'acceptance:sole',
            description: task,
            required: true,
            type: 'custom',
            verification_strategy: 'meaning',
            verification: { kind: 'custom', verifier_id: 'meaning:sole', command_hash: 'x' },
          }],
        },
        run_id: 'r',
        project_root: '/tmp',
      }),
      refreshPrivateEvidence: () => {},
      reportAdvisoryEvidence: () => [{
        requirement_id: 'acceptance:sole',
        status: 'missing',
        evidence_class: 'inspection',
      }],
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
    } as never,
    buildCriterionRefresh: () => ({
      criterionChatReceipts: [],
      candidate_sha: null,
      has_mutation: false,
    }),
  }), true)
})

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
              type: 'custom',
              verification_strategy: 'meaning',
              verification: { kind: 'custom', verifier_id: 'meaning:behavior', command_hash: 'x' },
            },
            {
              id: 'acceptance:verify',
              description: '`node verify.mjs` must pass.',
              required: true,
              type: 'custom',
              verification_strategy: 'Run verifier.',
              verification: { kind: 'custom', verifier_id: 'acceptance:verify', command_hash: 'y' },
            },
          ],
        },
        run_id: 'r',
        project_root: '/tmp',
      }),
      refreshPrivateEvidence,
      reportAdvisoryEvidence: () => [
        { requirement_id: 'acceptance:behavior', status: 'missing', evidence_class: 'inspection' },
        { requirement_id: 'acceptance:verify', status: 'missing', evidence_class: 'command' },
      ],
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
    } as never,
    toolCallLog: [
      ...inspectedLog,
      { tool: 'run_command', target: 'node unrelated.mjs', exit_code: 0, effect_status: 'confirmed_no_change' },
    ],
    buildCriterionRefresh,
  }), true)
})

test('echo npm test does not satisfy a frozen npm test command requirement', () => {
  const criterion = {
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
    reportAdvisoryEvidence: () => [{
      requirement_id: 'acceptance:npm-test',
      status: 'missing',
      evidence_class: 'command',
    }],
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
  } as never
  assert.equal(mutatingInspectionLeavesRequiredCriteriaUnmet({
    criterionCompletion: criterion,
    toolCallLog: [
      { tool: 'read_file', target: 'a.ts', detail: 'ok', exit_code: 0 },
      { tool: 'run_command', target: 'echo npm test', exit_code: 0, effect_status: 'confirmed_no_change' },
    ],
    buildCriterionRefresh: () => ({
      criterionChatReceipts: [],
      candidate_sha: null,
      has_mutation: false,
    }),
  }), true)
})

test('green npm test does not clear an separate unmet behavioral goal', () => {
  const criterion = {
    currentRequest: () => ({
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
      contract: {
        frozen: true,
        user_request: 'Fix source.js so the exported value is 2.',
        acceptance: [
          {
            id: 'acceptance:goal',
            description: 'Fix source.js so the exported value is 2.',
            required: true,
            type: 'custom',
            verification_strategy: 'meaning',
            verification: { kind: 'custom', verifier_id: 'meaning:goal', command_hash: 'g' },
          },
          {
            id: 'acceptance:npm',
            description: '`npm test` must pass.',
            required: true,
            type: 'custom',
            verification_strategy: 'Run npm test.',
            verification: { kind: 'custom', verifier_id: 'acceptance:npm', command_hash: 'n' },
          },
        ],
      },
      run_id: 'r',
      project_root: '/tmp',
    }),
    refreshPrivateEvidence: () => {},
    reportAdvisoryEvidence: () => [
      { requirement_id: 'acceptance:goal', status: 'missing', evidence_class: 'inspection' },
      { requirement_id: 'acceptance:npm', status: 'missing', evidence_class: 'command' },
    ],
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
  } as never
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: [
      { tool: 'read_file', target: 'src/source.js', detail: 'value=999', exit_code: 0 },
      { tool: 'run_command', target: 'npm test', exit_code: 0, effect_status: 'confirmed_no_change' },
    ],
    criterionCompletion: criterion,
    buildCriterionRefresh: () => ({
      criterionChatReceipts: [],
      candidate_sha: null,
      has_mutation: false,
    }),
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
