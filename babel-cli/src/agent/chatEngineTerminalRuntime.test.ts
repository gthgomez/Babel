import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
import {
  cancelChatStream,
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
      finalizeTurn: () => {},
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

test('keeps a read-only hard-cap outcome coherent with its structured budget reason', (t) => {
  const input = terminalInput(t)
  input.snapshot.outcome.terminatingLimiter = 'turns'
  const event = completeChatStream(input, 'Inspection stopped at the limit')
  assert.ok(event.type === 'done')
  assert.equal(event.outcome, 'BUDGET_EXHAUSTED')
  assert.equal(event.status, 'budget_exhausted')
  assert.equal(event.reason_code, 'budget_exhausted')
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
