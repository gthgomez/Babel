import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { OpenCodeGoApiRunner } from '../runners/openCodeGoApi.js'
import { babelReviewModelPolicy } from '../services/babelChatReview.js'

for (const entrypoint of ['submitMessage', 'submitMessageStream'] as const) {
  test(`${entrypoint} sends actual ranged source and bounds errors in the next native HTTP request`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'babel-wire-observations-'))
    const source = join(root, 'source'); mkdirSync(source)
    for (const name of ['alpha', 'beta']) writeFileSync(join(source, `${name}.txt`), Array.from({ length: 650 }, (_, index) => `${name}_seeded_line_${index + 1}`).join('\n'))
    const environment = { BABEL_EXECUTION_PROFILE: 'read_only_audit', BABEL_READ_ONLY: 'true', BABEL_PROJECT_ROOT: source, BABEL_RUNS_DIR: join(root, 'runs'), BABEL_COMPACTION: 'off', BABEL_MEMORY_WRITEBACK: '0', BABEL_CHAT_TASK_CLASS: 'investigate' }
    const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
    Object.assign(process.env, environment)
    const originalFetch = globalThis.fetch
    const requests: Array<{ messages: Array<{ role: string; tool_call_id?: string; content?: string; tool_calls?: Array<{ id: string }> }> }> = []
    const ids = ['native-alpha-range', 'native-beta-range', 'native-bounds-error']
    const actions = [
      { file_path: join(source, 'alpha.txt'), start_line: 545, end_line: 548 },
      { file_path: join(source, 'beta.txt'), start_line: 545, end_line: 548 },
      { file_path: join(source, 'alpha.txt'), start_line: 999, end_line: 1000 },
    ]
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const first = requests.length === 1
      const delta = first ? { tool_calls: actions.map((args, index) => ({ index, id: ids[index], type: 'function', function: { name: 'read_range', arguments: JSON.stringify(args) } })) } : { content: 'Review complete.' }
      return new Response(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`)
    }
    try {
      const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' })
      const engine = new ChatEngine({ task: 'Review the seeded source ranges.', projectRoot: source, model: 'mimo-v2.5', maxTurns: 4, providerRunner: runner, providerPolicy: babelReviewModelPolicy('mimo-v2.5', source) })
      if (entrypoint === 'submitMessage') await engine.submitMessage('Inspect the source ranges.', {})
      else for await (const _event of engine.submitMessageStream('Inspect the source ranges.')) { /* consume real stream */ }
      assert.equal(requests.length, 2)
      const messages = requests[1]!.messages
      const advertisedCalls = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls?.map(call => call.id) ?? [])
      assert.deepEqual(advertisedCalls, ids)
      const results = messages.filter(message => message.role === 'tool')
      assert.equal(results.length, 3)
      for (const [index, name] of ['alpha', 'beta'].entries()) {
        const result = results.find(message => message.tool_call_id === ids[index])
        for (let line = 545; line <= 548; line++) assert.ok(result?.content?.includes(`${name}_seeded_line_${line}`), `${name} line ${line} must reach the provider`)
        assert.ok(!result?.content?.includes(`${name}_seeded_line_544`))
        assert.ok(!result?.content?.includes(`${name}_seeded_line_549`))
        assert.ok(!result?.content?.includes(`${name === 'alpha' ? 'beta' : 'alpha'}_seeded_line_`))
      }
      const error = results.find(message => message.tool_call_id === ids[2])
      assert.match(error?.content ?? '', /start_line \(999\) exceeds file length \(650\)/)
      const durable = engine.getParityEventLog().events.filter(event => event.kind === 'tool_result')
      for (const message of results) assert.equal(durable.find(event => event.tool_call_id === message.tool_call_id)?.content, message.content)
      assert.equal(durable.find(event => event.tool_call_id === ids[2])?.exit_code, 1)
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
  })
}
