import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParityRuntime, parityOnUserTurn, parityRecordToolBatch, parityArbitrateCycle } from './chatEngineParityBridge.js'
import { projectDurableToolBatch } from './toolExecutionIdentity.js'

function fixture() {
  const rt = createParityRuntime('discovery-progress')
  parityOnUserTurn(rt, { task: 'Inspect diagnostics', model: 'mock', provider: 'mock', projectRoot: process.cwd() })
  let turn = 0
  return {
    rt,
    observe(tool: string, args: Record<string, unknown>, content: string, exitCode = 0, epoch = 0, detail?: string) {
      turn += 1
      const batch = projectDurableToolBatch({
        turn,
        actions: [{ type: tool, ...args }],
        turnSlice: [{ tool, target: 'same-target', index: 0, exit_code: exitCode, ...(detail ? { detail } : {}) }],
        observationsByActionIndex: [content],
      })
      return parityRecordToolBatch(rt, {
        at_turn: turn, toolCalls: batch.toolCalls, results: batch.results, contextEpoch: epoch,
      })
    },
  }
}

for (const tool of ['read_artifact', 'glob', 'list_dir', 'semantic_search', 'lsp', 'read_file', 'read_range', 'grep']) {
  test(`${tool}: real projection and progress arbitration credit fresh results, bound repeats`, () => {
    const f = fixture()
    for (let i = 0; i < 10; i += 1) {
      const receipt = f.observe(tool, { query: 'failure' }, `fresh diagnostic ${i}`)
      assert.deepEqual(receipt.targetsRead, ['same-target'])
      assert.equal(receipt.hasDelta, true, `novel ${tool} observation ${i}`)
      assert.equal(parityArbitrateCycle({ rt: f.rt, fuseLabels: [] }).terminalAnswer, null)
    }
    for (let i = 0; i < 8; i += 1) {
      assert.equal(f.observe(tool, { query: 'failure' }, 'fresh diagnostic 9').hasDelta, false)
      parityArbitrateCycle({ rt: f.rt, fuseLabels: [] })
    }
    assert.equal(parityArbitrateCycle({ rt: f.rt, fuseLabels: [] }).policySource, 'progress_terminal')
    assert.equal(f.observe(tool, { query: 'failure' }, 'fresh diagnostic 9', 0, 1).hasDelta, true)
  })
}

test('failed, empty and non-discovery observations never buy localization progress', () => {
  const f = fixture()
  for (const tool of ['read_artifact', 'glob', 'list_dir', 'semantic_search', 'lsp', 'read_file', 'read_range', 'grep']) {
    assert.equal(f.observe(tool, {}, `error for ${tool}`, 1).hasDelta, false)
    assert.equal(f.observe(tool, {}, '').hasDelta, false)
  }
  assert.equal(f.observe('await_command', {}, 'still running').hasDelta, false)
})

test('alternating artifact ranges retain separate fingerprints and do not manufacture progress', () => {
  const f = fixture()
  const first = { artifact_id: 'artifact', start_line: 1, end_line: 10 }
  const second = { artifact_id: 'artifact', start_line: 11, end_line: 20 }
  assert.equal(f.observe('read_artifact', first, 'first range').hasDelta, true)
  assert.equal(f.observe('read_artifact', second, 'second range').hasDelta, true)
  assert.equal(f.observe('read_artifact', { end_line: 10, start_line: 1, artifact_id: 'artifact' }, 'first range').hasDelta, false)
  assert.equal(f.observe('read_artifact', second, 'second range').hasDelta, false)
})

test('cached and read-limit notices cannot supply even first-read localization', () => {
  const f = fixture()
  for (const detail of ['cached', 'read_limit']) {
    const receipt = f.observe('read_file', { path: 'source.txt' }, `No source injected (${detail})`, 0, 0, detail)
    assert.equal(receipt.hasDelta, false)
    assert.deepEqual(receipt.targetsRead, [])
  }
})
