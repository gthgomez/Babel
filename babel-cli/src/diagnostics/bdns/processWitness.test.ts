import assert from 'node:assert/strict'
import test from 'node:test'
import { ProcessWitness } from './processWitness.js'

test('records explicit process lifecycle facts with redacted arguments', async () => {
  const witness = new ProcessWitness()
  const observations: string[] = []
  witness.subscribe((observation) => { observations.push(observation.kind) }, { id: 'test' })
  const input = {
    executable: 'node',
    args: ['script.mjs', '--api-key', 'sk-secret-value'],
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    sessionId: 'session-1',
    toolName: 'shell_exec',
  }

  const executionId = witness.requested(input)
  witness.started(input, executionId, 42)
  witness.exited(input, executionId, { exitCode: 1, stderrBytes: 12 })
  await witness.bus.flush()

  const [record] = witness.list()
  assert.ok(record)
  assert.deepEqual(record.payload.args, ['script.mjs', '--api-key', '[REDACTED]'])
  assert.equal(record.payload.cwdClass, 'workspace')
  assert.deepEqual(observations, ['process_requested', 'process_started', 'process_exited'])
  await witness.close()
})

test('keeps process observation independent when the subscriber fails', async () => {
  const witness = new ProcessWitness()
  witness.subscribe(() => { throw new Error('diagnostic consumer failed') }, { id: 'bad' })
  const input = { executable: 'node', args: [], cwd: process.cwd() }
  const id = witness.requested(input)
  witness.failedToStart(input, id, new Error('not found'))
  await witness.bus.flush()
  assert.equal(witness.list()[0]?.status, 'failed_to_start')
  assert.equal(witness.health().evidenceState, 'observer_failed')
  await witness.close()
})
