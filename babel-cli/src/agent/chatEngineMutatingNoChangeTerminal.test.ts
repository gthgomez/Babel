import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasInspectedNoChangeEvidence } from './completionGatePolicy.js'
import {
  mutatingInspectionLeavesRequiredCriteriaUnmet,
  resolveAcceptedReadOnlyTerminal,
} from './chatEngineMutatingNoChangeTerminal.js'
import type { BoundChatVerifierReceipt } from '../evidence/chatRevisionBinding.js'

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

test('sole meaning criterion stays open despite informal npm test prose and green npm', () => {
  const task = 'Fix add so it returns the sum of its arguments; run npm test before finishing.'
  const toolCallLog = [
    { tool: 'read_file', target: 'parser.ts', detail: 'ok', exit_code: 0 },
    { tool: 'run_command', target: 'npm test', exit_code: 0, effect_status: 'confirmed_no_change' as const },
  ]
  const criterionCompletion = {
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
  } as never
  const buildCriterionRefresh = () => ({
    criterionChatReceipts: [],
    candidate_sha: null,
    has_mutation: false,
  })
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog,
    criterionCompletion,
    buildCriterionRefresh,
  }), false)
  assert.equal(mutatingInspectionLeavesRequiredCriteriaUnmet({
    criterionCompletion,
    toolCallLog,
    buildCriterionRefresh,
  }), true)
})

test('argument-qualified npm run must match full frozen argv for no-change', () => {
  const requiredCommand = 'npm run test:unit -- --filter critical'
  const criterionCompletion = {
    currentRequest: () => ({
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
      contract: {
        frozen: true,
        acceptance: [{
          id: 'acceptance:unit',
          description: `\`${requiredCommand}\` must pass.`,
          required: true,
          type: 'unit_test',
          verification_strategy: 'Run full npm argv.',
          verification: {
            kind: 'unit_test',
            verifier_id: 'verifier:npm',
            executable_id: 'npm',
            argv: ['run', 'test:unit', '--', '--filter', 'critical'],
          },
        }],
      },
      run_id: 'r',
      project_root: '/tmp',
    }),
    refreshPrivateEvidence: () => {},
    reportAdvisoryEvidence: () => [{
      requirement_id: 'acceptance:unit',
      status: 'missing',
      evidence_class: 'command',
    }],
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
  } as never
  const buildCriterionRefresh = () => ({
    criterionChatReceipts: [],
    candidate_sha: null,
    has_mutation: false,
  })
  const base = {
    effectiveOperation: 'MUTATING' as const,
    ambientReadOnly: false,
    hasAnyWrites: false,
    criterionCompletion,
    buildCriterionRefresh,
  }
  assert.equal(resolveAcceptedReadOnlyTerminal({
    ...base,
    toolCallLog: [
      { tool: 'read_file', target: 'src/source.js', detail: 'value=2', exit_code: 0 },
      { tool: 'run_command', target: 'npm run test:unit', exit_code: 0, effect_status: 'confirmed_no_change' as const },
    ],
  }), false)
  assert.equal(resolveAcceptedReadOnlyTerminal({
    ...base,
    toolCallLog: [
      { tool: 'read_file', target: 'src/source.js', detail: 'value=2', exit_code: 0 },
      { tool: 'run_command', target: requiredCommand, exit_code: 0, effect_status: 'confirmed_no_change' as const },
    ],
  }), true)
})

test('non-npm executable-bound verifier requires full argv identity', () => {
  const requiredCommand = 'node verify.mjs --mode strict'
  const criterionCompletion = {
    currentRequest: () => ({
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
      contract: {
        frozen: true,
        acceptance: [{
          id: 'acceptance:verify',
          description: `\`${requiredCommand}\` must pass.`,
          required: true,
          type: 'custom',
          verification_strategy: 'Run node with mode flag.',
          verification: {
            kind: 'custom',
            verifier_id: 'verifier:node',
            executable_id: 'node',
            argv: ['verify.mjs', '--mode', 'strict'],
          },
        }],
      },
      run_id: 'r',
      project_root: '/tmp',
    }),
    refreshPrivateEvidence: () => {},
    reportAdvisoryEvidence: () => [{
      requirement_id: 'acceptance:verify',
      status: 'missing',
      evidence_class: 'command',
    }],
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
  } as never
  const build = () => ({
    criterionChatReceipts: [],
    candidate_sha: null,
    has_mutation: false,
  })
  const base = {
    effectiveOperation: 'MUTATING' as const,
    ambientReadOnly: false,
    hasAnyWrites: false,
    criterionCompletion,
    buildCriterionRefresh: build,
  }
  assert.equal(resolveAcceptedReadOnlyTerminal({
    ...base,
    toolCallLog: [
      { tool: 'read_file', target: 'src/source.js', detail: 'ok', exit_code: 0 },
      { tool: 'run_command', target: 'node verify.mjs', exit_code: 0, effect_status: 'confirmed_no_change' as const },
    ],
  }), false)
  assert.equal(resolveAcceptedReadOnlyTerminal({
    ...base,
    toolCallLog: [
      { tool: 'read_file', target: 'src/source.js', detail: 'ok', exit_code: 0 },
      { tool: 'run_command', target: requiredCommand, exit_code: 0, effect_status: 'confirmed_no_change' as const },
    ],
  }), true)
})

test('verifier_id fallback cannot satisfy command-bound acceptance after command mismatch', () => {
  const requiredCommand = 'npm run test:unit'
  const criterionCompletion = {
    currentRequest: () => ({
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
      contract: {
        frozen: true,
        acceptance: [{
          id: 'acceptance:unit',
          description: `\`${requiredCommand}\` must pass.`,
          required: true,
          type: 'unit_test',
          verification_strategy: 'Run npm script.',
          verification: {
            kind: 'unit_test',
            verifier_id: 'verifier:npm',
            executable_id: 'npm',
            argv: ['run', 'test:unit'],
          },
        }],
      },
      run_id: 'r',
      project_root: '/tmp',
    }),
    refreshPrivateEvidence: () => {},
    reportAdvisoryEvidence: () => [{
      requirement_id: 'acceptance:unit',
      status: 'missing',
      evidence_class: 'command',
    }],
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
  } as never
  assert.equal(mutatingInspectionLeavesRequiredCriteriaUnmet({
    criterionCompletion,
    toolCallLog: inspectedLog,
    buildCriterionRefresh: () => ({
      criterionChatReceipts: [{
        exit_code: 0,
        command: 'npm test',
        verifier_id: 'verifier:npm',
        verifierId: 'verifier:npm',
        argv: ['npm', 'test'],
        summary: 'ok',
      }],
      candidate_sha: null,
      has_mutation: false,
    }),
  }), true)
})

test('receipt argv must match frozen executable binding when provided', () => {
  const requiredCommand = 'npm run test:unit'
  const criterionCompletion = {
    currentRequest: () => ({
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
      contract: {
        frozen: true,
        acceptance: [{
          id: 'acceptance:unit',
          description: `\`${requiredCommand}\` must pass.`,
          required: true,
          type: 'unit_test',
          verification_strategy: 'Run npm script.',
          verification: {
            kind: 'unit_test',
            verifier_id: 'verifier:npm',
            executable_id: 'npm',
            argv: ['run', 'test:unit'],
          },
        }],
      },
      run_id: 'r',
      project_root: '/tmp',
    }),
    refreshPrivateEvidence: () => {},
    reportAdvisoryEvidence: () => [{
      requirement_id: 'acceptance:unit',
      status: 'missing',
      evidence_class: 'command',
    }],
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
  } as never
  const build = () => ({
    criterionChatReceipts: [] as BoundChatVerifierReceipt[],
    candidate_sha: null,
    has_mutation: false,
  })
  const open = (receipts: BoundChatVerifierReceipt[]) =>
    mutatingInspectionLeavesRequiredCriteriaUnmet({
      criterionCompletion,
      toolCallLog: inspectedLog,
      buildCriterionRefresh: () => ({ ...build(), criterionChatReceipts: receipts }),
    })
  assert.equal(open([{
    exit_code: 0,
    command: requiredCommand,
    verifier_id: 'verifier:npm',
    argv: ['npm', 'run', 'test:other'],
    summary: 'ok',
  }]), true)
  assert.equal(open([{
    exit_code: 0,
    command: requiredCommand,
    verifier_id: 'verifier:npm',
    argv: ['npm', 'run', 'test:unit'],
    summary: 'ok',
  }]), false)
})

test('quoted path spaces in tool target must match frozen command exactly', () => {
  const requiredCommand = 'node --test "test  files/foo.test.mjs"'
  const criterionCompletion = {
    currentRequest: () => ({
      context: { schema_version: 1, kind: 'criterion-completion:v1' },
      contract: {
        frozen: true,
        acceptance: [{
          id: 'acceptance:node-test',
          description: `\`${requiredCommand}\` must pass.`,
          required: true,
          type: 'unit_test',
          verification_strategy: 'Run node test.',
          verification: {
            kind: 'unit_test',
            verifier_id: 'verifier:node',
            executable_id: 'node',
            argv: ['--test', 'test  files/foo.test.mjs'],
          },
        }],
      },
      run_id: 'r',
      project_root: '/tmp',
    }),
    refreshPrivateEvidence: () => {},
    reportAdvisoryEvidence: () => [{
      requirement_id: 'acceptance:node-test',
      status: 'missing',
      evidence_class: 'command',
    }],
    context: { schema_version: 1, kind: 'criterion-completion:v1' },
  } as never
  const base = {
    effectiveOperation: 'MUTATING' as const,
    ambientReadOnly: false,
    hasAnyWrites: false,
    criterionCompletion,
    buildCriterionRefresh: () => ({
      criterionChatReceipts: [],
      candidate_sha: null,
      has_mutation: false,
    }),
  }
  assert.equal(resolveAcceptedReadOnlyTerminal({
    ...base,
    toolCallLog: [
      { tool: 'read_file', target: 'x', detail: 'ok', exit_code: 0 },
      { tool: 'run_command', target: 'node --test "test files/foo.test.mjs"', exit_code: 0, effect_status: 'confirmed_no_change' as const },
    ],
  }), false)
  assert.equal(resolveAcceptedReadOnlyTerminal({
    ...base,
    toolCallLog: [
      { tool: 'read_file', target: 'x', detail: 'ok', exit_code: 0 },
      { tool: 'run_command', target: requiredCommand, exit_code: 0, effect_status: 'confirmed_no_change' as const },
    ],
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

test('grounded file read can substantiate a simple fix-file meaning criterion for no-change', () => {
  const task = 'Fix settings.txt so mode is safe.'
  assert.equal(resolveAcceptedReadOnlyTerminal({
    effectiveOperation: 'MUTATING',
    ambientReadOnly: false,
    hasAnyWrites: false,
    toolCallLog: [
      { tool: 'read_file', target: 'settings.txt', detail: 'mode=safe\n', exit_code: 0 },
    ],
    criterionCompletion: {
      currentRequest: () => ({
        context: { schema_version: 1, kind: 'criterion-completion:v1' },
        contract: {
          frozen: true,
          user_request: task,
          acceptance: [{
            id: 'acceptance:settings',
            description: task,
            required: true,
            type: 'custom',
            verification_strategy: 'meaning',
            verification: { kind: 'custom', verifier_id: 'meaning:settings', command_hash: 'x' },
          }],
        },
        run_id: 'r',
        project_root: '/tmp',
      }),
      refreshPrivateEvidence: () => {},
      reportAdvisoryEvidence: () => [{
        requirement_id: 'acceptance:settings',
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
