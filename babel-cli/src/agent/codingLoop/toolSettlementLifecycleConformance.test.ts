/**
 * Tool settlement / lifecycle conformance for issues 257, 260, 272, and 293.
 * Provider-free. Characterizes the current owners; it does not close the issues.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { classifyToolEffect } from '../../executor/contracts.js'
import {
  findInterruptedEffects,
  loadEffectLedger,
  reconcileInterruptedEffect,
  recordEffectIntent,
} from '../../executor/effectLedger.js'
import type { ChatEngine } from '../chatEngine.js'
import {
  checkpointParityEventLogStrict,
  createParityRuntime,
  parityOnUserTurn,
  parityRecordToolBatch,
  paritySettleInterruptedOnResume,
  paritySettleProposeTools,
  paritySettleToolNotStarted,
  paritySettleToolStarted,
} from '../chatEngineParityBridge.js'
import { checkToolCapability } from '../capabilityBroker.js'
import {
  CHECKPOINT_JOURNAL_FILENAME,
  LiveSessionAuthorityError,
  recoverCheckpointArtifacts,
  resolveLiveSessionAuthority,
  writeCheckpointJournal,
} from '../liveSessionBridge.js'
import {
  interruptedToolRecoveries,
  planToolSettle,
  recordToolTerminal,
  type SessionEvent,
} from '../sessionEvents.js'
import {
  closeProtocolHostState,
  createProtocolHostState,
  handleProtocolRequest,
} from '../../protocol/client/host.js'
import { isJsonRpcErrorResponse } from '../../protocol/jsonRpc.js'
import { BabelProtocolErrorCode } from '../../protocol/types.js'
import { openAdmissionStore, type AdmissionStore } from '../../runtime/admission.js'
import type { CommandDigestInput } from '../../runtime/admissionContracts.js'
import { ADMISSION_FAULT_HOOK, type AdmissionFaultPoint } from '../../runtime/admissionTestHooks.js'
import { inspectCommittedState } from '../../runtime/recovery.js'
import { rebuildPairedToolTurn } from './toolIdentity.js'

const FIXED_NOW = () => new Date('2026-10-11T00:00:00.000Z')

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function toolResults(events: readonly { kind: string }[]): number {
  return events.filter((event) => event.kind === 'tool_result').length
}

function terminals(events: readonly SessionEvent[]): SessionEvent[] {
  return events.filter((event) =>
    event.kind === 'tool_completed' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled',
  )
}

function startedRun(root: string, id: string) {
  const runtime = createParityRuntime(`thread-${id}`)
  parityOnUserTurn(runtime, {
    task: 'settle one command',
    model: 'fixture-model',
    provider: 'fixture-provider',
    projectRoot: root,
  })
  paritySettleProposeTools(runtime, [{ id, name: 'run_command', argsDigest: 'digest-run' }])
  assert.equal(paritySettleToolStarted(runtime, { id, name: 'run_command' }), true)
  return runtime
}

function commandInput(commandId: string): CommandDigestInput {
  return {
    threadId: 'thread-1',
    taskId: 'task-1',
    commandId,
    mode: 'chat',
    resolvedOperationPolicy: { mutation: 'normal', approval: 'interactive' },
    taskShapeClass: 'edit',
    targetRoot: '/work',
    offeredToolSchemaVersion: 'tools-v1',
    contextSnapshotId: 'ctx-1',
    payload: { command: 'publish', args: { path: 'a.txt' } },
  }
}

function openStore(root: string, runDir: string, hook?: (point: AdmissionFaultPoint) => void): AdmissionStore {
  const opened = openAdmissionStore({
    authorizedRoot: root,
    runDir,
    now: FIXED_NOW,
    ...(hook ? { [ADMISSION_FAULT_HOOK]: hook } : {}),
  })
  if (!opened.ok) throw new Error(`${opened.reasonCode}: ${opened.detail}`)
  return opened.store
}

test('interruption before a tool result is published stays unknown, not success', () => {
  const root = tempDir('babel-settle-interrupt-')
  try {
    const runtime = startedRun(root, 'call-open')
    assert.equal(toolResults(runtime.eventLog.events), 0)
    assert.equal(terminals(runtime.sessionEvents.events).length, 0)
    const open = interruptedToolRecoveries(runtime.sessionEvents)
    assert.equal(open.length, 1)
    assert.equal(open[0]?.state, 'TOOL_OUTCOME_UNKNOWN')
    assert.equal(open[0]?.effectClass, 'non_idempotent_local_effect')
    assert.equal(open[0]?.reconciliation, 'manual_review_no_auto_retry')

    assert.equal(paritySettleInterruptedOnResume(runtime), 1)
    const settled = terminals(runtime.sessionEvents.events)
    assert.equal(settled.length, 1)
    assert.equal(settled[0]?.kind, 'tool_cancelled')
    if (settled[0]?.kind === 'tool_cancelled') {
      assert.equal(settled[0].recovery_state, 'TOOL_OUTCOME_UNKNOWN')
    }
    assert.equal(toolResults(runtime.eventLog.events), 0)

    const proposedOnly = createParityRuntime('thread-not-started')
    parityOnUserTurn(proposedOnly, {
      task: 'do not dispatch',
      model: 'fixture-model',
      provider: 'fixture-provider',
      projectRoot: root,
    })
    paritySettleProposeTools(proposedOnly, [{ id: 'call-proposed', name: 'run_command' }])
    assert.equal(interruptedToolRecoveries(proposedOnly.sessionEvents)[0]?.state, 'TOOL_NOT_STARTED')
    assert.equal(paritySettleToolNotStarted(proposedOnly, { id: 'call-proposed', name: 'run_command' }), true)
    const notStarted = terminals(proposedOnly.sessionEvents.events)
    assert.equal(notStarted.length, 1)
    assert.equal(notStarted[0]?.kind, 'tool_cancelled')
    if (notStarted[0]?.kind === 'tool_cancelled') {
      assert.equal(notStarted[0].recovery_state, 'TOOL_NOT_STARTED')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a late result after terminal settlement is not published', () => {
  const root = tempDir('babel-settle-late-')
  try {
    const runtime = startedRun(root, 'call-late')
    paritySettleInterruptedOnResume(runtime)
    const beforeResults = toolResults(runtime.eventLog.events)
    const beforeTerminals = terminals(runtime.sessionEvents.events).length

    parityRecordToolBatch(runtime, {
      at_turn: 1,
      settleAlreadyProposed: true,
      toolCalls: [{
        id: 'call-late',
        type: 'function',
        function: { name: 'run_command', arguments: '{}' },
      }],
      results: [{
        tool_call_id: 'call-late',
        tool_name: 'run_command',
        content: 'late success',
        exit_code: 0,
      }],
    })

    assert.equal(terminals(runtime.sessionEvents.events).length, beforeTerminals)
    assert.equal(
      runtime.sessionEvents.events.some((event) => event.kind === 'tool_completed'),
      false,
    )
    assert.equal(
      toolResults(runtime.eventLog.events),
      beforeResults,
      'late tool_result was published after TOOL_OUTCOME_UNKNOWN settlement',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a pre-dispatch denial still records its first observation after TOOL_NOT_STARTED', () => {
  const root = tempDir('babel-settle-denial-')
  try {
    const runtime = createParityRuntime('thread-call-denied')
    parityOnUserTurn(runtime, {
      task: 'settle one command',
      model: 'fixture-model',
      provider: 'fixture-provider',
      projectRoot: root,
    })
    paritySettleProposeTools(runtime, [{ id: 'call-denied', name: 'run_command', argsDigest: 'digest-run' }])
    assert.equal(paritySettleToolNotStarted(runtime, { id: 'call-denied', name: 'run_command' }), true)
    const before = toolResults(runtime.eventLog.events)
    parityRecordToolBatch(runtime, {
      at_turn: 1,
      settleAlreadyProposed: true,
      toolCalls: [{
        id: 'call-denied',
        type: 'function',
        function: { name: 'run_command', arguments: '{}' },
      }],
      results: [{
        tool_call_id: 'call-denied',
        tool_name: 'run_command',
        content: 'denied before dispatch',
        exit_code: 1,
      }],
    })
    assert.equal(toolResults(runtime.eventLog.events), before + 1)
    const closed = terminals(runtime.sessionEvents.events)
    assert.equal(closed.length, 1)
    assert.equal(closed[0]?.kind, 'tool_cancelled')
    if (closed[0]?.kind === 'tool_cancelled') {
      assert.equal(closed[0].recovery_state, 'TOOL_NOT_STARTED')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the same idempotency key cannot settle twice or run again', () => {
  const root = tempDir('babel-settle-dup-')
  try {
    const runtime = startedRun(root, 'call-once')
    parityRecordToolBatch(runtime, {
      at_turn: 1,
      settleAlreadyProposed: true,
      toolCalls: [{
        id: 'call-once',
        type: 'function',
        function: { name: 'run_command', arguments: '{}' },
      }],
      results: [{
        tool_call_id: 'call-once',
        tool_name: 'run_command',
        content: 'once',
        exit_code: 0,
      }],
    })
    const completed = terminals(runtime.sessionEvents.events)
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.kind, 'tool_completed')

    assert.throws(
      () => recordToolTerminal(runtime.sessionEvents, {
        turn_id: runtime.turnId ?? 'turn',
        tool_call_id: 'call-once',
        tool_name: 'run_command',
        idempotency_key: 'call-once',
        content: 'duplicate success',
        exit_code: 0,
      }),
      /tool lifecycle cannot record a terminal after a terminal/,
    )
    assert.equal(terminals(runtime.sessionEvents.events).length, 1)

    const plan = planToolSettle(runtime.sessionEvents, [{
      idempotency_key: 'call-once',
      tool_call_id: 'call-once',
      tool_name: 'run_command',
    }])
    assert.deepEqual(plan.execute, [])
    assert.equal(plan.skip.length, 1)
    const denied = checkToolCapability({
      toolName: 'run_command',
      mode: 'chat',
      allowedEffects: ['non_idempotent_local_effect'],
      idempotencyKey: 'call-once',
      completedIdempotencyKeys: ['call-once'],
    })
    assert.equal(denied.allowed, false)
    assert.equal(denied.denial, 'idempotency_replay')

    const paired = rebuildPairedToolTurn({
      turn: 1,
      requests: [
        { actionIndex: 0, providerId: 'call-once', tool: 'run_command', target: 'a' },
        { actionIndex: 1, providerId: 'call-other', tool: 'read_file', target: 'b' },
      ],
      completionsInArrivalOrder: [
        { actionIndex: 1, content: 'late-other', exit_code: 0 },
        { actionIndex: 0, content: 'once', exit_code: 0 },
      ],
    })
    assert.equal(paired.lifecycleOk, true)
    assert.equal(paired.paired[0]?.toolCallId, 'call-once')
    assert.equal(paired.paired[0]?.result.content, 'once')
    assert.equal(paired.paired[1]?.toolCallId, 'call-other')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('protocol command_id replays one admission and rejects a different payload', async () => {
  const root = tempDir('babel-settle-protocol-')
  const previousRuns = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  const executions = { count: 0 }
  let release: (() => void) | undefined
  const host = createProtocolHostState({
    executeWithoutNotifications: true,
    engineFactory: () => ({
      async *submitMessageStream() {
        executions.count += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        yield { type: 'done', answer: 'ok' }
      },
      cancel() {
        release?.()
      },
    }) as unknown as ChatEngine,
  })
  try {
    const created = await handleProtocolRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'thread.create',
      params: { project_root: root },
    }, host)
    assert.equal(isJsonRpcErrorResponse(created), false)
    if (isJsonRpcErrorResponse(created)) return
    const threadId = (created.result as { thread_id: string }).thread_id
    const first = await handleProtocolRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'turn.submit',
      params: { thread_id: threadId, message: 'same body', command_id: 'cmd-same' },
    }, host)
    const again = await handleProtocolRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'turn.submit',
      params: { thread_id: threadId, message: 'same body', command_id: 'cmd-same' },
    }, host)
    assert.equal(isJsonRpcErrorResponse(first), false)
    assert.equal(isJsonRpcErrorResponse(again), false)
    if (isJsonRpcErrorResponse(first) || isJsonRpcErrorResponse(again)) return
    assert.deepEqual(again.result, first.result)
    assert.equal(executions.count, 1)
    const mutated = await handleProtocolRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'turn.submit',
      params: { thread_id: threadId, message: 'other body', command_id: 'cmd-same' },
    }, host)
    assert.equal(isJsonRpcErrorResponse(mutated), true)
    if (!isJsonRpcErrorResponse(mutated)) return
    assert.equal(mutated.error.code, BabelProtocolErrorCode.INVALID_PARAMS)
    assert.equal(executions.count, 1)
  } finally {
    release?.()
    closeProtocolHostState(host)
    if (previousRuns === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRuns
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unknown in-flight side effect stays unknown across restart settlement', () => {
  const root = tempDir('babel-settle-unknown-')
  const runDir = join(root, 'runs', 'run-1')
  try {
    assert.equal(classifyToolEffect('mystery_publisher'), 'external_side_effect')
    const intent = recordEffectIntent({
      runDir,
      sessionId: 'session-1',
      turnId: 'turn-1',
      mutationBatchId: 'batch-1',
      effectClass: 'external_side_effect',
      toolName: 'mystery_publisher',
      targetPaths: ['a.txt'],
      preImageHashes: { 'a.txt': 'before' },
      intendedContent: 'after',
    })
    const store = openStore(root, runDir)
    const admitted = store.admitCommand({
      digestInput: commandInput('cmd-unknown'),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'external_side_effect',
      operationId: 'op-external',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    })
    assert.equal(admitted.kind, 'admitted')
    const replay = store.admitCommand({
      digestInput: commandInput('cmd-unknown'),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'external_side_effect',
      operationId: 'op-external',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    })
    // An unsettled claim is still in flight. 'replayed' is only the post-settle duplicate.
    assert.equal(replay.kind, 'pending')
    store.close()

    assert.equal(findInterruptedEffects(loadEffectLedger(runDir)).some((row) => row.operationId === intent.operationId), true)
    assert.equal(
      reconcileInterruptedEffect({
        effectClass: 'external_side_effect',
        preImageHashes: { 'a.txt': 'before' },
        postImageHashes: { 'a.txt': 'after' },
      }, { 'a.txt': 'after' }),
      'manual_review',
    )

    const report = inspectCommittedState({
      authorizedRoot: root,
      runDir,
      threadId: 'thread-1',
      currentImageHashes: { 'a.txt': 'after' },
      detection: { processStarted: true, hasUnfinishedEffect: true },
      now: FIXED_NOW,
    })
    assert.equal(report.automaticResume, false)
    assert.equal(report.interruptionClass, 'process_restart')
    const external = report.operations.filter((operation) => operation.effectClass === 'external_side_effect')
    assert.ok(external.length >= 2, 'ledger intent and admitted outbox both remain visible')
    for (const operation of external) {
      assert.notEqual(operation.state, 'completed')
      assert.equal(operation.automaticRetryAllowed, false)
    }
    assert.ok(external.some((operation) => operation.operationId === intent.operationId))
    assert.ok(external.some((operation) => operation.operationId === 'op-external'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed terminal commit is not published, and sidecar cleanup failure is not success', async () => {
  const root = tempDir('babel-settle-cleanup-')
  const runDir = join(root, 'runs', 'run-1')
  try {
    const store = openStore(root, runDir, (point) => {
      if (point === 'before_terminal_commit') throw new Error('simulated crash before terminal commit')
    })
    const admitted = store.admitCommand({
      digestInput: commandInput('cmd-commit'),
      ownerGeneration: 1,
      ownerToken: 'token-1',
      effectClass: 'external_side_effect',
      operationId: 'op-commit',
      preImageHashes: { 'a.txt': 'before' },
      postImageHashes: { 'a.txt': 'after' },
    })
    assert.equal(admitted.kind, 'admitted')
    assert.throws(
      () => store.settleAdmission({
        threadId: 'thread-1',
        commandId: 'cmd-commit',
        ownerGeneration: 1,
        ownerToken: 'token-1',
        state: 'settled',
        outcome: { ok: true },
        outbox: { state: 'committed', postImageHashes: { 'a.txt': 'after' } },
      }),
      /simulated crash before terminal commit/,
    )
    assert.equal(store.readAdmission('thread-1', 'cmd-commit')?.state, 'claimed')
    if (admitted.kind === 'admitted') {
      assert.equal(store.readOutbox(admitted.record.admissionId)?.state, 'intent')
    }
    store.close()
    const restarted = inspectCommittedState({
      authorizedRoot: root,
      runDir,
      threadId: 'thread-1',
      currentImageHashes: { 'a.txt': 'after' },
      detection: { processStarted: true, hasUnfinishedEffect: true },
      now: FIXED_NOW,
    })
    const committed = restarted.operations.find((operation) => operation.operationId === 'op-commit')
    assert.ok(committed)
    assert.notEqual(committed?.state, 'completed')
    assert.equal(committed?.automaticRetryAllowed, false)

    const checkpointRoot = join(root, 'checkpoint')
    mkdirSync(checkpointRoot)
    const runtime = createParityRuntime('checkpoint-thread')
    runtime.liveAuthority = resolveLiveSessionAuthority({
      mode: 'chat',
      projectRoot: checkpointRoot,
      task: 'checkpoint fixture',
    })
    const blocked = await checkpointParityEventLogStrict(runtime, checkpointRoot, {
      injectCommitFailureAfter: 0,
    })
    assert.equal(blocked.status, 'blocked')
    assert.notEqual(blocked.status, 'committed')
    assert.equal(runtime.sessionEvents.flushedThroughSeq, -1)

    const recoveryDir = join(root, 'recovery')
    mkdirSync(recoveryDir)
    const batchId = 'batch-cleanup'
    writeFileSync(join(recoveryDir, 'note.txt'), 'restored\n', 'utf8')
    mkdirSync(join(recoveryDir, `note.txt.${batchId}.bak`))
    writeCheckpointJournal(recoveryDir, {
      schema_version: 1,
      batch_id: batchId,
      status: 'committed',
      backups_ready: true,
      targets: ['note.txt'],
    })
    assert.throws(
      () => recoverCheckpointArtifacts(recoveryDir),
      (error: unknown) => error instanceof LiveSessionAuthorityError && error.code === 'CHECKPOINT_RECOVERY_FAILED',
    )
    const journal = JSON.parse(readFileSync(join(recoveryDir, CHECKPOINT_JOURNAL_FILENAME), 'utf8')) as { status: string }
    // recoverCheckpointArtifacts writes status committed before removing sidecars.
    assert.equal(journal.status, 'committed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
