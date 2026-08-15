import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

function seedLifecycle(
  log: ReturnType<typeof createSessionEventLog>,
  input: { id: string; name: string; terminal: 'completed' | 'failed' | 'cancelled' | 'not_started' },
): void {
  recordToolProposed(log, {
    turn_id: 't1',
    tool_call_id: input.id,
    tool_name: input.name,
    idempotency_key: input.id,
  })
  if (input.terminal === 'not_started') {
    recordToolTerminal(log, {
      turn_id: 't1',
      tool_call_id: input.id,
      tool_name: input.name,
      idempotency_key: input.id,
      cancelled: true,
      recovery_state: 'TOOL_NOT_STARTED',
    })
    return
  }
  recordToolStarted(log, {
    turn_id: 't1',
    tool_call_id: input.id,
    tool_name: input.name,
    idempotency_key: input.id,
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
})
