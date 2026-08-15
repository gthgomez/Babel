import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createSessionEventLog,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordTurnEnded,
  recordUserSubmitted,
  rewriteSessionEventLog,
} from './sessionEvents.js'
import {
  formatSessionRunValidatorText,
  validateSessionEventLog,
  validateSessionRun,
} from './sessionRunValidator.js'

function correlationOf(input: { batchId?: string; actionIndex?: number; target?: string }): Record<string, unknown> {
  return {
    ...(input.batchId !== undefined ? { batch_id: input.batchId } : {}),
    ...(input.actionIndex !== undefined ? { action_index: input.actionIndex } : {}),
    ...(input.target !== undefined ? { target_summary: input.target } : {}),
  }
}

function seedLifecycle(
  log: ReturnType<typeof createSessionEventLog>,
  input: {
    id: string
    name: string
    terminal: 'completed' | 'failed' | 'cancelled' | 'not_started'
    batchId?: string
    actionIndex?: number
    target?: string
  },
): void {
  recordToolProposed(log, {
    turn_id: 't1',
    tool_call_id: input.id,
    tool_name: input.name,
    idempotency_key: input.id,
    ...correlationOf(input),
  })
  if (input.terminal === 'not_started') {
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: input.id,
      tool_name: input.name,
      idempotency_key: input.id,
      cancelled: true,
      recovery_state: 'TOOL_NOT_STARTED',
      ...correlationOf(input),
    })
    return
  }
  recordToolStarted(log, {
    turn_id: 't1',
    tool_call_id: input.id,
    tool_name: input.name,
    idempotency_key: input.id,
    ...correlationOf(input),
  })
  recordToolTerminal(log, {
    turn_id: 't1',
    tool_call_id: input.id,
    tool_name: input.name,
    idempotency_key: input.id,
    ...(input.terminal === 'cancelled'
      ? { cancelled: true, reason: 'operator' }
      : input.terminal === 'failed'
        ? { failed: true, exit_code: 1, content: 'boom' }
        : { exit_code: 0, content: 'ok' }),
    ...correlationOf(input),
  })
}

describe('session run validator', () => {
  test('PASS on a complete proposed-started-completed lifecycle', () => {
    const log = createSessionEventLog('pass-run')
    recordUserSubmitted(log, { turn_id: 't1', task: 'inspect' })
    seedLifecycle(log, { id: 'c1', name: 'read_file', terminal: 'completed' })
    recordTurnEnded(log, { turn_id: 't1', outcome: 'NO_CHANGE_REQUIRED', status: 'completed' })
    const result = validateSessionEventLog(log, '/tmp/pass-run')
    assert.equal(result.status, 'PASS', formatSessionRunValidatorText(result))
    assert.equal(formatSessionRunValidatorText(result), 'PASS')
  })

  test('FAIL on an orphan start and emit machine-readable findings', () => {
    const log = createSessionEventLog('fail-run')
    recordToolProposed(log, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'read_file',
      idempotency_key: 'c1',
    })
    recordToolStarted(log, {
      turn_id: 't1',
      tool_call_id: 'c1',
      tool_name: 'read_file',
      idempotency_key: 'c1',
    })
    const result = validateSessionEventLog(log)
    assert.equal(result.status, 'FAIL')
    assert.ok(result.findings.some((item) => item.invariant === 'orphan_tool_starts'))
    assert.match(formatSessionRunValidatorText(result), /FAIL/)
    assert.match(formatSessionRunValidatorText(result), /orphan_tool_starts/)
  })

  test('FAIL when session-events.jsonl is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-validate-missing-'))
    try {
      const result = validateSessionRun(dir)
      assert.equal(result.status, 'FAIL')
      assert.ok(result.findings.some((item) => item.invariant === 'session_events_present'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('round-trips a persisted valid log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'babel-validate-ok-'))
    try {
      const log = createSessionEventLog('disk-pass')
      recordUserSubmitted(log, { turn_id: 't1', task: 'x' })
      seedLifecycle(log, { id: 'c1', name: 'list_dir', terminal: 'completed' })
      rewriteSessionEventLog(dir, log)
      const result = validateSessionRun(dir)
      assert.equal(result.status, 'PASS', formatSessionRunValidatorText(result))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('validate-run latest resolves through the inspect latest pointer', () => {
    const runsRoot = mkdtempSync(join(tmpdir(), 'babel-validate-latest-'))
    const runDir = join(runsRoot, '20260815_120000_simlife')
    const previous = process.env['BABEL_RUNS_DIR']
    process.env['BABEL_RUNS_DIR'] = runsRoot
    try {
      mkdirSync(runDir, { recursive: true })
      const log = createSessionEventLog('latest-run')
      recordUserSubmitted(log, { turn_id: 't1', task: 'x' })
      seedLifecycle(log, { id: 'c1', name: 'read_file', terminal: 'completed' })
      rewriteSessionEventLog(runDir, log)
      writeFileSync(join(runsRoot, '.latest.json'), JSON.stringify({ run_dir: runDir }), 'utf-8')

      const result = validateSessionRun('latest')
      assert.equal(result.status, 'PASS', formatSessionRunValidatorText(result))
      assert.equal(result.run_dir, runDir)
      assert.equal(result.session_id, 'latest-run')
    } finally {
      if (previous === undefined) delete process.env['BABEL_RUNS_DIR']
      else process.env['BABEL_RUNS_DIR'] = previous
      rmSync(runsRoot, { recursive: true, force: true })
    }
  })

  test('validate-run latest without session events reports the resolved run dir, not a session named latest', () => {
    const runsRoot = mkdtempSync(join(tmpdir(), 'babel-validate-latest-missing-'))
    const runDir = join(runsRoot, '20260815_120000_simlife')
    const previous = process.env['BABEL_RUNS_DIR']
    process.env['BABEL_RUNS_DIR'] = runsRoot
    try {
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runsRoot, '.latest.json'), JSON.stringify({ run_dir: runDir }), 'utf-8')

      const result = validateSessionRun('latest')
      assert.equal(result.status, 'FAIL')
      assert.equal(result.run_dir, runDir)
      const present = result.findings.find((item) => item.invariant === 'session_events_present')
      assert.ok(present, `expected session_events_present finding, got ${result.findings.map((f) => f.invariant).join(',')}`)
      assert.match(present.explanation, /session-events\.jsonl is missing/)
    } finally {
      if (previous === undefined) delete process.env['BABEL_RUNS_DIR']
      else process.env['BABEL_RUNS_DIR'] = previous
      rmSync(runsRoot, { recursive: true, force: true })
    }
  })

  test('tool_batch_count counts persisted batch ids, not timestamp heuristics', () => {
    const log = createSessionEventLog('batch-metric')
    recordUserSubmitted(log, { turn_id: 't1', task: 'x' })
    // Batch b1: two tools in the same turn.
    seedLifecycle(log, { id: 'a1', name: 'read_file', terminal: 'completed', batchId: 'b1', actionIndex: 0, target: 'x' })
    seedLifecycle(log, { id: 'a2', name: 'read_file', terminal: 'completed', batchId: 'b1', actionIndex: 1, target: 'y' })
    // Batch b2: one tool.
    seedLifecycle(log, { id: 'b1', name: 'list_dir', terminal: 'completed', batchId: 'b2', actionIndex: 0, target: 'z' })
    // Legacy row with no batch id — contributes to tool_count but not the metric.
    seedLifecycle(log, { id: 'legacy', name: 'grep', terminal: 'completed' })
    const result = validateSessionEventLog(log)
    assert.equal(result.status, 'PASS', formatSessionRunValidatorText(result))
    assert.equal(result.metrics.tool_count, 4)
    assert.equal(result.metrics.tool_batch_count, 2)
  })
})
