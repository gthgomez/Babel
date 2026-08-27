import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionEventLog,
  recordToolProposed,
  recordToolStarted,
  recordToolTerminal,
  recordUserSubmitted,
} from '../../agent/sessionEvents.js'
import { ProcessWitness } from './processWitness.js'
import { createBdnsRuntime } from './runtime.js'

test('wires canonical and process evidence into session-owned diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bdns-runtime-'))
  const runDir = join(root, 'run')
  const processWitness = new ProcessWitness()
  try {
    const runtime = createBdnsRuntime({
      runDir,
      sessionId: 'session-1',
      workspaceRoot: root,
      processWitness,
    })
    const log = createSessionEventLog('session-1')
    recordUserSubmitted(log, {
      turn_id: 'turn-1',
      task: 'secret task text that must not persist in BDNS',
    })
    recordToolProposed(log, { turn_id: 'turn-1', tool_call_id: 'tool-1', tool_name: 'shell_exec' })
    recordToolStarted(log, { turn_id: 'turn-1', tool_call_id: 'tool-1', tool_name: 'shell_exec' })
    recordToolTerminal(log, {
      turn_id: 'turn-1',
      tool_call_id: 'tool-1',
      tool_name: 'shell_exec',
      exit_code: 0,
    })
    const input = {
      executable: 'node',
      args: [],
      cwd: root,
      sessionId: 'session-1',
      toolCallId: 'tool-1',
    }
    const executionId = processWitness.requested(input)
    processWitness.started(input, executionId, 12)
    processWitness.exited(input, executionId, { exitCode: 1 })
    await runtime.close()
    const contents = await readFile(runtime.store.observationsPath, 'utf8')
    assert.match(contents, /canonical_event/)
    assert.match(contents, /process_exited/)
    assert.doesNotMatch(contents, /secret task text/)
    const records = contents.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as {
      kind: string
      observerSequence: number
      monotonicTimeMs: number
      payload: { seq?: number; kind?: string; task_preview?: string }
    })
    const canonical = records.find((record) => record.kind === 'canonical_event' && record.payload.kind === 'user_submitted')
    assert.ok(canonical)
    assert.equal(canonical.payload.task_preview, undefined)
    assert.notEqual(canonical.monotonicTimeMs, canonical.payload.seq)
    const summary = JSON.parse(await readFile(runtime.store.summaryPath, 'utf8')) as {
      evidenceCandidates: Array<{ semanticAuthority: string }>
      incidents: number
    }
    assert.ok(summary.evidenceCandidates.length > 0)
    assert.equal(summary.evidenceCandidates.every((candidate) => candidate.semanticAuthority === 'diagnostic_only'), true)
    assert.ok(summary.incidents >= 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
