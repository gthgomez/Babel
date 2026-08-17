/**
 * Regression suite for the 2026-08-15 session-event lifecycle incident.
 * Test 5 is the mandatory request-order != completion-order reproducer.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createSessionEventLog,
  markInterruptedToolsOnResume,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordTurnEnded,
  recordUserSubmitted,
  rewriteSessionEventLog,
  shouldSkipToolReExec,
  type SessionEventLog,
} from './sessionEvents.js'
import { SessionEventLifecycleCausalityError } from './sessionEventDiagnostics.js'
import type { SessionEvent } from './sessionEvents.js'
import {
  formatSessionRunValidatorText,
  validateSessionEventLog,
} from './sessionRunValidator.js'
import {
  projectDurableToolBatch,
  projectDurableToolBatchBySlicePosition,
  resolveActionToolCallId,
  type DurableToolLogRow,
} from './toolExecutionIdentity.js'
import { ChatEngine, type ChatEvent } from './chatEngine.js'
import { ProgressController } from './progressController.js'
import type { ToolStreamEvent } from '../runners/base.js'

const PROVIDER_IDS = [
  'call_00_M7L5Dq8bFICnERtjDy0e4133',
  'call_01_YQ2rVs1LCpXhgHflkP668215',
  'call_02_YwzqQfLha7lVrA0p9tt21038',
] as const

function settleProjected(
  log: SessionEventLog,
  turnSlice: readonly DurableToolLogRow[],
  ids: readonly string[],
  mode: 'index' | 'position',
  batchId?: string,
): void {
  const projected =
    mode === 'position'
      ? projectDurableToolBatchBySlicePosition({
          turnSlice,
          turn: 0,
          providerToolCallIds: ids,
        })
      : projectDurableToolBatch({
          turnSlice,
          turn: 0,
          providerToolCallIds: ids,
          ...(batchId !== undefined ? { batchId } : {}),
        })
  for (const row of projected.results) {
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: row.tool_call_id,
      tool_name: row.tool_name,
      idempotency_key: row.tool_call_id,
      exit_code: 0,
      content: row.content || 'ok',
      action_index: row.action_index,
      batch_id: row.batch_id,
      target_summary: row.target,
    })
  }
}

function proposeAndStart(
  log: SessionEventLog,
  tools: Array<{ id: string; name: string; index?: number; target?: string; batchId?: string }>,
): void {
  for (const [position, tool] of tools.entries()) {
    const actionIndex = tool.index ?? position
    recordToolProposed(log, {
      turn_id: 't1',
      tool_call_id: tool.id,
      tool_name: tool.name,
      idempotency_key: tool.id,
      action_index: actionIndex,
      ...(tool.batchId ? { batch_id: tool.batchId } : {}),
      ...(tool.target ? { target_summary: tool.target } : {}),
    })
  }
  for (const [position, tool] of tools.entries()) {
    const actionIndex = tool.index ?? position
    recordToolStarted(log, {
      turn_id: 't1',
      tool_call_id: tool.id,
      tool_name: tool.name,
      idempotency_key: tool.id,
      action_index: actionIndex,
      ...(tool.batchId ? { batch_id: tool.batchId } : {}),
      ...(tool.target ? { target_summary: tool.target } : {}),
    })
  }
}

function lifecycleOf(log: SessionEventLog, id: string) {
  const events = log.events.filter(
    (event) =>
      (event.kind === 'tool_proposed' ||
        event.kind === 'tool_started' ||
        event.kind === 'tool_completed' ||
        event.kind === 'tool_failed' ||
        event.kind === 'tool_cancelled') &&
      event.tool_call_id === id,
  )
  return {
    kinds: events.map((event) => event.kind),
    names: [...new Set(events.map((event) => ('tool_name' in event ? event.tool_name : '')))],
    keys: [...new Set(events.map((event) => ('idempotency_key' in event ? event.idempotency_key : '')))],
  }
}

describe('session-event lifecycle — required regressions', () => {
  test('Test 1 — proposed -> started -> completed keeps identity', () => {
    const log = createSessionEventLog('t1-complete')
    proposeAndStart(log, [{ id: 'c1', name: 'read_file' }])
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'read_file',
      idempotency_key: 'c1',
      exit_code: 0,
      content: 'ok',
    })
    const cycle = lifecycleOf(log, 'c1')
    assert.deepEqual(cycle.kinds, ['tool_proposed', 'tool_started', 'tool_completed'])
    assert.deepEqual(cycle.names, ['read_file'])
    assert.deepEqual(cycle.keys, ['c1'])
  })

  test('Test 2 — proposed -> started -> failed', () => {
    const log = createSessionEventLog('t2-failed')
    proposeAndStart(log, [{ id: 'c1', name: 'read_file' }])
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'read_file',
      idempotency_key: 'c1',
      failed: true,
      exit_code: 1,
      content: 'nope',
    })
    assert.deepEqual(lifecycleOf(log, 'c1').kinds, ['tool_proposed', 'tool_started', 'tool_failed'])
  })

  test('Test 3 — proposed -> started -> cancelled after dispatch', () => {
    const log = createSessionEventLog('t3-cancelled')
    proposeAndStart(log, [{ id: 'c1', name: 'read_file' }])
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'read_file',
      idempotency_key: 'c1',
      cancelled: true,
      reason: 'operator_abort',
    })
    assert.deepEqual(lifecycleOf(log, 'c1').kinds, ['tool_proposed', 'tool_started', 'tool_cancelled'])
  })

  test('Test 4 — proposed -> cancelled(TOOL_NOT_STARTED) with no start', () => {
    const log = createSessionEventLog('t4-not-started')
    recordToolProposed(log, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'write_file',
      idempotency_key: 'c1',
    })
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'write_file',
      idempotency_key: 'c1',
      cancelled: true,
      recovery_state: 'TOOL_NOT_STARTED',
    })
    assert.equal(log.events.filter((event) => event.kind === 'tool_started').length, 0)
    assert.deepEqual(lifecycleOf(log, 'c1').kinds, ['tool_proposed', 'tool_cancelled'])
  })

  test('Test 5 — request order != completion order (incident topology)', () => {
    const tools = [
      { id: PROVIDER_IDS[0], name: 'read_file' },
      { id: PROVIDER_IDS[1], name: 'list_dir' },
      { id: PROVIDER_IDS[2], name: 'list_dir' },
    ]
    const completionOrdered: DurableToolLogRow[] = [
      { tool: 'list_dir', target: 'scripts', index: 1 },
      { tool: 'list_dir', target: 'scenes', index: 2 },
      { tool: 'read_file', target: 'SIMLIFE_ROADMAP_2026.md', index: 0 },
    ]

    const before = createSessionEventLog('incident-before')
    proposeAndStart(before, tools)
    assert.throws(
      () => settleProjected(before, completionOrdered, PROVIDER_IDS, 'position'),
      (error: unknown) => {
        assert.ok(error instanceof SessionEventLifecycleCausalityError)
        assert.match(
          error.message,
          /terminal tool event requires one prior tool_proposed and tool_started/,
        )
        assert.equal(error.diagnostic.tool_call_id, PROVIDER_IDS[0])
        assert.equal(error.diagnostic.tool_name, 'list_dir')
        return true
      },
    )

    const after = createSessionEventLog('incident-after')
    proposeAndStart(after, tools)
    settleProjected(after, completionOrdered, PROVIDER_IDS, 'index')
    for (const tool of tools) {
      const cycle = lifecycleOf(after, tool.id)
      assert.deepEqual(cycle.kinds, ['tool_proposed', 'tool_started', 'tool_completed'])
      assert.deepEqual(cycle.names, [tool.name])
      assert.deepEqual(cycle.keys, [tool.id])
    }
    const result = validateSessionEventLog(after)
    assert.equal(result.status, 'PASS', formatSessionRunValidatorText(result))
  })

  test('Test 6 — mixed batch classifies independently', () => {
    const log = createSessionEventLog('mixed-batch')
    recordToolProposed(log, { turn_id: 't1', tool_call_id: 'ok', tool_name: 'read_file', idempotency_key: 'ok' })
    recordToolProposed(log, { turn_id: 't1', tool_call_id: 'cache', tool_name: 'read_file', idempotency_key: 'cache' })
    recordToolProposed(log, { turn_id: 't1', tool_call_id: 'deny', tool_name: 'write_file', idempotency_key: 'deny' })
    recordToolProposed(log, { turn_id: 't1', tool_call_id: 'fail', tool_name: 'read_file', idempotency_key: 'fail' })
    recordToolStarted(log, { turn_id: 't1', tool_call_id: 'ok', tool_name: 'read_file', idempotency_key: 'ok' })
    recordToolStarted(log, { turn_id: 't1', tool_call_id: 'cache', tool_name: 'read_file', idempotency_key: 'cache' })
    recordToolStarted(log, { turn_id: 't1', tool_call_id: 'fail', tool_name: 'read_file', idempotency_key: 'fail' })
    recordToolTerminal(log, {
      turn_id: 't1', tool_call_id: 'ok', tool_name: 'read_file', idempotency_key: 'ok', exit_code: 0, content: 'ok',
    })
    recordToolTerminal(log, {
      turn_id: 't1', tool_call_id: 'cache', tool_name: 'read_file', idempotency_key: 'cache', exit_code: 0, content: 'cached',
    })
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'deny',
      tool_name: 'write_file',
      idempotency_key: 'deny',
      cancelled: true,
      recovery_state: 'TOOL_NOT_STARTED',
    })
    recordToolTerminal(log, {
      turn_id: 't1', tool_call_id: 'fail', tool_name: 'read_file', idempotency_key: 'fail', failed: true, exit_code: 1,
    })
    assert.deepEqual(lifecycleOf(log, 'ok').kinds, ['tool_proposed', 'tool_started', 'tool_completed'])
    assert.deepEqual(lifecycleOf(log, 'cache').kinds, ['tool_proposed', 'tool_started', 'tool_completed'])
    assert.deepEqual(lifecycleOf(log, 'deny').kinds, ['tool_proposed', 'tool_cancelled'])
    assert.deepEqual(lifecycleOf(log, 'fail').kinds, ['tool_proposed', 'tool_started', 'tool_failed'])
    assert.equal(validateSessionEventLog(log).status, 'PASS')
  })

  test('Test 7 — native-looking provider IDs in reverse completion order', () => {
    const ids = ['call_00_aaa', 'call_01_bbb', 'call_02_ccc']
    const log = createSessionEventLog('native-ids')
    proposeAndStart(log, [
      { id: ids[0]!, name: 'read_file' },
      { id: ids[1]!, name: 'read_file' },
      { id: ids[2]!, name: 'read_file' },
    ])
    settleProjected(
      log,
      [
        { tool: 'read_file', target: 'c', index: 2 },
        { tool: 'read_file', target: 'b', index: 1 },
        { tool: 'read_file', target: 'a', index: 0 },
      ],
      ids,
      'index',
    )
    assert.deepEqual(lifecycleOf(log, ids[2]!).kinds, ['tool_proposed', 'tool_started', 'tool_completed'])
  })

  test('Test 8 — synthetic fallback IDs stay unique across tools, batches, and turns', () => {
    const seen = new Set<string>()
    for (const turn of [0, 1]) {
      for (const actionIndex of [0, 1, 2]) {
        const id = resolveActionToolCallId({ actionIndex, turn })
        assert.equal(seen.has(id), false, `duplicate synthetic id ${id}`)
        seen.add(id)
      }
    }
    assert.equal(seen.size, 6)
    assert.equal(resolveActionToolCallId({ actionIndex: 0, turn: 0 }), 'tool_call_0_0')
    assert.equal(resolveActionToolCallId({ actionIndex: 0, turn: 1 }), 'tool_call_1_0')
  })

  test('Test 9 — turn N IDs do not correlate with turn N+1', () => {
    const log = createSessionEventLog('multi-turn')
    recordUserSubmitted(log, { turn_id: 'turn-0', task: 'first' })
    proposeAndStart(log, [{ id: 'tool_call_0_0', name: 'read_file' }])
    recordToolTerminal(log, {
      turn_id: 'turn-0',
      tool_call_id: 'tool_call_0_0',
      tool_name: 'read_file',
      idempotency_key: 'tool_call_0_0',
      exit_code: 0,
      content: 'ok',
    })
    recordTurnEnded(log, { turn_id: 'turn-0', outcome: 'NO_CHANGE_REQUIRED', status: 'completed' })
    recordUserSubmitted(log, { turn_id: 'turn-1', task: 'second' })
    recordToolProposed(log, {
      turn_id: 'turn-1',
      tool_call_id: 'tool_call_1_0',
      tool_name: 'read_file',
      idempotency_key: 'tool_call_1_0',
    })
    recordToolStarted(log, {
      turn_id: 'turn-1',
      tool_call_id: 'tool_call_1_0',
      tool_name: 'read_file',
      idempotency_key: 'tool_call_1_0',
    })
    recordToolTerminal(log, {
      turn_id: 'turn-1',
      tool_call_id: 'tool_call_1_0',
      tool_name: 'read_file',
      idempotency_key: 'tool_call_1_0',
      exit_code: 0,
      content: 'ok',
    })
    const turn0 = log.events.filter((event) => event.turn_id === 'turn-0' && 'tool_call_id' in event)
    const turn1 = log.events.filter((event) => event.turn_id === 'turn-1' && 'tool_call_id' in event)
    assert.ok(turn0.every((event) => 'tool_call_id' in event && event.tool_call_id === 'tool_call_0_0'))
    assert.ok(turn1.every((event) => 'tool_call_id' in event && event.tool_call_id === 'tool_call_1_0'))
    assert.equal(validateSessionEventLog(log).status, 'PASS')
  })

  test('Test 10 — resume mid-tool marks started work unknown, does not complete it', () => {
    const log = createSessionEventLog('resume-mid')
    proposeAndStart(log, [{ id: 'c1', name: 'read_file' }])
    const marked = markInterruptedToolsOnResume(log)
    assert.equal(marked.length, 1)
    assert.equal(marked[0]?.kind, 'tool_cancelled')
    if (marked[0]?.kind === 'tool_cancelled') {
      assert.equal(marked[0].recovery_state, 'TOOL_OUTCOME_UNKNOWN')
    }
    assert.equal(log.events.some((event) => event.kind === 'tool_completed'), false)
  })

  test('Test 11 — completed mutating tool is not replayed on resume', () => {
    const log = createSessionEventLog('resume-complete')
    proposeAndStart(log, [{ id: 'write-1', name: 'write_file' }])
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: 'write-1',
      tool_name: 'write_file',
      idempotency_key: 'write-1',
      exit_code: 0,
      content: 'wrote',
    })
    assert.equal(shouldSkipToolReExec(log, 'write-1'), true)
    assert.equal(markInterruptedToolsOnResume(log).length, 0)
  })

  test('Test 12 — parallel batch then progress nudge leaves lifecycle valid', () => {
    const log = createSessionEventLog('nudge-after-parallel')
    const tools = [
      { id: PROVIDER_IDS[0], name: 'read_file' },
      { id: PROVIDER_IDS[1], name: 'list_dir' },
      { id: PROVIDER_IDS[2], name: 'list_dir' },
    ]
    proposeAndStart(log, tools)
    settleProjected(
      log,
      [
        { tool: 'list_dir', target: 'scripts', index: 1 },
        { tool: 'list_dir', target: 'scenes', index: 2 },
        { tool: 'read_file', target: 'roadmap.md', index: 0 },
      ],
      PROVIDER_IDS,
      'index',
    )
    const controller = new ProgressController()
    controller.scoreTurn([], false, 0)
    controller.scoreTurn([], false, 0)
    const third = controller.scoreTurn([], false, 0)
    assert.equal(third.intervention, 'nudge')
    assert.equal(third.transitioned, true)
    assert.equal(validateSessionEventLog(log).status, 'PASS')
  })

  test('Test 13 — SimLife incident-shaped fixture settles without append failure', () => {
    const log = createSessionEventLog('simlife-fixture')
    const batches: Array<Array<{ id: string; name: string; index: number; target: string }>> = [
      [
        { id: 'call_00_list', name: 'list_dir', index: 0, target: 'SimLife' },
        { id: 'call_01_ctx', name: 'read_file', index: 1, target: 'SimLife/PROJECT_CONTEXT.md' },
      ],
      [
        { id: 'call_00_state', name: 'read_file', index: 0, target: 'SimLife/CURRENT_STATE.md' },
        { id: 'call_01_readme', name: 'read_file', index: 1, target: 'SimLife/README.md' },
      ],
      [
        { id: 'call_00_road', name: 'read_file', index: 0, target: 'SimLife/SIMLIFE_ROADMAP_2026.md' },
        { id: 'call_01_scripts', name: 'list_dir', index: 1, target: 'SimLife/scripts' },
        { id: 'call_02_scenes', name: 'list_dir', index: 2, target: 'SimLife/scenes' },
      ],
    ]
    for (const batch of batches) {
      proposeAndStart(log, batch.map((row) => ({ id: row.id, name: row.name })))
      const reversed = [...batch].reverse()
      settleProjected(
        log,
        reversed.map((row) => ({ tool: row.name, target: row.target, index: row.index })),
        batch.map((row) => row.id),
        'index',
      )
    }
    assert.equal(validateSessionEventLog(log).status, 'PASS', formatSessionRunValidatorText(validateSessionEventLog(log)))
    assert.equal(log.events.filter((event) => event.kind === 'tool_completed').length, 7)
  })

  test('Test 15 — three same-name read_file calls keep distinct target/content under reversed completion', () => {
    const ids = ['call_00_aaa', 'call_01_bbb', 'call_02_ccc']
    const rows: DurableToolLogRow[] = [
      { tool: 'read_file', target: 'CURRENT_STATE.md', index: 0, stdout: 'state-content' },
      { tool: 'read_file', target: 'README.md', index: 1, stdout: 'readme-content' },
      { tool: 'read_file', target: 'SIMLIFE_ROADMAP_2026.md', index: 2, stdout: 'roadmap-content' },
    ]

    const projected = projectDurableToolBatch({
      turnSlice: [...rows].reverse(),
      turn: 0,
      providerToolCallIds: ids,
    })
    // Completion order differs from request order.
    assert.equal(projected.parallelCompletionReorders, 3)
    // Each provider id keeps its own original target and content — never slice position.
    for (const row of rows) {
      const result = projected.results.find((r) => r.tool_call_id === ids[row.index])
      assert.ok(result, `result for ${ids[row.index]}`)
      assert.equal(result.target, row.target)
      assert.equal(result.content, row.stdout)
    }
    // Durable assistant_tool_calls keep provider request order.
    assert.deepEqual(projected.toolCalls.map((c) => c.id), [...ids])

    // The gold-standard log also validates with correlation persisted end-to-end.
    const log = createSessionEventLog('same-name-identity')
    proposeAndStart(
      log,
      ids.map((id, index) => ({ id, name: 'read_file', target: rows[index]!.target, batchId: 'b1' })),
    )
    settleProjected(log, [...rows].reverse(), ids, 'index', 'b1')
    const result = validateSessionEventLog(log)
    assert.equal(result.status, 'PASS', formatSessionRunValidatorText(result))
    for (const row of rows) {
      const terminal = log.events.find(
        (event): event is Extract<SessionEvent, { kind: 'tool_completed' }> =>
          event.kind === 'tool_completed' && event.tool_call_id === ids[row.index],
      )
      assert.ok(terminal, `terminal for ${ids[row.index]}`)
      assert.equal(terminal.target_summary, row.target)
      assert.equal(terminal.action_index, row.index)
      assert.equal(terminal.batch_id, 'b1')
    }
    assert.equal(result.metrics.tool_batch_count, 1)
  })

  test('Test 16 — positional projection on same-name tools now fails the validator via correlation drift', () => {
    // The old positional bug is silent here: names, keys, and ids all match, so
    // the pre-fix id+key+tool_name rule could never see the swap. The persisted
    // action_index/target correlation makes the same-name corruption provable.
    const ids = ['call_00_aaa', 'call_01_bbb', 'call_02_ccc']
    const rows: DurableToolLogRow[] = [
      { tool: 'read_file', target: 'CURRENT_STATE.md', index: 0, stdout: 'state' },
      { tool: 'read_file', target: 'README.md', index: 1, stdout: 'readme' },
      { tool: 'read_file', target: 'SIMLIFE_ROADMAP_2026.md', index: 2, stdout: 'roadmap' },
    ]
    const log = createSessionEventLog('same-name-swap')
    proposeAndStart(
      log,
      ids.map((id, index) => ({ id, name: 'read_file', target: rows[index]!.target })),
    )
    // Positional reconstruction swaps the reversed rows' targets onto the wrong ids.
    settleProjected(log, [...rows].reverse(), ids, 'position')
    const result = validateSessionEventLog(log)
    assert.equal(result.status, 'FAIL')
    const drifts = result.findings.filter(
      (finding) => finding.invariant === 'target_summary_drift' || finding.invariant === 'action_index_drift',
    )
    assert.ok(
      drifts.length >= 2,
      `expected correlation drift findings, got ${result.findings.map((f) => f.invariant).join(',')}`,
    )
  })
})

describe('Test 14 — ChatEngine live path with reverse-order parallel reads', () => {
  let projectRoot: string
  let previousRunsDir: string | undefined
  let runsRoot: string

  before(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'babel-lifecycle-live-'))
    mkdirSync(join(projectRoot, 'SimLife', 'scripts'), { recursive: true })
    mkdirSync(join(projectRoot, 'SimLife', 'scenes'), { recursive: true })
    writeFileSync(join(projectRoot, 'SimLife', 'CURRENT_STATE.md'), 'state\n', 'utf-8')
    writeFileSync(join(projectRoot, 'SimLife', 'README.md'), 'readme\n', 'utf-8')
    writeFileSync(join(projectRoot, 'SimLife', 'SIMLIFE_ROADMAP_2026.md'), 'roadmap\n', 'utf-8')
    runsRoot = mkdtempSync(join(tmpdir(), 'babel-lifecycle-runs-'))
    previousRunsDir = process.env['BABEL_RUNS_DIR']
    process.env['BABEL_RUNS_DIR'] = runsRoot
    process.env['BABEL_BENCHMARK_AUTO_APPROVE'] = '1'
  })

  after(async () => {
    if (previousRunsDir === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previousRunsDir
    delete process.env['BABEL_BENCHMARK_AUTO_APPROVE']
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(runsRoot, { recursive: true, force: true })
  })

  test('provider tools persist proposal, dispatch, terminal, and a ChatResult', async () => {
    let call = 0
    const runner = {
      executeWithToolsStream: async function* (
        _messages: unknown,
        _tools: unknown,
        _sys?: string,
        _signal?: AbortSignal,
      ): AsyncGenerator<ToolStreamEvent, void, undefined> {
        call += 1
        if (call === 1) {
          yield {
            type: 'tool_use',
            id: PROVIDER_IDS[0],
            name: 'read_file',
            input: { path: 'SimLife/SIMLIFE_ROADMAP_2026.md' },
          }
          yield {
            type: 'tool_use',
            id: PROVIDER_IDS[1],
            name: 'list_dir',
            input: { path: 'SimLife/scripts' },
          }
          yield {
            type: 'tool_use',
            id: PROVIDER_IDS[2],
            name: 'list_dir',
            input: { path: 'SimLife/scenes' },
          }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text_delta', text: 'SimLife is a mid-stage prototype with a solid roadmap.' }
        yield { type: 'done', finishReason: 'stop' }
      },
      execute: async () => ({ type: 'completion', answer: 'done' }),
      getLastInvocationMetadata: () => null,
    }

    const engine = new ChatEngine({
      task: 'how well do you rate the current simlife game?',
      projectRoot,
      model: 'deepseek-v4-flash',
      maxTurns: 4,
      runId: 'chat-lifecycle-live',
    })
    const anyEngine = engine as unknown as {
      deliberationRunner: unknown
      synthesisRunner: unknown
      shouldUseNativeTools: () => boolean
      executeOneAction: (...args: unknown[]) => Promise<unknown>
    }
    anyEngine.deliberationRunner = runner
    anyEngine.synthesisRunner = runner
    anyEngine.shouldUseNativeTools = () => true

    const original = anyEngine.executeOneAction.bind(engine)
    anyEngine.executeOneAction = async (...args: unknown[]) => {
      const meta = args[3] as { index: number }
      const delay = meta.index === 0 ? 40 : 5
      await new Promise((resolve) => setTimeout(resolve, delay))
      return original(...args)
    }

    const events: ChatEvent[] = []
    for await (const event of engine.submitMessageStream('how well do you rate the current simlife game?')) {
      events.push(event)
    }
    const failed = events.find((event) => event.type === 'failed')
    assert.equal(failed, undefined, failed && failed.type === 'failed' ? failed.error : 'no failure')
    const done = events.find((event) => event.type === 'done')
    assert.ok(done && done.type === 'done')
    assert.match(done.answer ?? '', /SimLife|prototype|roadmap/i)

    const session = engine.getParityRuntime().sessionEvents
    for (const id of PROVIDER_IDS) {
      const cycle = lifecycleOf(session, id)
      assert.ok(cycle.kinds.includes('tool_proposed'), `${id} proposed`)
      assert.ok(cycle.kinds.includes('tool_started'), `${id} started`)
      assert.ok(
        cycle.kinds.includes('tool_completed') || cycle.kinds.includes('tool_failed') || cycle.kinds.includes('tool_cancelled'),
        `${id} terminal kinds=${cycle.kinds.join(',')}`,
      )
      assert.equal(cycle.names.length, 1, `${id} name drift ${cycle.names.join(',')}`)
    }
    const validated = validateSessionEventLog(session)
    assert.equal(validated.status, 'PASS', formatSessionRunValidatorText(validated))

    const thread = engine.getParityEventLog()
    assert.ok(thread.events.some((event) => event.kind === 'assistant_tool_calls'))
    assert.ok(thread.events.some((event) => event.kind === 'tool_result'))
    assert.ok(thread.events.some((event) => event.kind === 'turn_ended'))

    // Execution completed [1,2,0]-ish (index 0 delayed), but the durable
    // assistant_tool_calls record must preserve the provider request order.
    const assistantCallIds = thread.events
      .filter((event) => event.kind === 'assistant_tool_calls')
      .flatMap((event) => event.tool_calls.map((call) => call.id))
    assert.deepEqual(
      assistantCallIds,
      [...PROVIDER_IDS],
      `assistant_tool_calls in request order, got ${assistantCallIds.join(',')}`,
    )

    // The live terminal records persist the correlation the validator relies on.
    const completed = session.events.filter((event) => event.kind === 'tool_completed')
    assert.equal(completed.length, 3)
    const stateRead = completed.find((event) => event.tool_call_id === PROVIDER_IDS[0])
    assert.ok(stateRead)
    assert.equal(stateRead.action_index, 0)
    assert.equal(stateRead.target_summary, 'SimLife/SIMLIFE_ROADMAP_2026.md')
    assert.ok(stateRead.batch_id && stateRead.batch_id.startsWith('batch_'), 'live batch_id persisted')
    assert.equal(new Set(completed.map((event) => event.batch_id)).size, 1, 'one batch for the turn')

    rewriteSessionEventLog(join(runsRoot, 'chat-sessions', 'chat-lifecycle-live'), session)
  })
})
