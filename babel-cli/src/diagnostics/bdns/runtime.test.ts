import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSessionEventLog, recordModelStarted } from '../../agent/sessionEvents.js'
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
    recordModelStarted(log, { turn_id: 'turn-1', model: 'test' })
    const input = { executable: 'node', args: [], cwd: root, sessionId: 'session-1' }
    const executionId = processWitness.requested(input)
    processWitness.started(input, executionId, 12)
    processWitness.exited(input, executionId, { exitCode: 1 })
    await runtime.close()
    const contents = await readFile(runtime.store.observationsPath, 'utf8')
    assert.match(contents, /canonical_event/)
    assert.match(contents, /process_exited/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
