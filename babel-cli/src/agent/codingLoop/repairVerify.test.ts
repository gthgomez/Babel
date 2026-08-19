import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { compileObservation } from './observationCompiler.js'
import { classifyFailureSurface, isRepeatedSameError } from './failureSurface.js'
import {
  applyWorkingStateEvent,
  createWorkingState,
  formatWorkingStateBlock,
  preserveWorkingStateMessages,
  upsertWorkingStateMessage,
  WORKING_STATE_MARKER,
} from './workingState.js'
import {
  canAuthorizeVerifiedComplete,
  classifyFailureOrigin,
  classifyVerificationCommand,
  isCatOrTypeCommand,
  requiredStagesForRisk,
} from './verificationStages.js'
import { decideProgressIntervention } from './progressSignals.js'
import type { ChatMessage } from '../chatToolDefinitions.js'

function surfaceFrom(stdout: string, stderr: string, command: string, exit = 1) {
  const observation = compileObservation({
    tool: 'run_command',
    target: command,
    command,
    exitCode: exit,
    stdout,
    stderr,
  })
  return classifyFailureSurface({ observation })
}

describe('failure surface + working state + V0-V3 (shipped)', () => {
  test('Jest / Pytest / tsc / build classify to matching surfaces', () => {
    const jestS = surfaceFrom(
      'FAIL src/a.test.ts\n  ● handles cache\n    Expected: 1\nTests: 1 failed',
      '',
      'npx vitest run',
    )
    assert.equal(jestS.kind, 'TEST_FAILURE')

    const py = surfaceFrom(
      'FAILED tests/test_a.py::test_x - AssertionError: boom',
      '',
      'pytest',
    )
    assert.equal(py.kind, 'TEST_FAILURE')

    const tsc = surfaceFrom(
      '',
      'src/a.ts(1,1): error TS2322: Type \'string\' is not assignable to type \'number\'.',
      'npx tsc --noEmit',
    )
    assert.equal(tsc.kind, 'TYPECHECK_FAILURE')

    const build = surfaceFrom('', 'error[E0308]: mismatched types\n  --> src/main.rs:4:5', 'cargo build')
    assert.ok(build.kind === 'BUILD_FAILURE' || build.kind === 'UNKNOWN_FAILURE' || build.kind === 'TYPECHECK_FAILURE')
  })

  test('diagnosis/hypothesis can change after new evidence; same error with no evidence is detected', () => {
    let state = createWorkingState('fix add')
    const first = surfaceFrom('FAIL a.test.ts\n  ● add\n    Expected: 3', '', 'npm test')
    state = applyWorkingStateEvent(state, { type: 'failure_surface', surface: first })
    state = applyWorkingStateEvent(state, {
      type: 'set_hypothesis',
      hypothesis: 'off-by-one in add',
    })
    const second = surfaceFrom('FAIL a.test.ts\n  ● add\n    Expected: 3', '', 'npm test')
    assert.equal(isRepeatedSameError(first, second), true)

    state = applyWorkingStateEvent(state, {
      type: 'add_evidence',
      evidence: 'read src/add.ts: return a - b',
      file: 'src/add.ts',
    })
    state = applyWorkingStateEvent(state, {
      type: 'set_hypothesis',
      hypothesis: 'wrong operator in add',
    })
    assert.equal(state.currentHypothesis, 'wrong operator in add')
    assert.ok(state.invalidatedAssumptions.some((a) => a.includes('off-by-one')))
    assert.ok(state.evidence.some((e) => e.includes('return a - b')))
  })

  test('working state survives compaction and does not re-promote an invalidated hypothesis', () => {
    let state = createWorkingState('goal')
    state = applyWorkingStateEvent(state, { type: 'set_hypothesis', hypothesis: 'stale theory' })
    state = applyWorkingStateEvent(state, { type: 'invalidate', assumption: 'hypothesis:stale theory' })
    assert.equal(state.currentHypothesis, '')

    const messages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'old chatter' },
      { role: 'assistant', content: 'old reply' },
    ]
    const withState = upsertWorkingStateMessage(messages, state)
    const kept = preserveWorkingStateMessages(withState)
    assert.equal(kept.length, 1)
    assert.match(kept[0]!.content, new RegExp(WORKING_STATE_MARKER))
    assert.match(formatWorkingStateBlock(state), /current_hypothesis: ""/)
  })

  test('stale verifier is not treated as current after a mutation', () => {
    let state = createWorkingState('goal')
    state = applyWorkingStateEvent(state, {
      type: 'verifier',
      identity: 'npm-test',
      exitCode: 0,
      summary: 'ok',
    })
    assert.equal(state.lastVerifier?.fresh, true)
    state = applyWorkingStateEvent(state, { type: 'mutation', path: 'src/a.ts' })
    assert.equal(state.lastVerifier?.fresh, false)
    assert.match(formatWorkingStateBlock(state), /stale/)
  })

  test('baseline failure is distinguishable from patch-induced failure', () => {
    assert.equal(
      classifyFailureOrigin({
        baselineExitCode: 0,
        currentExitCode: 1,
        currentSignature: 'new',
      }),
      'patch_induced',
    )
    assert.equal(
      classifyFailureOrigin({
        baselineExitCode: 1,
        baselineSignature: 'sig',
        currentExitCode: 1,
        currentSignature: 'sig',
      }),
      'pre_existing',
    )
  })

  test('acceptance verifier cannot be cat/type; high-risk broadens; stale cannot authorize VERIFIED_COMPLETE', () => {
    assert.equal(isCatOrTypeCommand('cat src/a.ts'), true)
    assert.equal(isCatOrTypeCommand('type src\\a.ts'), true)
    assert.equal(classifyVerificationCommand('cat README.md').isMeaningful, false)
    assert.equal(classifyVerificationCommand('npm test -- src/a.test.ts').isMeaningful, true)

    const high = requiredStagesForRisk({
      filesChanged: 6,
      publicApiChanged: true,
      sharedCoreTouched: true,
      securitySensitive: false,
      configOrBuildChanged: false,
      dependencyChanged: false,
      refactorBreadth: false,
    })
    assert.ok(high.includes('V3'))

    const stale = canAuthorizeVerifiedComplete({
      stagesCompleted: ['V1', 'V2'],
      lastReceiptFresh: false,
      lastReceiptGreen: true,
      acceptanceCommand: 'npm test',
      risk: 'medium',
    })
    assert.equal(stale.allow, false)
    assert.match(stale.reason, /stale_verification/)

    const catAccept = canAuthorizeVerifiedComplete({
      stagesCompleted: ['V1', 'V2'],
      lastReceiptFresh: true,
      lastReceiptGreen: true,
      acceptanceCommand: 'cat src/a.ts',
      risk: 'low',
    })
    assert.equal(catAccept.allow, false)

    const critic = canAuthorizeVerifiedComplete({
      stagesCompleted: ['V1', 'V2', 'V3'],
      lastReceiptFresh: true,
      lastReceiptGreen: true,
      risk: 'high',
      criticFailed: true,
    })
    assert.equal(critic.allow, false)
    assert.match(critic.reason, /critic_failure/)
  })

  test('repeated same error with no new evidence is a nudge, not WRONG_HYPOTHESIS regex', () => {
    const surface = surfaceFrom('FAIL a.test.ts\n  ● add\n    Expected: 3', '', 'npm test')
    const state = applyWorkingStateEvent(createWorkingState('g'), {
      type: 'failure_surface',
      surface,
    })
    const decision = decideProgressIntervention({
      state,
      previousSurface: surface,
      newEvidence: false,
      hypothesisChanged: false,
    })
    assert.equal(decision.level, 'nudge')
    assert.match(decision.message ?? '', /Same error signature/)
  })
})
