import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildConfirmedMutationRevisionKey,
  collectConfirmedMutationArtifactPaths,
  findLastSubstantiveCompletionCandidate,
  formatPreservedUnverifiedTerminalAnswer,
  isGenuineCompletionAttemptMessage,
  isRetainedCompletionCandidateMessage,
  resolveGateRejectedCompletionCapture,
  tryRecordGateRejectedCompletionCapture,
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

test('unit: gate seam capture freezes first completion; recovery prose does not replace', () => {
  const log = [{
    tool: 'str_replace',
    effect_status: 'confirmed_change' as const,
    mutation_paths: ['数据/summary.csv'],
  }]
  const first = 'J08_GATE_CAPTURE first substantive completion.'
  const recovery = 'RECOVERY_CHATTER I will run npm test and try again.'
  const generation = 3
  let capture = tryRecordGateRejectedCompletionCapture(null, first, log, generation)
  capture = tryRecordGateRejectedCompletionCapture(capture, recovery, log, generation)
  const resolved = resolveGateRejectedCompletionCapture(capture, log, generation)
  assert.equal(resolved.kind, 'retain')
  if (resolved.kind === 'retain') {
    assert.equal(resolved.candidate, first)
    assert.deepEqual(resolved.artifactRefs, ['数据/summary.csv'])
  }
  const tailWouldPickRecovery = findLastSubstantiveCompletionCandidate([
    { role: 'user', content: 'task' },
    { role: 'tool', content: 'wrote summary' },
    { role: 'assistant', content: first },
    { role: 'assistant', content: recovery, name: 'harness_feedback', provenance: 'controller' },
    { role: 'tool', content: 'harness nudge' },
    { role: 'assistant', content: recovery },
  ], { submissionStartIndex: 0 })
  assert.equal(tailWouldPickRecovery, recovery)
  if (resolved.kind === 'retain') {
    assert.notEqual(resolved.candidate, tailWouldPickRecovery)
  }
})

test('unit: after confirmed mutation, a later genuine gate reject may capture a new current candidate', () => {
  const logV1 = [{
    tool: 'str_replace',
    effect_status: 'confirmed_change' as const,
    mutation_paths: ['数据/summary.csv'],
  }]
  const logV2 = [
    ...logV1,
    {
      tool: 'str_replace',
      effect_status: 'confirmed_change' as const,
      mutation_paths: ['数据/other.csv'],
    },
  ]
  const generation = 7
  const first = 'FIRST_GATE_REJECT explanation for summary only.'
  const second = 'SECOND_GATE_REJECT explanation after other.csv write.'
  let capture = tryRecordGateRejectedCompletionCapture(null, first, logV1, generation)
  capture = tryRecordGateRejectedCompletionCapture(capture, second, logV2, generation)
  const resolved = resolveGateRejectedCompletionCapture(capture, logV2, generation)
  assert.equal(resolved.kind, 'retain')
  if (resolved.kind === 'retain') {
    assert.equal(resolved.candidate, second)
    assert.deepEqual(resolved.artifactRefs, ['数据/other.csv', '数据/summary.csv'])
  }
})

test('unit: relevant indeterminate mutation must not retain as unchanged revision', () => {
  const logConfirmed = [{
    tool: 'str_replace',
    effect_status: 'confirmed_change' as const,
    mutation_paths: ['数据/summary.csv'],
  }]
  const logWithIndeterminate = [
    ...logConfirmed,
    {
      tool: 'str_replace',
      effect_status: 'indeterminate' as const,
      mutation_paths: ['数据/summary.csv'],
    },
  ]
  const generation = 8
  const capture = tryRecordGateRejectedCompletionCapture(
    null,
    'Explanation bound to first confirmed revision.',
    logConfirmed,
    generation,
  )
  assert.ok(capture)
  assert.equal(
    buildConfirmedMutationRevisionKey(logConfirmed),
    buildConfirmedMutationRevisionKey(logWithIndeterminate),
  )
  assert.equal(
    resolveGateRejectedCompletionCapture(capture, logWithIndeterminate, generation).kind,
    'stale_revision',
  )
})

test('unit: post-capture confirmed mutation clears retained candidate and artifact binding', () => {
  const logBefore = [{
    tool: 'str_replace',
    effect_status: 'confirmed_change' as const,
    mutation_paths: ['数据/summary.csv'],
  }]
  const generation = 2
  const capture = tryRecordGateRejectedCompletionCapture(
    null,
    'Explanation for first revision.',
    logBefore,
    generation,
  )
  assert.ok(capture)
  const logAfter = [
    ...logBefore,
    {
      tool: 'str_replace',
      effect_status: 'confirmed_change' as const,
      mutation_paths: ['数据/other.csv'],
    },
  ]
  assert.notEqual(
    buildConfirmedMutationRevisionKey(logBefore),
    buildConfirmedMutationRevisionKey(logAfter),
  )
  assert.equal(
    resolveGateRejectedCompletionCapture(capture, logAfter, generation).kind,
    'stale_revision',
  )
})

test('unit: capture does not resolve under a different submission generation', () => {
  const log = [{
    tool: 'str_replace',
    effect_status: 'confirmed_change' as const,
    mutation_paths: ['a.csv'],
  }]
  const capture = tryRecordGateRejectedCompletionCapture(
    null,
    'bound to generation 4',
    log,
    4,
  )
  assert.equal(resolveGateRejectedCompletionCapture(capture, log, 5).kind, 'absent')
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
