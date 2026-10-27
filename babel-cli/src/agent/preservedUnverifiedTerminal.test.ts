import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIRECT_MUTATION_TOOLS,
  VERIFIER_ATTEMPT_TOOLS,
} from './mutationTools.js'
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

const INDETERMINATE_FRESHNESS_BASE_LOG = [{
  tool: 'str_replace',
  effect_status: 'confirmed_change' as const,
  mutation_paths: ['数据/summary.csv'],
}]

function assertIndeterminateWorkspaceMutatorYieldsStaleRevision(
  tool: string,
  mutation_paths: readonly string[] | undefined,
): void {
  const generation = 11
  const capture = tryRecordGateRejectedCompletionCapture(
    null,
    'Explanation at confirmed revision.',
    INDETERMINATE_FRESHNESS_BASE_LOG,
    generation,
  )
  assert.ok(capture)
  const indeterminateEntry = mutation_paths === undefined
    ? { tool, effect_status: 'indeterminate' as const }
    : { tool, effect_status: 'indeterminate' as const, mutation_paths }
  const logWithIndeterminate = [...INDETERMINATE_FRESHNESS_BASE_LOG, indeterminateEntry]
  assert.equal(
    buildConfirmedMutationRevisionKey(INDETERMINATE_FRESHNESS_BASE_LOG),
    buildConfirmedMutationRevisionKey(logWithIndeterminate),
  )
  assert.equal(
    resolveGateRejectedCompletionCapture(capture, logWithIndeterminate, generation).kind,
    'stale_revision',
  )
}

for (const tool of DIRECT_MUTATION_TOOLS) {
  test(`regression: indeterminate ${tool} omitted mutation_paths → stale_revision at resolve`, () => {
    assertIndeterminateWorkspaceMutatorYieldsStaleRevision(tool, undefined)
  })
  test(`regression: indeterminate ${tool} empty mutation_paths → stale_revision at resolve`, () => {
    assertIndeterminateWorkspaceMutatorYieldsStaleRevision(tool, [])
  })
}

for (const tool of VERIFIER_ATTEMPT_TOOLS) {
  test(`regression: indeterminate ${tool} omitted mutation_paths → stale_revision at resolve`, () => {
    assertIndeterminateWorkspaceMutatorYieldsStaleRevision(tool, undefined)
  })
  test(`regression: indeterminate ${tool} empty mutation_paths → stale_revision at resolve`, () => {
    assertIndeterminateWorkspaceMutatorYieldsStaleRevision(tool, [])
  })
}

test('regression: indeterminate sub_agent parent_candidate with named mutation_paths → stale_revision', () => {
  const generation = 12
  const capture = tryRecordGateRejectedCompletionCapture(
    null,
    'Explanation at confirmed revision.',
    INDETERMINATE_FRESHNESS_BASE_LOG,
    generation,
  )
  assert.ok(capture)
  const logWithChild = [
    ...INDETERMINATE_FRESHNESS_BASE_LOG,
    {
      tool: 'sub_agent',
      target: 'child-spec-1',
      detail: 'failed: timeout, attribution=child_failed',
      index: 2,
      exit_code: 1,
      error: 'timeout',
      effect_scope: 'parent_candidate' as const,
      effect_status: 'indeterminate' as const,
      mutation_paths: ['src/parent-affected.ts'],
    },
  ]
  assert.equal(
    buildConfirmedMutationRevisionKey(INDETERMINATE_FRESHNESS_BASE_LOG),
    buildConfirmedMutationRevisionKey(logWithChild),
  )
  assert.equal(
    resolveGateRejectedCompletionCapture(capture, logWithChild, generation).kind,
    'stale_revision',
  )
})

test('regression: indeterminate sub_agent parent_candidate without mutation_paths → stale_revision', () => {
  const generation = 13
  const capture = tryRecordGateRejectedCompletionCapture(
    null,
    'Explanation at confirmed revision.',
    INDETERMINATE_FRESHNESS_BASE_LOG,
    generation,
  )
  assert.ok(capture)
  const logWithChild = [
    ...INDETERMINATE_FRESHNESS_BASE_LOG,
    {
      tool: 'sub_agent',
      target: 'child-spec-2',
      detail: 'failed, attribution=child_threw',
      error: 'error',
      effect_status: 'indeterminate' as const,
      effect_scope: 'parent_candidate' as const,
      index: 3,
      exit_code: 1,
    },
  ]
  assert.equal(
    resolveGateRejectedCompletionCapture(capture, logWithChild, generation).kind,
    'stale_revision',
  )
})

test('regression: indeterminate sub_agent isolated_child does not force stale_revision at resolve', () => {
  const generation = 14
  const capture = tryRecordGateRejectedCompletionCapture(
    null,
    'Explanation at confirmed revision.',
    INDETERMINATE_FRESHNESS_BASE_LOG,
    generation,
  )
  assert.ok(capture)
  const logWithIsolatedChild = [
    ...INDETERMINATE_FRESHNESS_BASE_LOG,
    {
      tool: 'sub_agent',
      target: 'child-spec-3',
      detail: 'failed, attribution=child_threw',
      error: 'error',
      effect_status: 'indeterminate' as const,
      effect_scope: 'isolated_child' as const,
      index: 4,
      exit_code: 1,
    },
  ]
  assert.equal(
    buildConfirmedMutationRevisionKey(INDETERMINATE_FRESHNESS_BASE_LOG),
    buildConfirmedMutationRevisionKey(logWithIsolatedChild),
  )
  const resolved = resolveGateRejectedCompletionCapture(capture, logWithIsolatedChild, generation)
  assert.equal(resolved.kind, 'retain')
})

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

test('regression(115c0895): same-revision revised totals 190 then 200 retains first capture', () => {
  const log = [{
    tool: 'str_replace',
    effect_status: 'confirmed_change' as const,
    mutation_paths: ['数据/summary.csv'],
  }]
  const generation = 6
  const at190 = 'Net revenue totals 190 (A=120, B=70).'
  const at200 = 'Net revenue totals 200 (A=130, B=70).'
  let capture = tryRecordGateRejectedCompletionCapture(null, at190, log, generation)
  capture = tryRecordGateRejectedCompletionCapture(capture, at200, log, generation)
  const resolved = resolveGateRejectedCompletionCapture(capture, log, generation)
  assert.equal(resolved.kind, 'retain')
  if (resolved.kind === 'retain') {
    assert.equal(resolved.candidate, at190)
    assert.notEqual(resolved.candidate, at200)
  }
})

test('regression(115c0895): recovery chatter does not replace gate-rejected completion at same revision', () => {
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

test('regression: confirmed write then gate reject does not replace first capture record', () => {
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
  assert.ok(capture)
  assert.equal(capture?.candidateText, first)
  assert.equal(resolveGateRejectedCompletionCapture(capture, logV2, generation).kind, 'stale_revision')
})

test('regression: recovery tooling then gate-rejected chatter does not replace first capture', () => {
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
    {
      tool: 'read_file',
      target: '数据/summary.csv',
      effect_status: 'not_applicable' as const,
    },
  ]
  const generation = 9
  const substantive = 'SUBSTANTIVE_GATE_REJECT Net revenue totals 200.'
  const recovery = 'I will run npm test and try completing again.'
  let capture = tryRecordGateRejectedCompletionCapture(null, substantive, logV1, generation)
  capture = tryRecordGateRejectedCompletionCapture(capture, recovery, logV2, generation)
  assert.ok(capture)
  assert.equal(capture?.candidateText, substantive)
  assert.notEqual(capture?.candidateText, recovery)
  assert.equal(resolveGateRejectedCompletionCapture(capture, logV2, generation).kind, 'stale_revision')
})

test('regression(115c0895): stale capture without re-record stays stale_revision after confirmed write', () => {
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

test('regression(115c0895): capture does not resolve under a different submission generation', () => {
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
