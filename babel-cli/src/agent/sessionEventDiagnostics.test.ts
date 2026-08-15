import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createSessionEventLog,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
} from './sessionEvents.js'
import {
  SessionEventLifecycleCausalityError,
  captureSessionEventAppendFailure,
  formatOperatorLifecycleFailureMessage,
  persistSessionEventLifecycleDiagnostic,
} from './sessionEventDiagnostics.js'

describe('session event lifecycle diagnostics', () => {
  test('rejected terminal includes matching-by-id history and no tool content', () => {
    const log = createSessionEventLog('diag-1')
    recordToolProposed(log, {
      turn_id: 't1',
      tool_call_id: 'call_00',
      tool_name: 'read_file',
      idempotency_key: 'call_00',
    })
    recordToolStarted(log, {
      turn_id: 't1',
      tool_call_id: 'call_00',
      tool_name: 'read_file',
      idempotency_key: 'call_00',
    })
    let captured: SessionEventLifecycleCausalityError | undefined
    try {
      recordToolTerminal(log, {
        turn_id: 't1',
        tool_call_id: 'call_00',
        tool_name: 'list_dir',
        idempotency_key: 'call_00',
        content: 'SECRET_SHOULD_NOT_APPEAR',
        exit_code: 0,
      })
    } catch (error) {
      assert.ok(error instanceof SessionEventLifecycleCausalityError)
      captured = error
    }
    assert.ok(captured)
    assert.match(captured.message, /terminal tool event requires one prior tool_proposed and tool_started/)
    assert.equal(captured.diagnostic.error_class, 'SESSION_EVENT_LIFECYCLE_CAUSALITY')
    assert.equal(captured.diagnostic.tool_call_id, 'call_00')
    assert.equal(captured.diagnostic.tool_name, 'list_dir')
    assert.equal(captured.diagnostic.matching_full_identity.length, 0)
    assert.equal(captured.diagnostic.matching_by_id.length, 2)
    assert.equal(captured.diagnostic.matching_by_id[0]?.tool_name, 'read_file')
    const serialized = JSON.stringify(captured.diagnostic)
    assert.doesNotMatch(serialized, /SECRET_SHOULD_NOT_APPEAR/)
    assert.match(
      formatOperatorLifecycleFailureMessage(captured.diagnostic),
      /Internal session-state consistency failure/,
    )

    const dir = mkdtempSync(join(tmpdir(), 'babel-lifecycle-diag-'))
    try {
      const path = persistSessionEventLifecycleDiagnostic(dir, captured.diagnostic)
      assert.ok(path)
      const written = readFileSync(path, 'utf-8')
      assert.match(written, /SESSION_EVENT_LIFECYCLE_CAUSALITY/)
      assert.doesNotMatch(written, /SECRET_SHOULD_NOT_APPEAR/)

      const notADir = join(dir, 'not-a-directory')
      writeFileSync(notADir, 'x', 'utf-8')
      const blocked = persistSessionEventLifecycleDiagnostic(notADir, captured.diagnostic)
      assert.equal(blocked, null)
      const capturedAgain = captureSessionEventAppendFailure(captured, notADir)
      assert.ok(capturedAgain)
      assert.match(capturedAgain.operatorMessage, /Internal session-state consistency failure/)
      assert.equal(capturedAgain.diagnosticPath, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
