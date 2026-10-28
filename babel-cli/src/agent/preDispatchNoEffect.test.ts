import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeActionWithPolicy, resetCircuitBreaker, mapAgentActionToToolCalls } from './toolExecutor.js'
import { assessMutationEffect } from './mutationTools.js'
import { projectDurableToolBatch } from './toolExecutionIdentity.js'
import { toGateToolLog } from '../evidence/chatRevisionBinding.js'

test('policy rejection before executor dispatch carries explicit harmless effect provenance', async () => {
  let executions = 0
  resetCircuitBreaker()
  const result = await executeActionWithPolicy({ type: 'read_file', path: 'ordinary.ts' }, 'workspace_write', {
    agentId: 'agent', runId: 'noeffect-policy', projectRoot: process.cwd(), babelRoot: process.cwd(),
  }, {
    decide: () => 'deny', executor: { mapAction: mapAgentActionToToolCalls, execute: async () => { executions++; return { action: { type: 'read_file', path: 'ordinary.ts' }, terminal: false, results: [] } } },
  })
  assert.equal(executions, 0)
  assert.equal(result.policyBlocked, true)
  assert.equal(result.preDispatchNoEffect, true)
  assert.equal(assessMutationEffect({ tool: 'run_command', error: 'blocked', policyBlocked: true, preDispatchNoEffect: result.preDispatchNoEffect }).status, 'confirmed_no_change')
})

test('durable and gate projections preserve explicit host no-effect facts without inferring absent flags', () => {
  const row = { tool: 'run_command', target: 'node --test', index: 0, error: 'blocked', preDispatchNoEffect: true as const }
  const project = projectDurableToolBatch({ turnSlice: [row], turn: 1 })
  assert.equal(project.results[0]?.preDispatchNoEffect, true)
  assert.equal(toGateToolLog([row])[0]?.preDispatchNoEffect, true)
  assert.equal(projectDurableToolBatch({ turnSlice: [{ tool: row.tool, target: row.target, index: row.index, error: row.error }], turn: 1 }).results[0]?.preDispatchNoEffect, undefined)
})

test('missing physical process start does not prove no effect once the executor callback ran', async () => {
  const { createRunControl, RunStoppedError } = await import('../runtime/run-control.js')
  const control = createRunControl({ runId: 'started-executor', turnId: 'turn', generation: 1 })
  let executorEntered = false
  const result = await executeActionWithPolicy({ type: 'read_file', path: 'ordinary.ts' }, 'workspace_write', {
    agentId: 'agent', runId: 'started-executor', projectRoot: process.cwd(), babelRoot: process.cwd(), runControl: control,
  }, {
    decide: () => 'allow', executor: { mapAction: mapAgentActionToToolCalls, tracksPhysicalDispatch: true, execute: async () => {
      executorEntered = true
      const stop = { owner: control.owner, kind: 'cancelled' as const, reasonCode: 'cancelled', source: 'user' as const }
      control.requestStop(stop)
      throw new RunStoppedError(stop)
    } },
  })
  assert.equal(executorEntered, true)
  assert.equal(result.preDispatchNoEffect, undefined)
})
