import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatEngine } from './chatEngine.js'
import { DeepInfraApiRunner } from '../runners/deepInfraApi.js'
import type { ToolStreamEvent } from '../runners/base.js'
import { SafeExecutor } from '../sandbox.js'
import { unsupportedTestClaim } from './chatResponseEvidence.js'

test('test claims distinguish execution, freshness, result and scope', () => {
  const green = { command: 'npm test', exit_code: 0, authority: true, stale: false, scope: 'full_suite', tests_total: 1, tests_skipped: 0 }
  for (const text of ['The baseline test passes.', 'All tests passed.', 'I ran npm test.', 'npm test → exit code 0']) {
    assert.equal(unsupportedTestClaim(text, null), true, text)
    assert.equal(unsupportedTestClaim(text, green), false, text)
  }
  assert.equal(unsupportedTestClaim('I ran npm test; it failed.', { ...green, exit_code: 1 }), false)
  assert.equal(unsupportedTestClaim('I ran npm test successfully.', { ...green, exit_code: 1 }), true)
  assert.equal(unsupportedTestClaim('The baseline test passes.', { ...green, stale: true }), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, scope: 'targeted' }), true)
  assert.equal(unsupportedTestClaim('I ran pytest.', green), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, authority: false }), true)
  assert.equal(unsupportedTestClaim('npm test passed.', { ...green, command: 'npm test -- math.test.js', scope: 'targeted' }), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, tests_total: 0 }), true)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...green, tests_total: 2, tests_skipped: 2 }), true)
  const pytest = { ...green, command: 'pytest' }
  assert.equal(unsupportedTestClaim('npm test passed. I ran pytest.', pytest, [green, pytest]), false)
  assert.equal(unsupportedTestClaim('npm test passed.', { ...green, exit_code: 1 }, [green]), true)
  const typecheck = { command: 'tsc --noEmit', exit_code: 0, authority: true, stale: false, scope: 'full_suite' }
  assert.equal(unsupportedTestClaim('All tests passed.', typecheck, [green, typecheck]), false)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...typecheck, command: 'npm run typecheck' }, [green]), false)
  const fullGreen = { ...green, capturedAt: 3 }
  const oldTargetRed = { ...green, command: 'npm test -- math.test.js', scope: 'targeted', exit_code: 1, capturedAt: 2 }
  const laterPytest = { ...pytest, capturedAt: 4 }
  assert.equal(unsupportedTestClaim('All tests passed.', laterPytest, [fullGreen, oldTargetRed, laterPytest]), false)
  assert.equal(unsupportedTestClaim('All tests passed.', { ...oldTargetRed, capturedAt: 5 }, [fullGreen, laterPytest]), true)
  for (const text of ['Run npm test.', 'Tests should pass.', 'I have not run tests.',
    'If tests pass, continue.', 'Verify that tests pass.', 'I cannot say the tests pass.', 'No tests passed.',
    'The test passes if the value is 5.', 'The test passes when input is empty.',
    'Did the tests pass?', 'Do tests pass?', 'Make sure tests pass.', 'Next, ensure that tests pass.',
    'You can verify that tests pass.',
    'The README says "tests pass".', '> All tests passed.\nThat is a quotation.',
    '```text\nAll tests passed.\n```', '{"flow":"checkout -> subtotal -> tax","taxRate":0.1,"testCommand":"npm test"}'])
    assert.equal(unsupportedTestClaim(text, null), false, text)
})

test('explicit targeted test reports retain their selectors without certifying the whole suite', () => {
  for(const command of ['npm test -- math.test.js','node --test math.test.js','pytest tests/math.py','go test ./math','cargo test addition']) {
    const green={command,exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1,tests_skipped:0}
    assert.equal(unsupportedTestClaim(`I ran \`${command}\`.`,green),false,command)
    assert.equal(unsupportedTestClaim(`\`${command}\` passed.`,green),false,command)
    assert.equal(unsupportedTestClaim(`I ran \`${command}\`; it failed.`,{...green,exit_code:1}),false,command)
    assert.equal(unsupportedTestClaim(`\`${command}\` passed.`,{...green,exit_code:1}),true,command)
    assert.equal(unsupportedTestClaim(`\`${command}\` passed.`,{...green,stale:true}),true,command)
    assert.equal(unsupportedTestClaim('All tests passed.',green),true,command)
  }
  const receipt={command:'npm test -- math.test.js',exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1}
  assert.equal(unsupportedTestClaim('I ran `npm test -- other.test.js`.',receipt),true)
  assert.equal(unsupportedTestClaim('`npm test` passed.',receipt),true)
})

test('bare targeted reports preserve selectors and separate prose success from filename periods', () => {
  for(const command of ['npm test -- math.test.js','node --test math.test.js','pytest tests/math.py','go test ./math','cargo test addition']) {
    const green={command,exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1,tests_skipped:0}
    for(const text of [`I ran ${command}.`,`${command} passed.`,`I ran ${command} and it failed.`])
      assert.equal(unsupportedTestClaim(text,green),false,text)
    for(const text of [`${command} passed.`,`I ran ${command}.`]) {
      assert.equal(unsupportedTestClaim(text,null),true,text)
      assert.equal(unsupportedTestClaim(text,{...green,command:command.replace(/math|addition/g,'different')}),true,text)
    }
    for(const text of [`I ran ${command} successfully.`,`I ran \`${command}\` successfully.`,`${command} passed.`])
      assert.equal(unsupportedTestClaim(text,{...green,exit_code:1}),true,text)
  }
  const command='pytest -k "with tax" tests/passed.test.py';
  const receipt={command,exit_code:0,authority:true,stale:false,scope:'targeted',tests_total:1,tests_skipped:0};
  assert.equal(unsupportedTestClaim(`I ran ${command} and it passed.`,receipt),false);
  assert.equal(unsupportedTestClaim(`I ran ${command} and it passed.`,{...receipt,exit_code:1}),true);
  assert.equal(unsupportedTestClaim('I ran npm test and it failed.',{...receipt,command:'npm test',exit_code:1}),false);
})

for (const scenario of ['correction', 'repeated', 'exact_json'] as const)
test(`response evidence ${scenario}: preserve useful answers without requiring effects`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'chat-response-evidence-'))
  const prior = process.env['BABEL_NATIVE_TOOLS']
  process.env['BABEL_NATIVE_TOOLS'] = 'enabled'
  t.after(() => {
    if (prior === undefined) delete process.env['BABEL_NATIVE_TOOLS']; else process.env['BABEL_NATIVE_TOOLS'] = prior
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(join(root, 'catalog.js'), 'export const orderCatalog = items => [...items]\n')
  let effects = 0
  const forbidden = () => { effects++; throw new Error('No effects are needed to clarify') }
  t.mock.method(SafeExecutor.prototype, 'shellExec', forbidden)
  t.mock.method(SafeExecutor.prototype, 'shellExecAsync', async () => forbidden())
  t.mock.method(SafeExecutor.prototype, 'fileWrite', forbidden)
  const corrected = 'I inspected the implementation; I have not run tests. Which ordering do you want: price, name, or popularity?'
  const unsupported = 'The baseline test passes. Which ordering do you want: price, name, or popularity?'
  const exact = '{"flow":"catalog returns an input copy","testCommand":"npm test"}'
  class Runner extends DeepInfraApiRunner {
    turns = 0
    constructor() { super('fixture-model', 'UNUSED_FIXTURE_KEY', {}, { explicitCredential: '', env: {} }) }
    override async *executeWithToolsStream(): AsyncGenerator<ToolStreamEvent, void, undefined> {
      this.turns++
      if (this.turns === 1) {
        yield { type: 'tool_use', id: 'inspect-catalog', name: 'read_file', input: { path: 'catalog.js' } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text_delta', text: scenario === 'exact_json' ? exact :
          scenario === 'repeated' || this.turns === 2 ? unsupported : corrected }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }
  const runner = new Runner()
  const engine = new ChatEngine({ task: 'Make this better.', projectRoot: root,
    model: 'deepseek-v4-flash', providerRunner: runner, maxTurns: 6 })
  let answer = ''
  let failure: { reason_code?: string; outcome?: string } | undefined
  for await (const event of engine.submitMessageStream('Make this better.', 'execute')) {
    if (event.type === 'done') answer = event.answer
    if (event.type === 'failed') failure = event
  }
  if (scenario === 'repeated') {
    assert.equal(failure?.reason_code, 'response_evidence_invalid')
    assert.equal(failure?.outcome, 'AGENT_FAILURE')
  } else assert.equal(answer, scenario === 'exact_json' ? exact : corrected)
  assert.equal(runner.turns, scenario === 'exact_json' ? 2 : 3)
  assert.equal(effects, 0)
  assert.equal(readFileSync(join(root, 'catalog.js'), 'utf8'), 'export const orderCatalog = items => [...items]\n')
})
