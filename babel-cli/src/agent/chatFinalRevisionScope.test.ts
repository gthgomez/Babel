import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { ChatEngine } from './chatEngine.js'

type EngineEvent = {
  type: string
  outcome?: string
  status?: string
}

function scriptedRunner() {
  let step = 0
  return {
    async *executeWithToolsStream() {
      if (step++ === 0) {
        yield { type: 'tool_use', id: 'grep-1', name: 'grep', input: { pattern: 'mode', path: 'settings.txt' } }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text_delta', text: 'The settings file contains mode=safe.' }
      yield { type: 'done', finishReason: 'stop' }
    },
    async execute() { return { type: 'completion', answer: 'scripted' } },
    async executeRaw() { return 'scripted' },
    getLastInvocationMetadata() { return null },
  }
}

async function runReadOnlyInspection(ambient: boolean): Promise<{ outcome?: string; status?: string }> {
  const root = mkdtempSync(join(tmpdir(), 'babel-final-revision-scope-'))
  const previous = process.env['BABEL_READ_ONLY']
  if (ambient) process.env['BABEL_READ_ONLY'] = 'true'
  else delete process.env['BABEL_READ_ONLY']
  try {
    const task = 'Inspect settings.txt and summarize it. Do not edit.'
    const engine = new ChatEngine({ model: 'deepseek-v4-flash', task, projectRoot: root, maxTurns: 4 })
    const runner = scriptedRunner()
    const host = engine as unknown as {
      deliberationRunner: typeof runner
      synthesisRunner: typeof runner
      shouldUseNativeTools: () => boolean
    }
    host.deliberationRunner = runner
    host.synthesisRunner = runner
    host.shouldUseNativeTools = () => true
    let done: EngineEvent | undefined
    for await (const event of engine.submitMessageStream(task) as AsyncIterable<EngineEvent>) {
      if (event.type === 'done') done = event
    }
    assert.ok(done, 'engine must publish a done event')
    return { ...(done.outcome !== undefined ? { outcome: done.outcome } : {}), ...(done.status !== undefined ? { status: done.status } : {}) }
  } finally {
    if (previous === undefined) delete process.env['BABEL_READ_ONLY']
    else process.env['BABEL_READ_ONLY'] = previous
    rmSync(root, { recursive: true, force: true })
  }
}

test('project-scoped READ_ONLY with grep-only inspection does not certify no-change', async () => {
  const result = await runReadOnlyInspection(false)
  assert.equal(result.outcome, 'UNVERIFIED_PATCH')
})

test('ambient read-only chat may answer without a project byte witness', async () => {
  const result = await runReadOnlyInspection(true)
  assert.equal(result.outcome, 'NO_CHANGE_REQUIRED')
})
