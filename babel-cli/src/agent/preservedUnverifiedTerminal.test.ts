import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectArtifactRefsFromToolLog,
  findLastSubstantiveCompletionCandidate,
  formatPreservedUnverifiedTerminalAnswer,
  isRetainedCompletionCandidateMessage,
} from './preservedUnverifiedTerminal.js'

test('formatPreservedUnverifiedTerminalAnswer leads with authority reason and UNVERIFIED label', () => {
  const formatted = formatPreservedUnverifiedTerminalAnswer({
    authorityReason: 'Turn limit reached (2 of 2).\n\nCOMPLETION_GATE_REJECTED: verifier_missing',
    retainedCandidate: 'Net revenue totals 200 (A=130, B=70).',
    artifactRefs: ['summary.csv'],
  })
  assert.ok(formatted.startsWith('Turn limit reached'))
  assert.match(formatted, /COMPLETION_GATE_REJECTED: verifier_missing/)
  assert.match(formatted, /UNVERIFIED retained candidate/)
  assert.match(formatted, /Net revenue totals 200/)
  assert.match(formatted, /summary\.csv/)
  assert.doesNotMatch(formatted, /VERIFIED_COMPLETE/i)
})

test('findLastSubstantiveCompletionCandidate skips harness gate feedback', () => {
  const candidate = findLastSubstantiveCompletionCandidate([
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'J08_PRESERVED_NET_200_EXPLANATION Product A net 130.' },
    {
      role: 'assistant',
      content: 'COMPLETION_GATE_REJECTED: verifier_missing\nRun npm test',
      provenance: 'controller',
      name: 'harness_feedback',
    },
  ])
  assert.equal(candidate, 'J08_PRESERVED_NET_200_EXPLANATION Product A net 130.')
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

test('collectArtifactRefsFromToolLog gathers mutation targets', () => {
  assert.deepEqual(
    collectArtifactRefsFromToolLog([
      { tool: 'write_file', target: 'summary.csv', mutation_paths: ['数据/summary.csv'] },
    ]),
    ['summary.csv', '数据/summary.csv'],
  )
})
