import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectConfirmedMutationArtifactPaths,
  findLastSubstantiveCompletionCandidate,
  formatPreservedUnverifiedTerminalAnswer,
  isGenuineCompletionAttemptMessage,
  isRetainedCompletionCandidateMessage,
} from './preservedUnverifiedTerminal.js'

test('formatPreservedUnverifiedTerminalAnswer leads with authority reason and UNVERIFIED label', () => {
  const formatted = formatPreservedUnverifiedTerminalAnswer({
    authorityReason: 'Turn limit exceeded. Gate check: verifier_missing',
    retainedCandidate: 'Net revenue totals 200 (A=130, B=70).',
    artifactRefs: ['数据/summary.csv'],
  })
  assert.ok(formatted.startsWith('Turn limit exceeded'))
  assert.match(formatted, /UNVERIFIED retained candidate/)
  assert.match(formatted, /Net revenue totals 200/)
  assert.match(formatted, /数据\/summary\.csv/)
  assert.doesNotMatch(formatted, /VERIFIED_COMPLETE/i)
})

test('unit: findLastSubstantiveCompletionCandidate skips harness gate feedback', () => {
  const candidate = findLastSubstantiveCompletionCandidate([
    { role: 'user', content: 'task' },
    { role: 'tool', content: 'ok' },
    { role: 'assistant', content: 'J08_PRESERVED_NET_200_EXPLANATION Product A net 130.' },
    {
      role: 'assistant',
      content: 'COMPLETION_GATE_REJECTED: verifier_missing\nRun npm test',
      provenance: 'controller',
      name: 'harness_feedback',
    },
  ], { submissionStartIndex: 0 })
  assert.equal(candidate, 'J08_PRESERVED_NET_200_EXPLANATION Product A net 130.')
})

test('unit: rejects prior-submission assistant prose', () => {
  const candidate = findLastSubstantiveCompletionCandidate([
    { role: 'assistant', content: 'OLD_TASK_MARKER stale answer from prior submission.' },
    { role: 'user', content: 'new task' },
    { role: 'tool', content: 'wrote summary' },
    { role: 'assistant', content: 'CURRENT_MARKER current completion attempt.' },
  ], { submissionStartIndex: 1 })
  assert.equal(candidate, 'CURRENT_MARKER current completion attempt.')
  assert.doesNotMatch(candidate ?? '', /OLD_TASK_MARKER/)
})

test('unit: rejects incidental pre-tool assistant prose in current submission', () => {
  const candidate = findLastSubstantiveCompletionCandidate([
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'PREAMBLE_MARKER I will edit the file now.' },
    { role: 'tool', content: 'str_replace ok' },
    { role: 'assistant', content: 'COMPLETION_MARKER done explaining.' },
  ], { submissionStartIndex: 0 })
  assert.equal(candidate, 'COMPLETION_MARKER done explaining.')
})

test('unit: isGenuineCompletionAttemptMessage is false without tool observations', () => {
  const messages = [
    { role: 'user' as const, content: 'task' },
    { role: 'assistant' as const, content: 'PREAMBLE only' },
  ]
  assert.equal(isGenuineCompletionAttemptMessage(messages, 1, 0), false)
})

test('unit: collectConfirmedMutationArtifactPaths ignores reads and shell targets', () => {
  assert.deepEqual(
    collectConfirmedMutationArtifactPaths([
      { tool: 'read_file', target: 'src/read.ts', effect_status: 'not_applicable' },
      { tool: 'run_command', target: 'npm test', effect_status: 'indeterminate' },
      {
        tool: 'str_replace',
        target: '数据/summary.csv',
        effect_status: 'confirmed_change',
        mutation_paths: ['数据/summary.csv'],
      },
    ]),
    ['数据/summary.csv'],
  )
})

test('isRetainedCompletionCandidateMessage rejects controller harness lines', () => {
  assert.equal(
    isRetainedCompletionCandidateMessage({
      role: 'assistant',
      content: 'COMPLETION_GATE_REJECTED: verifier_missing',
      provenance: 'controller',
      name: 'harness_feedback',
    }),
    false,
  )
})
