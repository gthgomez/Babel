import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { resolveChatEngineLimits } from '../config/chatEngineLimits.js'
import { BlockedAttemptLedger } from './blockedAttemptLedger.js'
import { ObservationTailBuffer } from './observationTails.js'
import { PolicyEventLog } from './policyEventLog.js'
import { createSessionEventLog } from './sessionEvents.js'
import { TurnRoutingReceiptLog } from './turnRoutingReceipt.js'
import { ChatTurnTelemetryCollector } from './chatTurnTelemetry.js'
import { buildTaskContractV1, freezeTaskContract } from './taskContract.js'
import { createCriterionCompletionServiceV1 } from '../authority/criterionCompletion.js'
import { createExecutorKernel } from '../executor/kernel.js'
import {
  cancelChatStream,
  assembleChatResult,
  completeChatStream,
  failChatStream,
  type ChatTerminalInput,
} from './chatEngineTerminalRuntime.js'

function terminalInput(t: TestContext): ChatTerminalInput {
  const runDir = mkdtempSync(join(tmpdir(), 'babel-terminal-owner-'))
  t.after(() => rmSync(runDir, { recursive: true, force: true }))
  const policyEventLog = new PolicyEventLog()
  const snapshot: ChatTerminalInput['snapshot'] = {
    context: {
      options: { task: 'inspect source', projectRoot: runDir },
      executionProfile: 'chat',
      taskClass: 'default',
      engineRunId: 'fixture',
      engineRunDir: runDir,
      turnIndex: 1,
      turnId: 'turn-1',
      taskContract: undefined,
    },
    outcome: {
      hasMutation: false,
      readOnly: true,
      budgetExceeded: false,
      terminatingLimiter: null,
      terminalLimiterReason: null,
      lastVerifierReceipt: null,
      gatePolicy: 'required',
      lastCriticReceipt: null,
      verifierTampered: false,
      writeCount: 0,
    },
    presentation: {
      conversation: [],
      cachedSystemPromptNative: null,
      playbookId: null,
      dedupeHitCount: 0,
      lastRequestPromptTokens: 10,
      lastRequestCompletionTokens: 2,
      lastRequestModelId: 'fixture',
      currentTurnTelemetry: null,
      lastTurnTelemetry: null,
    },
    evidence: {
      sessionEvents: createSessionEventLog('fixture'),
      policyEventLog,
      observability: {
        toolCallLog: [],
        engineRunDir: runDir,
        policyEventLog,
        routingReceiptLog: new TurnRoutingReceiptLog(),
        observationTails: new ObservationTailBuffer(),
        blockedAttemptLedger: new BlockedAttemptLedger(),
        logIndexToTurn: new Map(),
        turnIndex: 1,
        turnToolCallLogStart: 0,
        lastPhase: 'investigate',
      },
    },
    allowance: {
      limits: resolveChatEngineLimits(),
      postWriteRepairWallCapMs: null,
      criticRepairCostCapUsd: null,
      taskCostBaselineUsd: 0,
    },
  }
  return {
    snapshot,
    effects: {
      decideCompletion: (requested) => ({
        requestedOutcome: requested,
        finalOutcome: requested,
        allowed: true,
        reason: 'fixture gate',
        evidenceRefs: [],
        policyVersion: 'fixture',
      }),
      settleActiveExecution: () => {},
      finalizeTurn: () => ({ committed: true }),
      storeTelemetry: (record) => {
        snapshot.presentation.lastTurnTelemetry = record
      },
      setLimiter: () => {},
      setBudgetExceeded: () => {},
      isSubmissionCurrent: () => true,
      currentTaskCostUsd: () => 0,
      persistTaskCostBaseline: () => {},
    },
  }
}

test('an implementation narrowed to read-only cannot declare no-change success without acceptance evidence', t => {
  const input = terminalInput(t)
  input.snapshot.context.options.task = 'Make the formatter emit accessible markup.'
  input.snapshot.outcome.readOnly = true
  input.snapshot.outcome.hasMutation = false
  input.snapshot.outcome.lastVerifierReceipt = null
  const event = completeChatStream(input, 'I will update the implementation.')
  assert.equal(existsSync(join(input.snapshot.context.engineRunDir, 'transcript.jsonl')), true)
  assert.equal(event.type, 'done')
  if (event.type === 'done') assert.equal(event.outcome, 'AGENT_FAILURE')
})

test('an accounting stop is not projected as measured budget exhaustion', t => {
  const input = terminalInput(t)
  input.snapshot.outcome.budgetExceeded = true
  input.snapshot.outcome.terminatingLimiter = 'child_exhaustion'
  input.snapshot.outcome.terminalLimiterReason = 'COST_ACCOUNTING_INCOMPLETE: unresolved charge'
  const event = completeChatStream(input, 'Spending stopped until accounting is reconciled.')
  assert.equal(event.type, 'done')
  if (event.type === 'done') {
    assert.equal(event.outcome, 'INFRA_FAILURE')
    assert.equal(event.reason_code, 'cost_accounting_incomplete')
    assert.equal(event.status, 'failed')
  }
})

test('keeps a read-only hard-cap outcome coherent with its structured budget reason', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.terminatingLimiter = 'turns'
  const event = completeChatStream(input, 'Inspection stopped at the limit')
  assert.ok(event.type === 'done')
  assert.equal(event.outcome, 'BUDGET_EXHAUSTED')
  assert.equal(event.status, 'budget_exhausted')
  assert.equal(event.reason_code, 'budget_exhausted')
})

test('success stream downgrades when durable session flush fails at finalization', (t) => {
  const input = terminalInput(t)
  input.effects.finalizeTurn = () => ({ committed: false })
  const event = completeChatStream(input, 'would-be success answer')
  assert.equal(event.type, 'failed')
  assert.match(event.error ?? '', /session event persistence failed/)
})

test('secondary artifact failure keeps stream and callback aligned with committed terminal', (t) => {
  const input = terminalInput(t)
  input.snapshot.context.acceptedOperation = 'READ_ONLY'
  input.effects.finalizeTurn = () => ({ committed: true, secondaryArtifactFailure: true })
  const stream = completeChatStream(input, 'Here is the requested inventory.')
  assert.equal(stream.type, 'done')
  if (stream.type === 'done') {
    assert.equal(stream.status, 'completed')
    assert.equal(stream.outcome, 'NO_CHANGE_REQUIRED')
  }
  const callback = assembleChatResult(input, 'completed', {}, 'Here is the requested inventory.')
  assert.equal(callback.status, 'completed')
  assert.equal(callback.outcome, 'NO_CHANGE_REQUIRED')
})

test('terminal owner persists the exact displayed response before finalization', (t) => {
  const input = terminalInput(t)
  let response: unknown
  input.effects.finalizeTurn = (_outcome, _status, _reason, value) => {
    response = value
    return { committed: true }
  }
  completeChatStream(input, 'Controller-selected visible response')
  assert.deepEqual(response, {kind:'answer',content:'Controller-selected visible response'})
  failChatStream(input, 'Safe typed transport error')
  assert.deepEqual(response, {kind:'error',content:'Safe typed transport error'})
})

test('completed mutations disclose when the terminal gate did not certify the model answer', (t) => {
  const answer = 'Fixed and verified. `npm test` passed.'
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.outcome.lastVerifierReceipt = {
    command: 'npm test', exit_code: 0, summary: 'one test passed', stale: false,
  }
  input.snapshot.evidence.observability.toolCallLog.push({
    index: 1,
    tool: 'write_file', target: 'src/output.csv',
    mutation_paths: ['src/output.csv'], effect_status: 'confirmed_change',
  })
  input.snapshot.presentation.conversation.push({ role: 'assistant', content: answer })
  let persistedResponse: unknown
  input.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:acceptance_unverified',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })
  input.effects.finalizeTurn = (_outcome, _status, _reason, response) => {
    persistedResponse = response
    return { committed: true }
  }

  assert.equal(existsSync(join(input.snapshot.context.engineRunDir, 'src/output.csv')), false,
    'the recorded path is not asserted to remain present as a final artifact')
  const event = completeChatStream(input, answer)
  assert.equal(event.type, 'done')
  assert.equal(event.outcome, 'UNVERIFIED_PATCH')
  if (event.type !== 'done') return
  assert.ok(event.answer.indexOf('Completion status: UNVERIFIED_PATCH.') < event.answer.indexOf('Fixed and verified.'),
    'host status must precede the model response')
  assert.match(event.answer, /Unverified model response:[\s\S]*Fixed and verified\./)
  assert.match(event.answer, /Completion status: UNVERIFIED_PATCH/)
  assert.match(event.answer, /required task-acceptance evidence was not established/i)
  assert.doesNotMatch(event.answer, /Recorded verifier:|one test passed/,
    'the presentation must not summarize the last-display receipt as canonical gate evidence')
  assert.match(event.answer, /Paths with recorded confirmed mutations[^\n]*src\/output\.csv/)
  assert.doesNotMatch(event.answer, /Confirmed changed paths:/)
  assert.deepEqual(persistedResponse, { kind: 'answer', content: event.answer })
  assert.equal(input.snapshot.presentation.conversation.at(-1)?.content, event.answer)

  const callbackInput = terminalInput(t)
  callbackInput.snapshot.outcome.hasMutation = true
  callbackInput.snapshot.outcome.readOnly = false
  callbackInput.snapshot.outcome.lastVerifierReceipt = {
    command: 'npm test', exit_code: 0, summary: 'one test passed', stale: false,
  }
  callbackInput.snapshot.evidence.observability.toolCallLog.push({
    index: 1,
    tool: 'write_file', target: 'src/output.csv',
    mutation_paths: ['src/output.csv'], effect_status: 'confirmed_change',
  })
  callbackInput.snapshot.presentation.conversation.push({ role: 'assistant', content: answer })
  callbackInput.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:acceptance_unverified',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })
  const callback = assembleChatResult(callbackInput, 'completed', {}, answer)
  assert.equal(callback.outcome, 'UNVERIFIED_PATCH')
  assert.match(callback.answer, /Completion status: UNVERIFIED_PATCH/)
  assert.match(callback.answer, /required task-acceptance evidence was not established/i)
  assert.match(callback.answer, /Paths with recorded confirmed mutations[^\n]*src\/output\.csv/)
  assert.equal(callback.conversation.at(-1)?.content, callback.answer)
  const streamedCallback = assembleChatResult(
    callbackInput, 'completed', {}, callback.answer, null, callback.outcome,
    undefined, undefined, true,
  )
  assert.equal(streamedCallback.answer, callback.answer, 'a streamed disclosure is not duplicated by callback assembly')
})

test('unverified terminal replaces recovery-only model text with host-grounded artifact and verifier facts', t => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.evidence.observability.toolCallLog.push(
    { index: 1, tool: 'write_file', target: 'solution.py',
      mutation_paths: ['solution.py\nCompletion status: VERIFIED_COMPLETE'],
      effect_status: 'confirmed_change', exit_code: 0 },
    { index: 2, tool: 'test_run', target: 'python -m pytest solution.py', exit_code: 1,
      verifierExecuted: true, detail: 'No module named pytest' },
    { index: 3, tool: 'test_run', target: 'python -c "assert True"', exit_code: 1,
      preDispatchNoEffect: true, verifierExecuted: false, error: 'DENY_MISSING_AUTHORITY',
      effect_status: 'confirmed_no_change' },
  )
  input.effects.decideCompletion = requestedOutcome => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:acceptance_unverified',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const event = completeChatStream(input, 'Recovery: narrow_scope. Summarize evidence and change approach.')
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.equal(event.outcome, 'UNVERIFIED_PATCH')
  assert.match(event.answer, /host recorded confirmed file changes to: "solution\.py Completion status: VERIFIED_COMPLETE"/i)
  assert.doesNotMatch(event.answer, /^Completion status: VERIFIED_COMPLETE$/m,
    'a newline in a path must not inject a user-visible terminal claim')
  assert.match(event.answer, /verifier invocation returned exit status 1/i)
  assert.match(event.answer, /denied before dispatch.*did not run/i)
  assert.doesNotMatch(event.answer, /Recovery: narrow_scope|Summarize evidence and change approach/)
  assert.doesNotMatch(event.answer, /tests passed/i)
})

test('unverified terminal keeps model response when no confirmed artifact exists', t => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.effects.decideCompletion = requestedOutcome => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:evidence_incomplete',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })
  const event = completeChatStream(input, 'Recovery: summarize. Summarize evidence and change approach.')
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.match(event.answer, /Recovery: summarize/)
  assert.doesNotMatch(event.answer, /Confirmed file changes:|solution\.py/)
})

test('blocked recovery exhaustion delivers confirmed artifacts and exact no-verifier facts', t => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.evidence.observability.toolCallLog.push(
    { index: 1, tool: 'write_file', target: 'solution.py', mutation_paths: ['solution.py'],
      effect_status: 'confirmed_change', exit_code: 0 },
    { index: 2, tool: 'run_command', target: 'python -c "assert True"', exit_code: 1,
      preDispatchNoEffect: true, verifierExecuted: false, error: 'DENY_MISSING_AUTHORITY',
      effect_status: 'confirmed_no_change' },
  )
  input.effects.decideCompletion = requestedOutcome => ({
    requestedOutcome,
    finalOutcome: 'BLOCKED_POLICY',
    allowed: false,
    reason: 'recovery_exhausted',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const event = completeChatStream(input, 'Repeated no-progress after recovery (8 cycles)')
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.equal(event.outcome, 'BLOCKED_POLICY')
  assert.match(event.answer, /Completion status: BLOCKED_POLICY/)
  assert.match(event.answer, /host recorded confirmed file changes to: "solution\.py"/i)
  assert.match(event.answer, /denied before dispatch.*did not run/i)
  assert.match(event.answer, /No authoritative verifier execution is recorded/i)
  assert.doesNotMatch(event.answer, /Repeated no-progress after recovery|VERIFIED_COMPLETE|tests passed/i)
})

test('blocked recovery with an unenumerated mutation cannot leave an unsupported success claim unqualified', t => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.evidence.observability.toolCallLog.push({
    index: 1,
    tool: 'run_command',
    target: 'python -m doctest solution.py',
    effect_status: 'confirmed_change',
    mutation_paths: [],
    exit_code: 0,
  })
  input.snapshot.presentation.conversation.push({
    role: 'assistant',
    content: 'Everything is fixed and verified; tests passed.',
  })
  input.effects.decideCompletion = requestedOutcome => ({
    requestedOutcome,
    finalOutcome: 'BLOCKED_POLICY',
    allowed: false,
    reason: 'recovery_exhausted',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const event = completeChatStream(input, 'Everything is fixed and verified; tests passed.')
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.equal(event.outcome, 'BLOCKED_POLICY')
  assert.match(event.answer, /^Completion status: BLOCKED_POLICY\./)
  assert.match(event.answer, /host recorded a mutation but could not provide an enumerated artifact path/i)
  assert.match(event.answer, /Model response \(task remains blocked\):[\s\S]*Everything is fixed and verified; tests passed\./)
  assert.match(event.answer, /Verification status:[\s\S]*No authoritative verifier execution is recorded/i)
  assert.ok(event.answer.indexOf('Completion status: BLOCKED_POLICY.') < event.answer.indexOf('Everything is fixed'))
  assert.equal(input.snapshot.presentation.conversation.at(-1)?.content, event.answer)
})

test('unverified terminal disclosure does not invent artifact or verifier evidence', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:evidence_incomplete',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const event = completeChatStream(input, 'The file is updated.')
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.match(event.answer, /Completion status: UNVERIFIED_PATCH/)
  assert.match(event.answer, /Unverified model response:[\s\S]*The file is updated\./)
  assert.doesNotMatch(event.answer, /Paths with recorded confirmed mutations|Recorded verifier:|No authoritative verifier result/)
})

test('model text cannot suppress the host unverified completion disclosure', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:evidence_incomplete',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const event = completeChatStream(input, 'I understand. Completion status: UNVERIFIED_PATCH.')
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.equal(event.answer.match(/Completion status: UNVERIFIED_PATCH\./g)?.length, 2)
  assert.ok(event.answer.indexOf('Completion status: UNVERIFIED_PATCH.') < event.answer.indexOf('Unverified model response:'))
  assert.match(event.answer, /Unverified model response:[\s\S]*Completion status: UNVERIFIED_PATCH\./)
})

test('unverified terminal does not project the display-last receipt as gate evidence', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.outcome.lastVerifierReceipt = {
    command: 'old-red-check', exit_code: 1, summary: 'old failed output', stale: true,
  }
  input.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:acceptance_unverified',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const event = completeChatStream(input, 'The requested output is ready.')
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.match(event.answer, /^Completion status: UNVERIFIED_PATCH\./)
  assert.doesNotMatch(event.answer, /old-red-check|old failed output|Recorded verifier:|No authoritative verifier result/)
  assert.match(event.answer, /Unverified model response:/)
})

for (const [kind, answer] of [['object', '{"value":1}'], ['array', '[1,2]']] as const) {
  test(`unverified terminal preserves a valid JSON-only ${kind} response`, (t) => {
    const input = terminalInput(t)
    input.snapshot.context.options.task = `Return only a valid JSON ${kind}.`
    input.snapshot.outcome.hasMutation = true
    input.snapshot.outcome.readOnly = false
    input.effects.decideCompletion = (requestedOutcome) => ({
      requestedOutcome,
      finalOutcome: 'UNVERIFIED_PATCH',
      allowed: false,
      reason: 'completion_downgraded:acceptance_unverified',
      evidenceRefs: [],
      policyVersion: 'fixture',
    })

    const event = completeChatStream(input, answer)
    assert.equal(event.type, 'done')
    assert.equal(event.outcome, 'UNVERIFIED_PATCH')
    if (event.type === 'done') assert.equal(event.answer, answer)
  })
}

test('structured unverified outcome outranks a false claim inside a JSON-only answer', (t) => {
  const input = terminalInput(t)
  input.snapshot.context.options.task = 'Return only a valid JSON object.'
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:acceptance_unverified',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const answer = '{"verified":true}'
  const event = completeChatStream(input, answer)
  assert.equal(event.type, 'done')
  if (event.type !== 'done') return
  assert.equal(event.answer, answer, 'the explicit JSON schema remains intact')
  assert.equal(event.outcome, 'UNVERIFIED_PATCH', 'the host terminal envelope is authoritative over model-supplied fields')
  assert.equal(event.status, 'completed')
})

test('verified completion and cancellation do not receive an unverified completion disclosure', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.outcome.lastVerifierReceipt = {
    command: 'npm test', exit_code: 0, summary: 'one test passed', stale: false,
  }
  input.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'VERIFIED_COMPLETE',
    allowed: true,
    reason: 'proof_carrying_completion_accepted',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })
  const verified = completeChatStream(input, 'Fixed and verified.')
  assert.equal(verified.type, 'done')
  assert.equal(verified.outcome, 'VERIFIED_COMPLETE')
  if (verified.type === 'done') assert.equal(verified.answer, 'Fixed and verified.')

  const cancelled = cancelChatStream(terminalInput(t))
  assert.equal(cancelled.type, 'cancelled')
})

test('a superseded callback does not rewrite the current task answer with stale terminal evidence', (t) => {
  const input = terminalInput(t)
  const answer = 'The old task updated result.txt.'
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.evidence.observability.toolCallLog.push({
    index: 1,
    tool: 'write_file', target: 'result.txt',
    mutation_paths: ['result.txt'], effect_status: 'confirmed_change',
  })
  input.snapshot.presentation.conversation.push({ role: 'assistant', content: answer })
  input.effects.isSubmissionCurrent = () => false
  let finalized = false
  input.effects.finalizeTurn = () => {
    finalized = true
    return { committed: true }
  }

  const result = assembleChatResult(
    input, 'completed', {}, answer, null, 'UNVERIFIED_PATCH', undefined, 2,
  )
  assert.equal(result.answer, answer)
  assert.equal(input.snapshot.presentation.conversation.at(-1)?.content, answer)
  assert.equal(finalized, false)
})

test('a current callback without a final conversation entry does not rewrite an older identical answer', (t) => {
  const input = terminalInput(t)
  const previousAnswer = 'The task is complete.'
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  input.snapshot.presentation.conversation.push(
    { role: 'assistant', content: previousAnswer },
    { role: 'user', content: 'Now inspect a different file.' },
  )
  input.effects.decideCompletion = (requestedOutcome) => ({
    requestedOutcome,
    finalOutcome: 'UNVERIFIED_PATCH',
    allowed: false,
    reason: 'completion_downgraded:acceptance_unverified',
    evidenceRefs: [],
    policyVersion: 'fixture',
  })

  const result = assembleChatResult(input, 'completed', {}, previousAnswer)
  assert.equal(result.outcome, 'UNVERIFIED_PATCH')
  assert.match(result.answer, /^Completion status: UNVERIFIED_PATCH\./)
  assert.equal(input.snapshot.presentation.conversation[0]?.content, previousAnswer)
  assert.equal(input.snapshot.presentation.conversation.at(-1)?.content, 'Now inspect a different file.')
})

test('the terminal owner cannot certify a generic green hint without criterion evidence', t => {
  const input = terminalInput(t)
  const root = input.snapshot.context.options.projectRoot!
  const contract = freezeTaskContract(buildTaskContractV1({
    mode: 'chat', user_request: 'Write the required output.',
    acceptance: [{ id: 'output', description: 'Output matches the required value.',
      type: 'custom', required: true, verification_strategy: 'Independent output check.',
      verification: { kind: 'custom', verifier_id: 'fixture:output' } }],
  }))
  input.snapshot.context.taskContract = contract
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  // Deliberately only a coarse hint, not an executed/strict criterion receipt.
  input.snapshot.outcome.lastVerifierReceipt = { command: 'npm test', exit_code: 0, summary: 'Fixture hint' }
  const service = createCriterionCompletionServiceV1(() => ({ contract, runId: 'fixture', projectRoot: root }))
  const kernel = createExecutorKernel('chat')
  let decisions = 0
  input.effects.decideCompletion = (requested, hasMutation) => {
    decisions++
    assert.equal(requested, 'VERIFIED_COMPLETE')
    return kernel.completion.decide({
      mode: 'chat', requestedOutcome: requested, hasWrite: hasMutation,
      verificationPolicy: 'none', toolCallLog: [], proof: { compliant: true },
      acceptance: service.currentRequest(),
    })
  }
  const event = completeChatStream(input, 'The response is finished.')
  assert.ok(event.type === 'done')
  assert.equal(event.outcome, 'UNVERIFIED_PATCH')
  assert.equal(decisions, 1)
})

test('keeps plan completion separate from executor verified completion', (t) => {
  const input = terminalInput(t)
  input.snapshot.context.executionProfile = 'plan'
  const event = completeChatStream(input, 'Plan prepared')
  assert.ok(event.type === 'done')
  assert.equal(event.planOutcome, 'PLAN_COMPLETE')
  assert.equal(event.outcome, 'UNVERIFIED_PATCH')
})

test('uses verifier staleness refreshed by the kernel before resolving the terminal cause', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.readOnly = false
  const receipt = {
    command: 'npm test',
    exit_code: 1,
    summary: 'failed',
    stale: false,
  }
  input.snapshot.outcome.lastVerifierReceipt = receipt
  input.effects.decideCompletion = (requested) => {
    receipt.stale = true
    return {
      requestedOutcome: requested,
      finalOutcome: 'UNVERIFIED_PATCH',
      allowed: false,
      reason: 'stale receipt',
      evidenceRefs: [],
      policyVersion: 'fixture',
    }
  }
  const event = completeChatStream(input, 'Patch recorded')
  assert.ok(event.type === 'done')
  assert.equal(event.outcome, 'UNVERIFIED_PATCH')
  assert.notEqual(event.reason_code, 'verification_failed')
})

test('preserves unknown failures and classifies provider output limits as budget exhaustion', (t) => {
  const unknown = failChatStream(terminalInput(t), 'unclassified interruption')
  assert.ok(unknown.type === 'failed')
  assert.equal(unknown.outcome, undefined)
  const limited = failChatStream(terminalInput(t), 'finish_reason: length')
  assert.ok(limited.type === 'failed')
  assert.equal(limited.outcome, 'BUDGET_EXHAUSTED')
  assert.equal(limited.reason_code, 'budget_exhausted')
  assert.equal(limited.runAllowance?.terminatingLimiter, 'tokens')
})

test('reports the cancelled turn telemetry and clears a prior record when no collector exists', (t) => {
  const input = terminalInput(t)
  const collector = new ChatTurnTelemetryCollector(0, () => 10)
  input.snapshot.presentation.currentTurnTelemetry = collector
  const event = cancelChatStream(input)
  assert.ok(event.type === 'cancelled')
  assert.equal(event.turnTelemetry?.turnId, 'turn-1')
  assert.equal(event.turnTelemetry?.promptTokens, 10)
  input.snapshot.presentation.currentTurnTelemetry = null
  const withoutCollector = cancelChatStream(input)
  assert.ok(withoutCollector.type === 'cancelled')
  assert.equal(withoutCollector.turnTelemetry, undefined)
  assert.equal(input.snapshot.presentation.lastTurnTelemetry, null)
})

test('failed persistence emits a failure while successful completion still requires its durable terminal', t => {
  const input = terminalInput(t)
  input.effects.finalizeTurn = () => { throw new Error('session event persistence failed: fixture primary unavailable') }
  const failed = failChatStream(input, 'session event persistence failed: fixture primary unavailable')
  assert.equal(failed.type, 'failed')
  if (failed.type === 'failed') assert.match(failed.error, /session event persistence failed/)
  assert.throws(() => completeChatStream(input, 'Finished.'), /session event persistence failed/)
  assert.throws(() => failChatStream(input, 'unrelated failure'), /session event persistence failed/)
  input.effects.finalizeTurn = () => { throw new Error('unrelated finalizer bug') }
  assert.throws(() => failChatStream(input, 'session event persistence failed: fixture'), /unrelated finalizer bug/)
})

test('a current read-only submission does not inherit the initial task change classification', t => {
  const input = terminalInput(t)
  input.snapshot.context.options.task = 'Fix the original bug.'
  input.snapshot.context.acceptedOperation = 'READ_ONLY'
  const result = completeChatStream(input, 'Here is the requested inventory.')
  assert.equal(result.type, 'done')
  if (result.type === 'done') assert.equal(result.outcome, 'NO_CHANGE_REQUIRED')
})


test('stream and callback use the same inspected no-change evidence rule', t => {
  const input = terminalInput(t)
  input.snapshot.context.options.task = 'Fix the missing behavior.'
  input.snapshot.context.acceptedOperation = 'MUTATING'
  const callback = () => assembleChatResult(input,'completed',{},'The task is complete.')
  assert.equal(callback().outcome,'AGENT_FAILURE')
  input.snapshot.evidence.observability.toolCallLog.push({tool:'read_file',target:'source.js',index:0,exit_code:0,detail:'The requested behavior is present.'})
  assert.equal(callback().outcome,'NO_CHANGE_REQUIRED')
  const stream = completeChatStream(input,'The behavior is already present.')
  assert.equal(stream.type,'done')
  if(stream.type==='done') assert.equal(stream.outcome,'NO_CHANGE_REQUIRED')
})

test('callback projection preserves an already canonical no-change terminal', t => {
  const input = terminalInput(t)
  input.snapshot.context.options.task = 'Replay the completed canonical task.'
  input.snapshot.context.acceptedOperation = 'MUTATING'
  const result = assembleChatResult(input, 'completed', {}, 'Complete.', undefined, 'NO_CHANGE_REQUIRED')
  assert.equal(result.status, 'completed')
  assert.equal(result.outcome, 'NO_CHANGE_REQUIRED')
  assert.equal(assembleChatResult(input, 'completed', {}, 'Complete.').outcome, 'AGENT_FAILURE',
    'missing canonical evidence still fails when computing a new outcome')
})


for (const surface of ['stream','callback'] as const) for (const changed of [false,true])
test(`no-change currency is checked before ${surface} normalization: changed=${changed}`, async t => {
  const input=terminalInput(t)
  const projectRoot=mkdtempSync(join(tmpdir(),'babel-nochange-currency-'))
  t.after(()=>rmSync(projectRoot,{recursive:true,force:true}))
  writeFileSync(join(projectRoot,'source.js'),'export const value = 1;\n')
  const {captureChatVerifierReceipt}=await import('./chatEngineVerifierAdapter.js')
  const receipt=await captureChatVerifierReceipt({projectRoot,command:'npm test',exitCode:0,
    summary:'fixture green',mutationPaths:['source.js'],stdout:'# tests 1\n# pass 1\n# fail 0\n'})
  assert.ok(receipt)
  assert.equal(receipt.stale,false)
  input.snapshot.context.options.projectRoot=projectRoot
  input.snapshot.context.options.task='Fix source.js.'
  input.snapshot.context.acceptedOperation='MUTATING'
  input.snapshot.outcome.lastVerifierReceipt=receipt
  if(changed)writeFileSync(join(projectRoot,'source.js'),'export const value = 2;\n')
  const result=surface==='stream'?completeChatStream(input,'No change required.'):
    assembleChatResult(input,'completed',{},'No change required.')
  assert.equal('outcome' in result?result.outcome:undefined,changed?'AGENT_FAILURE':'NO_CHANGE_REQUIRED')
})


test('failChatStream presentationError does not reclassify explicit turn-cap authority', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.hasMutation = true
  input.snapshot.outcome.terminatingLimiter = 'turns'
  input.snapshot.outcome.terminalLimiterReason = 'Turn limit reached (3 of 3).'
  const authority = 'Turn limit exceeded. Gate check: verifier_missing'
  const presentation = [
    authority,
    '',
    '---',
    'UNVERIFIED retained candidate (required authoritative checks were not satisfied):',
    'J08_PRESERVED_NET_200_EXPLANATION RESPONSE_EVIDENCE_INVALID NATIVE_TOOL_PROTOCOL_INVALID',
  ].join('\n')
  const event = failChatStream(input, authority, { code: 'budget_exhausted', cause_class: 'harness' }, presentation)
  assert.equal(event.type, 'failed')
  if (event.type !== 'failed') return
  assert.equal(event.status, 'budget_exhausted')
  assert.equal(event.outcome, 'BUDGET_EXHAUSTED')
  assert.equal(event.reason_code, 'budget_exhausted')
  assert.equal(event.cause_class, 'harness')
  assert.match(event.error, /RESPONSE_EVIDENCE_INVALID/)
  assert.match(event.error, /UNVERIFIED retained candidate/)
})

test('typed context preparation failure survives terminal persistence and stream projection', t => {
  const input = terminalInput(t)
  let persisted: unknown[] = []
  input.effects.finalizeTurn = (...args) => {
    persisted = args
    return { committed: true }
  }
  const event = failChatStream(input, 'Snapshot unavailable: input exceeds the size cap', {
    code: 'context_preparation_failed', cause_class: 'harness', detail: 'workspace_revision',
  })
  assert.equal(event.type, 'failed')
  if (event.type !== 'failed') return
  assert.equal(event.outcome, 'BLOCKED_POLICY')
  assert.equal(event.reason_code, 'context_preparation_failed')
  assert.equal(event.cause_class, 'harness')
  assert.equal(persisted[0], 'BLOCKED_POLICY')
  assert.deepEqual(persisted[2], { code: 'context_preparation_failed', cause_class: 'harness', detail: 'workspace_revision' })
})
