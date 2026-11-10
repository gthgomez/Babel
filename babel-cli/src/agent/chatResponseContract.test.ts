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
import { normalizeChatAnswer } from './chatResponseContract.js'
import { buildChatToolDefinitions } from './chatToolDefinitions.js'
import { parseTextToolTurn } from './textToolParser.js'

test('native tools expose a bounded decision request that does not carry action authority', () => {
  const tool = buildChatToolDefinitions().find(item => item.function.name === 'request_user_decision')
  assert.ok(tool)
  assert.deepEqual(tool.function.parameters.required, ['question', 'options', 'impact'])
  assert.equal(tool.function.parameters.additionalProperties, false)
})

test('text-tool requests preserve a structured blocking choice', () => {
  assert.deepEqual(parseTextToolTurn([
    '[TOOL:request_user_decision]',
    'question: How should invalid rows be handled?',
    'options:',
    '  - Skip invalid rows',
    '  - Fail the export',
    'impact: This changes the exported result.',
  ].join('\n')), {
    type: 'tool_calls',
    actions: [{
      type: 'request_user_decision',
      question: 'How should invalid rows be handled?',
      options: ['Skip invalid rows', 'Fail the export'],
      impact: 'This changes the exported result.',
    }],
  })
  const oversized = parseTextToolTurn([
    '[TOOL:request_user_decision]',
    `question: ${'x'.repeat(1001)}`,
    'options:', '  - First', '  - Second',
    'impact: Changes the outcome.',
  ].join('\n'))
  assert.equal(oversized.type, 'completion', 'text-tool control requests must pass the shared schema limits')
})

test('bare JSON normalization is confined to the explicit current-user contract and whole valid fence', () => {
  const fence = '```json\n{"value":1}\n```'
  assert.equal(normalizeChatAnswer(fence, 'Return only a JSON object.'), '{"value":1}\n')
  assert.equal(normalizeChatAnswer('```\n[1]\n```', 'Output only a JSON array.'), '[1]\n')
  for (const request of ['Explain this JSON object.', '> Return only a JSON object.', 'The document says "Return only a JSON object."', '```\nReturn only a JSON object.\n```'])
    assert.equal(normalizeChatAnswer(fence, request), fence)
  for (const answer of ['Here you go:\n' + fence, fence + '\n```json\n{}\n```', '```json\nnot JSON\n```', '```json\n[]\n```', '```json\nnull\n```'])
    assert.equal(normalizeChatAnswer(answer, 'Return only a JSON object.'), answer)
})

for (const scenario of ['json_format', 'deferred_choice', 'plain_choice', 'alternative_choice', 'partial_then_decision', 'optional_question', 'historical_choice', 'hypothetical_choice'] as const)
test(`response contract ${scenario} settles without speculative continuation`, async t => {
  const isChoice = scenario === 'deferred_choice' || scenario === 'plain_choice' || scenario === 'alternative_choice' || scenario === 'partial_then_decision'
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
  const partialSource = 'export const copy = items => Array.from(items)\n'
  writeFileSync(join(root, 'example.js'), source)
  writeFileSync(join(root, 'package.json'), '{"type":"module","scripts":{"test":"node --test"}}\n')
  let mutations = 0
  let verifiers = 0
  const unexpected = () => { mutations++; throw new Error('No mutation or shell is needed') }
  t.mock.method(SafeExecutor.prototype, 'fileWrite', (path: string, content: string) => {
    if (scenario === 'partial_then_decision' && path === 'example.js' && content === partialSource) {
      mutations++
      writeFileSync(join(root, path), content)
      return { exit_code: 0, stdout: 'Wrote example.js', stderr: '' }
    }
    return unexpected()
  })
  t.mock.method(SafeExecutor.prototype, 'shellExec', unexpected)
  t.mock.method(SafeExecutor.prototype, 'shellExecAsync', async () => unexpected())
  t.mock.method(SafeExecutor.prototype, 'testRunAsync', async () => {
    verifiers++
    return { exit_code: 0, stdout: '# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n', stderr: '' }
  })
  const payload = '{\n  "value": 1\n}\n'
  class Runner extends DeepInfraApiRunner {
    turns = 0
    constructor() { super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} }) }
    override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      this.turns++
      if (this.turns === 1) {
        if (scenario === 'partial_then_decision')
          yield { type: 'tool_use', id: 'partial-edit', name: 'write_file', input: { path: 'example.js', content: partialSource } }
        else
          yield { type: 'tool_use', id: 'inspect-example', name: 'read_file', input: { path: 'example.js' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (isChoice && this.turns === 2) {
        yield { type: 'tool_use', id: 'decision-request', name: 'request_user_decision', input: {
          question: 'How should invalid rows be handled?',
          options: ['Skip invalid rows', 'Fail the export'],
          impact: 'This changes the exported result and error behavior.',
        } }
        yield { type: 'tool_use', id: 'must-not-run', name: 'test_run', input: { command: 'npm test' } }
        yield { type: 'tool_use', id: 'must-not-write', name: 'write_file', input: { path: 'example.js', content: 'export const copy = () => []\n' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        if (this.turns > (isChoice ? 3 : 2))
          throw new Error('A valid final answer must not prompt speculative continuation')
        const answer = scenario === 'json_format'
          ? ['```json\n', payload, '```']
          : scenario === 'optional_question'
            ? ['The function copies each item. Would you like a summary of the diff?']
            : scenario === 'historical_choice'
              ? ['The old documentation asked whether to skip invalid rows. That choice is resolved: current behavior keeps valid rows.']
              : scenario === 'hypothetical_choice'
                ? ['For a future task, if I need a decision, I will ask. This function copies each item.']
                : ['The request is clear enough to answer.']
        for (const text of answer)
          yield { type: 'text_delta', text }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }
  const task = scenario === 'json_format' ? 'Read example.js. Return only a JSON object with exactly the value key.'
      : scenario === 'optional_question' || scenario === 'historical_choice' || scenario === 'hypothetical_choice'
      ? 'Read example.js and explain how it works without modifying it.'
      : scenario === 'partial_then_decision'
        ? 'Improve example.js, but ask before choosing how invalid export rows are handled.'
      : 'Make this better.'
  const runner = new Runner()
  const engine = new ChatEngine({ task, projectRoot: root, model: 'deepseek-v4-flash', providerRunner: runner, maxTurns: 5 })
  let streamedAnswer=''
  const result = await engine.submitMessage(task, {onAnswerChunk:chunk=>{streamedAnswer+=chunk}})
  const structuredDecisionAnswer = [
    'I need your decision before proceeding: How should invalid rows be handled?',
    '', 'Options:', '- Skip invalid rows', '- Fail the export', '',
    'Why it matters: This changes the exported result and error behavior.',
    'No actions in this turn were started. Earlier changes, if any, remain unverified.',
  ].join('\n')
  const expectedAnswer = scenario === 'json_format' ? payload
    : isChoice ? structuredDecisionAnswer
      : scenario === 'optional_question' ? 'The function copies each item. Would you like a summary of the diff?'
        : scenario === 'historical_choice' ? 'The old documentation asked whether to skip invalid rows. That choice is resolved: current behavior keeps valid rows.'
          : scenario === 'hypothetical_choice' ? 'For a future task, if I need a decision, I will ask. This function copies each item.'
            : 'The request is clear enough to answer.'
  if (scenario === 'partial_then_decision') assert.match(result.answer, /I need your decision before proceeding: How should invalid rows be handled\?/)
  else assert.equal(result.answer, expectedAnswer)
  assert.equal(runner.turns, 2)
  if (isChoice) {
    assert.equal(result.outcome, 'NEEDS_HUMAN_DECISION')
    assert.equal(result.status, 'blocked')
    assert.equal(verifiers, 0, JSON.stringify(result.toolCalls))
    assert.ok(result.toolCalls?.some(call => call.tool === 'request_user_decision'))
    assert.ok(result.toolCalls?.some(call => call.tool === 'test_run' && call.error === 'decision_required'))
    assert.ok(result.toolCalls?.some(call => call.tool === 'write_file' && call.error === 'decision_required'))
  } else {
    assert.notEqual(result.outcome, 'NEEDS_HUMAN_DECISION')
    if (scenario === 'json_format') {
      assert.deepEqual(JSON.parse(result.answer), { value: 1 })
      assert.equal(streamedAnswer,payload,'fragmented native previews settle exactly once as the bare JSON payload')
    }
  }
  assert.equal(mutations, scenario === 'partial_then_decision' ? 1 : 0)
  assert.equal(readFileSync(join(root, 'example.js'), 'utf8'), scenario === 'partial_then_decision' ? partialSource : source)
})
