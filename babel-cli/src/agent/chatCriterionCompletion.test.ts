import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChatEngine } from './chatEngine.js'
import type { ExecutorKernel, ExecutorCompletionInput } from '../executor/kernel.js'

test('Chat supplies the current frozen head and private context to the shared kernel', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-criterion-'))
  const previous = process.env['BABEL_RUNS_DIR']
  process.env['BABEL_RUNS_DIR'] = join(root, 'runs')
  try {
    const request = 'Update fixture.\nAcceptance criteria:\n- Preserve fixture output.'
    const engine = new ChatEngine({ model: 'deepseek-v4-flash-openrouter', task: request, projectRoot: root })
    engine.admitUserSubmission({ userInput: request }, { model: 'fixture-model', provider: 'ollama' })
    const box = engine as unknown as {
      executorKernel: ExecutorKernel
      gatePolicy: 'none'
      buildCompletionProof: () => { compliant: boolean }
      decideCompletion: (outcome: 'VERIFIED_COMPLETE', writes: boolean) => ReturnType<ExecutorKernel['completion']['decide']>
    }
    box.gatePolicy = 'none'
    box.buildCompletionProof = () => ({ compliant: true })
    const decide = box.executorKernel.completion.decide
    let captured: ExecutorCompletionInput | undefined
    box.executorKernel.completion.decide = input => { captured = input; return decide(input) }
    const result = box.decideCompletion('VERIFIED_COMPLETE', true)
    assert.ok(captured?.acceptance, 'The production handoff must supply its owned context')
    assert.equal(captured.acceptance.contract, engine.getTaskContract())
    assert.equal(captured.acceptance.run_id, engine.getEngineRunId())
    assert.equal(captured.acceptance.project_root, root)
    assert.equal(result.finalOutcome, 'UNVERIFIED_PATCH')
    assert.equal(result.reason, 'completion_downgraded:verifier_receipt_invalid')
  } finally {
    if (previous === undefined) delete process.env['BABEL_RUNS_DIR']
    else process.env['BABEL_RUNS_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  }
})
