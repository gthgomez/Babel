import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatEngineStreamingLoopHost } from './chatEngineContracts.js'
import { syncEffectiveGatePolicyAtCompletion } from './completionGatePolicy.js'
import { finalizeStreamingTurnLimit } from './chatEngineStreamingFinalizer.js'
import {
  captureGateRejectedCompletionAttempt,
  resetGateRejectedCompletionCapture,
} from './preservedUnverifiedTerminal.js'

test('regression: early pre-synthesis gate syncs host.gatePolicy from frozen verifiers before P1 retain path', async () => {
  const submissionGeneration = 4
  const frozenVerifiers = ['npm test -- --runInBand fixtures/summary.spec.ts']
  const toolCallLog = [{
    tool: 'str_replace',
    target: 'data/summary.csv',
    effect_status: 'confirmed_change' as const,
    mutation_paths: ['data/summary.csv'],
  }]

  const hostShell = {
    terminatingLimiter: undefined as string | undefined,
    terminalLimiterReason: undefined as string | undefined,
    taskClass: 'ordinary_delivery' as const,
    options: { task: 'Deliver net revenue summary from data.csv' },
    toolCallLog,
    gatePolicy: null as ReturnType<typeof syncEffectiveGatePolicyAtCompletion> | null,
    conversation: [
      { role: 'user' as const, content: 'task' },
      { role: 'tool' as const, content: 'wrote summary' },
      { role: 'assistant' as const, content: 'EARLY_GATE_RETAIN net revenue totals 190.' },
    ],
    taskAllowance: { consumed: { turns: 5 }, grant: { turnCap: 5 } },
    lastCriticReceipt: null,
    evaluateCalls: 0,
    getResolvedRequiredVerifiers() {
      return frozenVerifiers
    },
    evaluateCompletionGate(
      _turn: { type: 'completion'; answer: string },
      _intent: 'execute',
    ) {
      this.evaluateCalls += 1
      if (this.evaluateCalls === 1) {
        const expected = syncEffectiveGatePolicyAtCompletion({
          taskClass: this.taskClass,
          task: this.options.task,
          requiredVerifierCommands: frozenVerifiers,
          toolCallLog,
        })
        assert.equal(this.gatePolicy, expected)
        assert.notEqual(this.gatePolicy, null)
        return 'reject'
      }
      return 'allow'
    },
    hasAnyWrites() {
      return true
    },
    buildRejectionMessage() {
      return 'verifier missing'
    },
    isSubmissionCurrent(generation: number) {
      return generation === submissionGeneration
    },
    streamFailed(
      authorityReason: string,
      meta: { code: string; cause_class: string },
      presentationError?: string,
    ) {
      return {
        type: 'failed' as const,
        authorityReason,
        meta,
        presentationError,
      }
    },
    async synthesizeAnswer() {
      throw new Error('synthesizeAnswer must not run when early P1 retain exits')
    },
    detectAndBuildBlockedReport() {
      return null
    },
    runAsymmetricDiffCritic() {
      throw new Error('critic must not run when early P1 retain exits')
    },
    buildCriticBlockedReport() {
      throw new Error('critic must not run when early P1 retain exits')
    },
    buildCriticBlockedAnswer() {
      throw new Error('critic must not run when early P1 retain exits')
    },
    streamDone() {
      throw new Error('streamDone must not run when early P1 retain exits')
    },
  }

  resetGateRejectedCompletionCapture(hostShell)
  captureGateRejectedCompletionAttempt(
    hostShell,
    'EARLY_GATE_RETAIN net revenue totals 190.',
    submissionGeneration,
  )

  const host = hostShell as unknown as ChatEngineStreamingLoopHost
  const events: unknown[] = []
  for await (const event of finalizeStreamingTurnLimit({
    host,
    submissionGeneration,
    allToolObservations: '',
    effectiveExecutePolicy: true,
    effectiveIntent: 'execute',
    maxTurns: 5,
  })) {
    events.push(event)
  }

  assert.equal(hostShell.evaluateCalls, 1)
  assert.equal(events.length, 1)
  const failed = events[0] as {
    type: string
    meta: { code: string; cause_class: string }
    presentationError?: string
  }
  assert.equal(failed.type, 'failed')
  assert.equal(failed.meta.code, 'budget_exhausted')
  assert.equal(failed.meta.cause_class, 'harness')
  assert.match(failed.presentationError ?? '', /EARLY_GATE_RETAIN/)
})
