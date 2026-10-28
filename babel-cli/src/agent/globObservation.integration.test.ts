import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js'
import { babelReviewModelPolicy } from '../services/babelChatReview.js'

for (const entrypoint of ['submitMessage', 'submitMessageStream'] as const) {
  test(`${entrypoint} sends real structured glob results in the next native request`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-glob-wire-'))
    const source = join(root, 'source'); mkdirSync(source)
    writeFileSync(join(source, 'No paths matched..txt'), 'synthetic public fixture')
    writeFileSync(join(source, '数据.txt'), 'synthetic public fixture')
    const environment = { BABEL_EXECUTION_PROFILE: 'read_only_audit', BABEL_READ_ONLY: 'true', BABEL_PROJECT_ROOT: source, BABEL_RUNS_DIR: join(root, 'runs'), BABEL_COMPACTION: 'off', BABEL_MEMORY_WRITEBACK: '0', BABEL_CHAT_TASK_CLASS: 'investigate' }
    const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
    Object.assign(process.env, environment)
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests++
      if (requests === 2) {
        const results = body.messages.filter((message: any) => message.role === 'tool')
        const line = results.find((message: any) => message.tool_call_id === 'glob-actual')?.content.split('\n').find((line: string) => line.startsWith('glob_result: '))
        assert.ok(line, 'CONTROL_GLOB_DATA_MUST_REACH_PROVIDER')
        const data = JSON.parse(line.slice('glob_result: '.length))
        assert.deepEqual(data.paths, ['No paths matched..txt', '数据.txt'])
        assert.equal(data.returned_count, 2)
        assert.equal(data.truncated, false)
      }
      assert.ok(requests <= 2, 'CONTROL_NO_EXTRA_RECOVERY')
      const first = requests === 1
      const delta = first ? { tool_calls: [{ index: 0, id: 'glob-actual', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*' }) } }] } : { content: 'Two matching files were inspected.' }
      return new Response(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`)
    }
    try {
      const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' })
      const engine = new ChatEngine({ task: 'Inspect the matching filenames.', projectRoot: source, model: 'mimo-v2.5', maxTurns: 4, providerRunner: runner, providerPolicy: babelReviewModelPolicy('mimo-v2.5', source) })
      if (entrypoint === 'submitMessage') await engine.submitMessage('Inspect the matching filenames.', {})
      else for await (const _event of engine.submitMessageStream('Inspect the matching filenames.')) { /* consume actual engine path */ }
      assert.equal(requests, 2)
      const durable = engine.getParityEventLog().events.find(event => event.kind === 'tool_result' && event.tool_call_id === 'glob-actual')
      assert.ok(durable?.kind === 'tool_result')
      assert.match(String(durable.content), /glob_result:/)
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      rmSync(root, { recursive: true, force: true })
    }
  })
}
