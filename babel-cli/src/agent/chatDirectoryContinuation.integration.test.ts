import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSyntheticProviderFixtureReady, prepareSyntheticProviderFixture, removeSyntheticProviderFixture, summarizeSyntheticProviderOutput } from '../testinfra/synthetic-provider-fixture.mjs'

if (!isSyntheticProviderFixtureReady()) {
  test('native Chat continuation fixture runs without ambient credentials or inference', async t => {
    const fixture = prepareSyntheticProviderFixture(); t.after(() => removeSyntheticProviderFixture(fixture.root))
    const child = spawn(process.execPath, ['--import', new URL('../testinfra/synthetic-provider-fixture.mjs', import.meta.url).href,
      '--import', import.meta.resolve('tsx'), '--test', fileURLToPath(import.meta.url)],
    { cwd: fixture.cwd, env: fixture.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { output += String(chunk) })
    const code = await new Promise<number>(resolve => { child.once('error', () => resolve(1)); child.once('close', value => resolve(value ?? 1)) })
    t.diagnostic(summarizeSyntheticProviderOutput(output, code)); assert.equal(code, 0, 'isolated native Chat continuation must pass')
  })
} else test('native Chat carries a real directory continuation to a second page', async () => {
  const { ChatEngine } = await import('./chatEngine.js')
  const { OpenCodeGoApiRunner } = await import('../runners/openCodeGoApi.js')
  const { babelReviewModelPolicy } = await import('../services/babelChatReview.js')
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-page-')); const source = join(root, 'source'); mkdirSync(source)
  for (let index = 0; index < 250; index++) writeFileSync(join(source, `${String(index).padStart(4, '0')}.txt`), '')
  const environment = { BABEL_EXECUTION_PROFILE: 'read_only_audit', BABEL_READ_ONLY: 'true', BABEL_PROJECT_ROOT: source, BABEL_RUNS_DIR: join(root, 'runs'), BABEL_COMPACTION: 'off', BABEL_MEMORY_WRITEBACK: '0', BABEL_CHAT_TASK_CLASS: 'investigate' }
  const prior = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment)
  const originalFetch = globalThis.fetch; let requests = 0; let continuationSeen = false; let secondResultSeen = false
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++
    let delta: Record<string, unknown>
    if (requests === 1) delta = { tool_calls: [{ index: 0, id: 'page-one', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] }
    else if (requests === 2) {
      const content = body.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'page-one')?.content ?? ''
      const match = String(content).match(/Continuation: (\{[^\n]+\})/)
      if (!match) throw new Error('CONTROL_DIRECTORY_CONTINUATION_MISSING')
      const continuation = JSON.parse(match[1]!) as { after: string; revision: string }; continuationSeen = true
      delta = { tool_calls: [{ index: 0, id: 'page-two', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.', ...continuation }) } }] }
    } else {
      const content = body.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === 'page-two')?.content ?? ''
      secondResultSeen = /0249\.txt/.test(String(content)); delta = { content: 'The directory contains 250 files.' }
    }
    if (requests > 3) throw new Error('CONTROL_UNEXPECTED_REQUEST')
    return new Response(`data: ${JSON.stringify({ model: 'mimo-v2.5', choices: [{ delta, finish_reason: requests < 3 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\ndata: [DONE]\n\n`, { status: 200 })
  }
  try {
    const runner = new OpenCodeGoApiRunner('mimo-v2.5', {}, { credentialSource: 'explicit-test', explicitCredential: 'fixture-only' })
    const engine = new ChatEngine({ task: 'Inspect all filenames.', projectRoot: source, model: 'mimo-v2.5', maxTurns: 4, providerRunner: runner, providerPolicy: babelReviewModelPolicy('mimo-v2.5', source) })
    await engine.submitMessage('Inspect all filenames.', {})
    assert.equal(requests, 3); assert.equal(continuationSeen, true); assert.equal(secondResultSeen, true)
    assert.equal(readdirSync(source).length, 250, 'read-only pagination must not mutate the fixture')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    rmSync(root, { recursive: true, force: true })
  }
})
