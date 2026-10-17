import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { SafeExecutor } from '../sandbox.js'
import { resetDockerAvailabilityCache, setDockerAvailableForTest } from '../config/benchmarkContainer.js'
import { normalizeChatAnswer, requestsRequiredUserDecision } from './chatResponseContract.js'

test('bare JSON normalization is confined to the explicit current-user contract and whole valid fence', () => {
  const fence = '```json\n{"value":1}\n```'
  assert.equal(normalizeChatAnswer(fence, 'Return only a JSON object.'), '{"value":1}\n')
  assert.equal(normalizeChatAnswer('```\n[1]\n```', 'Output only a JSON array.'), '[1]\n')
  for (const request of ['Explain this JSON object.', '> Return only a JSON object.', 'The document says "Return only a JSON object."', '```\nReturn only a JSON object.\n```'])
    assert.equal(normalizeChatAnswer(fence, request), fence)
  for (const answer of ['Here you go:\n' + fence, fence + '\n```json\n{}\n```', '```json\nnot JSON\n```', '```json\n[]\n```', '```json\nnull\n```'])
    assert.equal(normalizeChatAnswer(answer, 'Return only a JSON object.'), answer)
})

test('mandatory deferral excludes completed answers, examples and hypothetical requests', () => {
  assert.equal(requestsRequiredUserDecision("Before I can implement this, I need your choice.\nWhich direction should I implement?"), true)
  assert.equal(requestsRequiredUserDecision("**Why I'm not editing yet**\nThe product direction is unspecified.\n**What I need from you — one line is enough:**\n\n> Sort by **price / name / popularity**, **ascending / descending**?"), true)
  for (const answer of [
    'I implemented the fix. Would you like more improvements?',
    'The current implementation has two choices. Which do you prefer?',
    '```\nI am not editing yet.\nWhich direction should I implement?\n```',
    'If I need your decision, I will ask.\nWhich direction should I implement?',
    'The document says "I am not editing yet. Which direction should I implement?"',
  ]) assert.equal(requestsRequiredUserDecision(answer), false, answer)
})

for (const scenario of ['json_format', 'deferred_choice'] as const)
test(`response contract ${scenario} settles without speculative continuation`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'chat-response-contract-'))
  const names = ['BABEL_NATIVE_TOOLS', 'BABEL_EXECUTION_PROFILE', 'BABEL_BENCHMARK_DOCKER_IMAGE',
    'BABEL_DOCKER_DISABLE', 'BABEL_ALLOW_HOST_FALLBACK', 'BABEL_BENCHMARK_DOCKER_EXTRA_ARGS'] as const
  const previous = names.map(name => [name, process.env[name]] as const)
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    resetDockerAvailabilityCache()
    rmSync(root, { recursive: true, force: true })
  })
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  process.env['BABEL_EXECUTION_PROFILE'] = 'safe_repo'
  process.env['BABEL_BENCHMARK_DOCKER_IMAGE'] = 'synthetic/response-contract:unit'
  delete process.env['BABEL_DOCKER_DISABLE']
  delete process.env['BABEL_ALLOW_HOST_FALLBACK']
  delete process.env['BABEL_BENCHMARK_DOCKER_EXTRA_ARGS']
  setDockerAvailableForTest(true)
  const source = 'export const copy = items => [...items]\n'
  writeFileSync(join(root, 'example.js'), source)
  writeFileSync(join(root, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n')
  let mutations = 0
  let verifiers = 0
  const unexpected = () => { mutations++; throw new Error('No mutation or shell is needed') }
  t.mock.method(SafeExecutor.prototype, 'fileWrite', unexpected)
  t.mock.method(SafeExecutor.prototype, 'shellExec', unexpected)
  t.mock.method(SafeExecutor.prototype, 'shellExecAsync', async () => unexpected())
  t.mock.method(SafeExecutor.prototype, 'testRunAsync', async () => {
    verifiers++
    return { exit_code: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n', stderr: '' }
  })
  const payload = '{\n  "value": 1\n}\n'
  const clarification = "I'm not editing yet because the requested direction is unspecified. What I need from you:\n\n> Which direction should I implement?"
  class Runner extends DeepInfraApiRunner {
    turns = 0
    constructor() { super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} }) }
    override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      this.turns++
      if (this.turns === 1) {
        yield { type: 'tool_use', id: 'inspect-example', name: 'read_file', input: { path: 'example.js' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (scenario === 'deferred_choice' && this.turns === 2) {
        yield { type: 'tool_use', id: 'baseline-verifier', name: 'test_run', input: { command: 'npm test' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        if (this.turns > (scenario === 'deferred_choice' ? 3 : 2))
          throw new Error('A valid final answer must not prompt speculative continuation')
        yield { type: 'text_delta', text: scenario === 'json_format' ? '```json\n' + payload + '```' : clarification }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }
  const task = scenario === 'json_format' ? 'Read example.js. Return only a JSON object with exactly the value key.' : 'Make this better.'
  const runner = new Runner()
  const engine = new ChatEngine({ task, projectRoot: root, model: 'deepseek-v4-flash', providerRunner: runner, maxTurns: 5 })
  const result = await engine.submitMessage(task, {})
  assert.equal(result.answer, scenario === 'json_format' ? payload : clarification)
  assert.equal(runner.turns, scenario === 'deferred_choice' ? 3 : 2)
  if (scenario === 'deferred_choice') {
    assert.equal(result.outcome, 'NEEDS_HUMAN_DECISION')
    assert.equal(result.status, 'blocked')
    assert.equal(verifiers, 1, JSON.stringify(result.toolCalls))
    assert.equal(result.toolCalls?.find(call => call.tool === 'test_run')?.effect_status, 'indeterminate', JSON.stringify(result.toolCalls))
  } else assert.deepEqual(JSON.parse(result.answer), { value: 1 })
  assert.equal(mutations, 0)
  assert.equal(readFileSync(join(root, 'example.js'), 'utf8'), source)
})
